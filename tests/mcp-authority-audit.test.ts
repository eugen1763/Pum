import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { McpController } from "../src/mcp";
import { readMcpProposal } from "../src/mcp-config";
import { MCP_PROTOCOL_VERSION, MCP_LIMITS } from "../src/mcp-protocol";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pum-mcp-authority-audit-"));
  mkdirSync(join(cwd, ".pum"));
  const config = JSON.stringify({ version: 1, servers: [{ name: "audit", executable: "/fake/audit", args: [] }] });
  const path = join(cwd, ".pum", "mcp.json");
  writeFileSync(path, config);
  const manager = { getSessionId: () => "same-id", getCwd: () => cwd };
  const session = { sessionId: "same-id", sessionManager: manager, isStreaming: false, subscribe: () => () => {} } as unknown as AgentSession;
  let killed!: () => void;
  const killEvent = new Promise<void>(resolve => { killed = resolve; });
  let calls = 0, hold = false, lateReply: (result: unknown) => void = () => {};
  const controller = new McpController({ cwd, isIdle: () => true, spawn: request => {
    let complete!: () => void;
    return { completed: new Promise<void>(resolve => { complete = resolve; }), close() {}, kill() { killed(); complete(); },
      async write(data) {
        const message = JSON.parse(data);
        const reply = (result: unknown) => request.onStdout(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        if (message.method === "initialize") reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "audit", version: "1" } });
        if (message.method === "tools/list") reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
        if (message.method === "tools/call") { calls++; lateReply = reply; if (!hold) reply({ content: [{ type: "text", text: "result" }] }); }
      } };
  } });
  controller.bind(session);
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }), () => controller.dispose());
  const ctx = { cwd, sessionManager: manager };
  const call = (context: any = ctx) => controller.tools().find(tool => tool.name === "mcp_call")!.execute("call", { server: "audit", tool: "echo", arguments: {} }, undefined, undefined, context);
  const approve = async () => {
    await controller.command("preview");
    const result = await controller.command(`connect audit ${readMcpProposal(cwd).digest}`);
    await controller.command(`approve audit ${/Toolset SHA-256: ([a-f0-9]+)/.exec(result)![1]}`);
  };
  return { cwd, config, path, controller, ctx, call, approve, killEvent, hold: () => { hold = true; }, reply: (result: unknown) => lateReply(result), get calls() { return calls; } };
}
async function observed(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("watcher did not revoke")), 2000); })]); }
  finally { clearTimeout(timer); }
}

test("approved tool rejects a distinct runtime manager even with identical session ID and cwd", async () => {
  const f = fixture(); await f.approve();
  await expect(f.call({ ...f.ctx, sessionManager: { ...f.ctx.sessionManager } })).rejects.toThrow();
  expect(f.calls).toBe(0);
  expect(JSON.stringify(await f.call())).toContain("untrusted server output");
});

test("config watcher revokes without another model tool or status request", async () => {
  const f = fixture(); await f.approve();
  writeFileSync(f.path, f.config + "\n");
  await observed(f.killEvent);
  expect(await f.controller.command("status")).toContain("No MCP");
});

test("atomic directory replacement remains watched after identical-byte replacement", async () => {
  const f = fixture(); await f.approve();
  renameSync(join(f.cwd, ".pum"), join(f.cwd, ".pum-old"));
  mkdirSync(join(f.cwd, ".pum")); writeFileSync(f.path, f.config);
  // Let native watch delivery observe the replacement before changing its new file.
  await new Promise<void>(resolve => setImmediate(resolve));
  writeFileSync(f.path, f.config + "\n");
  await observed(f.killEvent);
  await expect(f.call()).rejects.toThrow(); expect(f.calls).toBe(0);
});

test("identical-byte directory replacement blocks a call synchronously before watcher delivery", async () => {
  const f = fixture(); await f.approve();
  renameSync(join(f.cwd, ".pum"), join(f.cwd, ".pum-old"));
  mkdirSync(join(f.cwd, ".pum")); writeFileSync(f.path, f.config);
  // No event-loop yield: the call boundary itself must detect changed inode identity.
  const result = f.call();
  expect(f.calls).toBe(0);
  await expect(result).rejects.toThrow();
  expect(await f.controller.command("status")).toContain("No MCP");
});

test("direct revoke kills in-flight call and suppresses late server output", async () => {
  const f = fixture(); await f.approve(); f.hold();
  const result = f.call();
  await f.controller.command("revoke audit");
  f.reply({ content: [{ type: "text", text: "LATE SECRET MUST NOT ESCAPE" }] });
  await expect(result).rejects.toThrow("revoked"); expect(await f.controller.command("status")).toContain("No MCP");
});

test("resolved response followed immediately by revocation cannot leak a stale success", async () => {
  const f = fixture(); await f.approve(); f.hold();
  const result = f.call();
  f.reply({ content: [{ type: "text", text: "STALE SECRET" }] });
  f.controller.cancel();
  await expect(result).rejects.toThrow();
});

test("post-response config revalidation rejects stale data before watcher delivery", async () => {
  const f = fixture(); await f.approve(); f.hold();
  const result = f.call();
  f.reply({ content: [{ type: "text", text: "STALE CONFIG RESULT" }] });
  writeFileSync(f.path, f.config + "\n");
  await expect(result).rejects.toThrow("revoked");
  expect(await f.controller.command("status")).toContain("No MCP");
});

test("runtime call results preserve protocol byte/line bounds and inert nontext blocks", async () => {
  const f = fixture(); await f.approve(); f.hold();
  const result = f.call();
  f.reply({ content: [{ type: "resource_link", uri: "file:///secret", name: "hidden-resource" }, { type: "text", text: "🦀".repeat(12000) + "\nline".repeat(500) }] });
  const output = await result; const text = (output.content[0] as { text: string }).text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MCP_LIMITS.resultBytes);
  expect(text.split("\n").length).toBeLessThanOrEqual(MCP_LIMITS.resultLines);
  expect(text).toContain("untrusted server output"); expect(text).toContain("truncated");
  expect(text).not.toContain("file:///secret"); expect(text).not.toContain("hidden-resource");
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { LspController } from "../src/lsp";
import { readLspProposal } from "../src/lsp-files";
import type { McpSpawnRequest } from "../src/mcp-protocol";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pum-lsp-controller-"));
  mkdirSync(join(cwd, ".pum"));
  const config = { version: 1, executable: "/fake/server", args: [] };
  writeFileSync(join(cwd, ".pum", "lsp.json"), JSON.stringify(config));
  writeFileSync(join(cwd, "test.py"), "x = 1\n");
  let listener: (event: any) => void = () => {}, idle = true, current = true;
  const sessionManager = { getSessionId: () => "owner" };
  const session = { sessionId: "owner", sessionManager, isStreaming: false, subscribe(fn: typeof listener) { listener = fn; return () => { listener = () => {}; }; } } as AgentSession;
  let spawns = 0, kills = 0, hold: string | undefined;
  let pending: { message: any; reply(result: unknown): void } | undefined;
  let req: McpSpawnRequest;
  let exit!: () => void;
  const sent: any[] = [];
  const report = { kind: "full", items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "Untrusted warning" }] };
  const frame = (value: unknown) => { const text = JSON.stringify(value); return `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`; };
  const controller = new LspController({ cwd, isIdle: () => idle, isCurrent: () => current, spawn: request => {
    spawns++; req = request;
    return { completed: new Promise<void>(resolve => { exit = resolve; }), close() {}, kill() { kills++; exit(); }, write: async data => {
      const message = JSON.parse(data.slice(data.indexOf("\r\n\r\n") + 4)); sent.push(message);
      const reply = (result: unknown) => request.onStdout(frame({ jsonrpc: "2.0", id: message.id, result }));
      if (hold === message.method) { pending = { message, reply }; return; }
      if (message.method === "initialize") reply({ capabilities: { positionEncoding: "utf-16", textDocumentSync: { openClose: true, change: 1 }, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } });
      else if (message.method === "textDocument/diagnostic") reply(report);
      else if (message.method === "shutdown") reply(null);
      else if (message.method === "exit") exit();
    } };
  } });
  controller.bind(session);
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }), () => controller.dispose());
  const ctx = { cwd, sessionManager };
  const execute = (context: any = ctx, signal?: AbortSignal) => controller.tools()[0]!.execute("call", {}, signal, undefined, context);
  const connect = async () => { await controller.command("preview"); return controller.command(`connect ${readLspProposal(cwd).digest}`); };
  return { cwd, controller, session, ctx, config, execute, connect, sent, report,
    event: (event: any) => listener(event), setIdle: (value: boolean) => { idle = value; }, setCurrent: (value: boolean) => { current = value; },
    hold: (method: string) => { hold = method; }, pending: () => pending!, exit: () => exit(),
    emit: (value: unknown) => req.onStdout(frame(value)),
    emitBatch: (values: unknown[]) => req.onStdout(values.map(frame).join("")), get spawns() { return spawns; }, get kills() { return kills; } };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe("LSP explicit main-TUI runtime authority", () => {
  test("construction, bind, tool reveal, problems and status never start a server", async () => {
    const f = fixture();
    expect(f.controller.tools().map(t => t.name)).toEqual(["lsp_diagnostics"]);
    expect(await f.controller.command("status")).toContain("No LSP");
    expect(JSON.stringify(await f.execute())).toContain("No current");
    await expect(f.controller.command(`connect ${readLspProposal(f.cwd).digest}`)).rejects.toThrow();
    await expect(f.controller.command("check test.py")).rejects.toThrow();
    const preview = await f.controller.command("/lsp");
    expect(preview).toContain("arbitrary secrets"); expect(preview).toContain("no additional roots"); expect(f.spawns).toBe(0);
  });
  test("explicit check returns compact untrusted snapshot; tool reads cache without requests", async () => {
    const f = fixture(); await f.connect();
    expect(await f.controller.command("check test.py")).toContain("1:1 warning");
    const requests = f.sent.length;
    f.event({ type: "tool_execution_start", toolName: "enable_tools" });
    expect(JSON.stringify(await f.execute())).toContain("Untrusted warning");
    expect(f.sent).toHaveLength(requests);
    expect(await f.controller.command("problems")).toContain("Historical");
  });
  for (const form of ["request", "notification"] as const) {
    const refresh = { jsonrpc: "2.0", method: "workspace/diagnostic/refresh", ...(form === "request" ? { id: "refresh-1" } : {}) };
    test(`refresh ${form} withdraws cached empty diagnostics without automatic checking`, async () => {
      const f = fixture(); await f.connect(); f.report.items = [];
      expect(await f.controller.command("check test.py")).toContain("0 problem(s)");
      f.emit(refresh);
      expect(await f.controller.command("problems")).toContain("No current");
      expect(JSON.stringify(await f.execute())).toContain("No current");
      expect(await f.controller.command("status")).toContain("connected; no current");
      expect(f.sent.filter(m => m.method === "textDocument/diagnostic")).toHaveLength(1);
      expect(f.sent.filter(m => m.id === "refresh-1")).toEqual(form === "request"
        ? [{ jsonrpc: "2.0", id: "refresh-1", error: { code: -32601, message: "Method not found" } }] : []);
      expect(f.spawns).toBe(1);
      // Only another explicit user check may establish a new snapshot.
      expect(await f.controller.command("check test.py")).toContain("v2; 0 problem(s)");
      expect(f.sent.filter(m => m.method === "textDocument/diagnostic")).toHaveLength(2);
    });
    test(`refresh ${form} cancels an in-flight pull and ignores late framed results`, async () => {
      const f = fixture(); await f.connect(); f.hold("textDocument/diagnostic");
      const result = f.controller.command("check test.py"); await settle();
      const late = { jsonrpc: "2.0", id: f.pending().message.id, result: f.report };
      f.emitBatch([refresh, late]);
      await expect(result).rejects.toThrow("stale");
      f.pending().reply(f.report);
      expect(await f.controller.command("problems")).toContain("No current");
      expect(JSON.stringify(await f.execute())).toContain("No current");
      expect(await f.controller.command("status")).toContain("No LSP connection or authority");
      expect(f.kills).toBe(1); expect(f.spawns).toBe(1);
      expect(f.sent.filter(m => m.method === "textDocument/diagnostic")).toHaveLength(1);
      await expect(f.controller.command(`connect ${readLspProposal(f.cwd).digest}`)).rejects.toThrow();
    });
    test(`refresh ${form} invalidates an already-resolved pull before controller publication`, async () => {
      const f = fixture(); await f.connect(); f.hold("textDocument/diagnostic");
      const result = f.controller.command("check test.py"); await settle();
      f.emitBatch([{ jsonrpc: "2.0", id: f.pending().message.id, result: f.report }, refresh]);
      await expect(result).rejects.toThrow("stale");
      expect(await f.controller.command("problems")).toContain("No current");
      expect(JSON.stringify(await f.execute())).toContain("No current");
      expect(f.sent.filter(m => m.method === "textDocument/diagnostic")).toHaveLength(1);
      expect(f.spawns).toBe(1);
    });
  }
  test("wrong cwd, replacement session manager, abort and relocated runtime fail closed", async () => {
    const f = fixture(); await f.connect();
    for (const ctx of [{ ...f.ctx, cwd: "/elsewhere" }, { ...f.ctx, sessionManager: { getSessionId: () => "owner" } }]) await expect(f.execute(ctx)).rejects.toThrow();
    await expect(f.execute(f.ctx, AbortSignal.abort())).rejects.toThrow();
    f.setCurrent(false); await expect(f.execute()).rejects.toThrow(); expect(f.kills).toBe(1);
  });
  test("consent/check require idle; stop works while streaming", async () => {
    const f = fixture(); await f.connect(); f.setIdle(false);
    await expect(f.controller.command("preview")).rejects.toThrow("idle");
    await expect(f.controller.command("check test.py")).rejects.toThrow("idle");
    expect(await f.controller.command("stop")).toContain("revoked"); expect(f.kills).toBe(1);
  });
  test("exact config bytes and replacement inode revoke trust before another operation", async () => {
    for (const replacement of [false, true]) {
      const f = fixture(); await f.connect(); const path = join(f.cwd, ".pum", "lsp.json");
      if (replacement) { writeFileSync(path + ".new", JSON.stringify(f.config)); renameSync(path + ".new", path); }
      else writeFileSync(path, JSON.stringify(f.config, null, 2));
      await expect(f.controller.command("status")).rejects.toThrow("changed"); expect(f.kills).toBe(1);
    }
  });
  test("document edits/deletion/identical replacement immediately withdraw on exposure", async () => {
    for (const change of ["edit", "delete", "replace"]) {
      const f = fixture(); await f.connect(); await f.controller.command("check test.py");
      const path = join(f.cwd, "test.py");
      if (change === "edit") writeFileSync(path, "x = 2\n");
      else if (change === "delete") unlinkSync(path);
      else { writeFileSync(path + ".new", "x = 1\n"); renameSync(path + ".new", path); }
      expect(await f.controller.command("problems")).toContain("No current");
      expect(JSON.stringify(await f.execute())).not.toContain("Untrusted warning");
    }
  });
  test("in-flight edited file cannot install late diagnostics", async () => {
    const f = fixture(); await f.connect(); f.hold("textDocument/diagnostic");
    const result = f.controller.command("check test.py"); await settle();
    writeFileSync(join(f.cwd, "test.py"), "changed = 2\n");
    f.pending().reply(f.report);
    await expect(result).rejects.toThrow("stale");
    expect(await f.controller.command("problems")).toContain("No current");
  });
  test("cancel, mutation, agent start, failure and disposal reject a pending result", async () => {
    for (const action of ["stop", "mutation", "start", "failure", "dispose"]) {
      const f = fixture(); await f.connect(); f.hold("textDocument/diagnostic");
      const result = f.controller.command("check test.py"); await settle();
      if (action === "stop") await f.controller.command("stop");
      else if (action === "mutation") f.event({ type: "tool_execution_start", toolName: "edit" });
      else if (action === "start") f.event({ type: "agent_start" });
      else if (action === "failure") f.exit();
      else f.controller.dispose();
      await expect(result).rejects.toThrow();
      f.pending().reply(f.report);
      if (action !== "dispose") expect(await f.controller.command("problems")).toContain("No current");
    }
  });
  test("mutation start and aborted turn withdraw existing evidence without automatic checks", async () => {
    const f = fixture(); await f.connect(); await f.controller.command("check test.py");
    f.event({ type: "tool_execution_start", toolName: "bash" });
    expect(await f.controller.command("problems")).toContain("No current"); expect(f.spawns).toBe(1);
    f.event({ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } });
    expect(await f.controller.command("status")).toContain("No LSP");
  });
  test("new/restored runtime inherits no trust or diagnostics even with same session id", async () => {
    const first = fixture(); await first.connect(); await first.controller.command("check test.py");
    const second = fixture(); expect(await second.controller.command("status")).toContain("No LSP");
    expect(JSON.stringify(await second.execute())).toContain("No current"); expect(second.spawns).toBe(0);
  });
});

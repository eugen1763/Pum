import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionDirectoryName } from "../src/platform";
import { SessionLockOwner } from "../src/session-lock";
import { CONVERSATION_BRANCH_CUSTOM_TYPE } from "../src/conversation-branch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function run(cwd: string, agentDir: string) {
  const child = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../src/index.tsx"), "-r", "-p", "resume branch fixture"], {
    cwd, env: { ...process.env, PUM_DIR: agentDir, PI_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timeout); }
}

test("existing headless resume preserves same-session branch model/effort, ownership and context boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pum-branch-headless-")); roots.push(root);
  const cwd = join(root, "project"); const agentDir = join(root, "agent");
  const store = join(agentDir, "sessions", sessionDirectoryName(cwd));
  mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(store, { recursive: true });
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (!request.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    requests.push(await request.json());
    const chunk = (delta: object, finish_reason: string | null) => ({ id: "mock-branch", object: "chat.completion.chunk", created: 1,
      model: "branch-model", choices: [{ index: 0, delta, finish_reason }] });
    return new Response([chunk({ role: "assistant", content: "Branch resumed." }, null), chunk({}, "stop")]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fixture-only",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: ["default-model", "branch-model"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 32000,
        maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    } } }));
    const globalSettings = JSON.stringify({ defaultProvider: "mock", defaultModel: "default-model", defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false } });
    writeFileSync(join(agentDir, "settings.json"), globalSettings);
    writeFileSync(join(agentDir, "pum.json"), JSON.stringify({ checkMode: "off", sandboxMode: "off", webSearch: false }));
    const manager = SessionManager.create(cwd, store);
    manager.appendMessage({ role: "user", content: "ORIGINAL_PRIVATE_PATH_PROMPT", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ORIGINAL_PATH_ANSWER" }], provider: "mock", model: "branch-model", api: "openai-completions",
      stopReason: "stop", timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const path = manager.getSessionFile()!;
    const originalId = manager.getSessionId();
    manager.resetLeaf();
    manager.appendCustomEntry(CONVERSATION_BRANCH_CUSTOM_TYPE, { version: 1, rollback: false });
    manager.appendModelChange("mock", "branch-model"); manager.appendThinkingLevelChange("high");
    const before = readFileSync(path);
    // A competing headless resume must fail before SDK open or provider dispatch.
    const release = new SessionLockOwner().acquire(path);
    try {
      const blocked = await run(cwd, agentDir);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain("locked");
      expect(requests).toHaveLength(0);
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally { release(); }
    const result = await run(cwd, agentDir);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Branch resumed.");
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("branch-model");
    expect(requests[0].reasoning_effort).toBe("high");
    expect(JSON.stringify(requests[0].messages)).not.toContain("ORIGINAL_PATH_ANSWER");
    expect(JSON.stringify(requests[0].messages)).not.toContain("ORIGINAL_PRIVATE_PATH_PROMPT");
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
    expect(readdirSync(store).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(globalSettings);
    const resumed = SessionManager.open(path, store, cwd);
    expect(resumed.getSessionId()).toBe(originalId);
    const boundary = resumed.appendCustomEntry("pum.context_window", { version: 1, handoff: "LITERAL_HEADLESS_BRANCH_HANDOFF" });
    resumed.appendMessage({ role: "user", content: "UNSELECTED_WINDOW_PROMPT", timestamp: 3 });
    resumed.branch(boundary);
    resumed.appendCustomEntry(CONVERSATION_BRANCH_CUSTOM_TYPE, { version: 1, rollback: false });
    resumed.appendModelChange("mock", "branch-model"); resumed.appendThinkingLevelChange("high");
    const second = await run(cwd, agentDir);
    expect(second.code, second.stderr).toBe(0);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("LITERAL_HEADLESS_BRANCH_HANDOFF");
    expect(JSON.stringify(requests[1].messages)).not.toContain("UNSELECTED_WINDOW_PROMPT");
    expect(JSON.stringify(requests[1].messages)).not.toContain("ORIGINAL_PATH_ANSWER");
    expect(requests[1].model).toBe("branch-model");
    expect(requests[1].reasoning_effort).toBe("high");
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(globalSettings);
    expect(SessionManager.open(path, store, cwd).getSessionId()).toBe(originalId);
  } finally { server.stop(true); }
}, 30_000);

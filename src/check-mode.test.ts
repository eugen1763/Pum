import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BashSafetyCache,
  createCheckModeExtension,
  isBashCacheEligible,
  isRejectedToolResult,
  setCheckModeConfig,
  verifyToolCall,
  type CheckModeConfig,
} from "./check-mode";

const temporaryDirectories: string[] = [];
const config: CheckModeConfig = { enabled: true, model: "test/verifier" };
const model = { provider: "test", id: "verifier" } as any;

function temporaryCache(limit?: number): { cache: BashSafetyCache; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "pum-check-cache-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "cache.json");
  return { cache: new BashSafetyCache(path, limit), path };
}

function result(text: string, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
  } as any;
}

function runtime(replies: Array<ReturnType<typeof result> | Error>) {
  let calls = 0;
  return {
    get calls() { return calls; },
    getAvailableSnapshot: () => [model],
    completeSimple: async () => {
      const reply = replies[calls++] ?? result("SAFE");
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as any;
}

afterEach(() => {
  setCheckModeConfig({ enabled: false, model: "test/verifier" });
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bash safety cache", () => {
  test("uses an exact hit without a second verifier call", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result("SAFE: read-only")]);
    const call = { toolName: "bash" as const, input: { timeout: 10, command: "git status --short" }, cwd: "/repo", config };

    expect(await verifyToolCall(verifier, cache, call)).toBeUndefined();
    expect(await verifyToolCall(verifier, cache, { ...call, input: { command: "git status --short", timeout: 10 } })).toBeUndefined();
    expect(verifier.calls).toBe(1);
  });

  test("misses when cwd, model, or any input field changes", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([]);
    const base = { toolName: "bash" as const, input: { command: "git status", timeout: 10 }, cwd: "/one", config };

    await verifyToolCall(verifier, cache, base);
    await verifyToolCall(verifier, cache, { ...base, cwd: "/two" });
    await verifyToolCall(verifier, cache, { ...base, config: { ...config, model: "test/other" } });
    await verifyToolCall(verifier, cache, { ...base, input: { command: "git status", timeout: 11 } });

    expect(verifier.calls).toBe(3);
    expect((await verifyToolCall(verifier, cache, { ...base, config: { ...config, model: "test/other" } }))?.reason).toContain("unavailable");
  });

  test("does not cache rejected, malformed, failed, or aborted decisions", async () => {
    const replies = [
      result("UNSAFE: no"),
      result("maybe"),
      new Error("offline"),
      result("SAFE", "aborted"),
    ];

    for (const reply of replies) {
      const { cache } = temporaryCache();
      const verifier = runtime([reply, result("SAFE")]);
      const call = { toolName: "bash" as const, input: { command: "git status" }, cwd: "/repo", config };
      expect(await verifyToolCall(verifier, cache, call)).toBeDefined();
      expect(await verifyToolCall(verifier, cache, call)).toBeUndefined();
      expect(verifier.calls).toBe(2);
    }
  });

  test("persists accepted commands and ignores corrupt cache files", async () => {
    const { cache, path } = temporaryCache();
    const call = { toolName: "bash" as const, input: { command: "git diff --check" }, cwd: "/repo", config };
    const first = runtime([result("SAFE")]);
    await verifyToolCall(first, cache, call);

    const restored = runtime([]);
    expect(await verifyToolCall(restored, new BashSafetyCache(path), call)).toBeUndefined();
    expect(restored.calls).toBe(0);

    await Bun.write(path, "not json");
    const afterCorruption = runtime([result("SAFE")]);
    expect(await verifyToolCall(afterCorruption, new BashSafetyCache(path), call)).toBeUndefined();
    expect(afterCorruption.calls).toBe(1);
  });

  test("bounds persisted entries", () => {
    const { cache, path } = temporaryCache(2);
    cache.add(config.model, "/one", { command: "git status" });
    cache.add(config.model, "/two", { command: "git status" });
    cache.add(config.model, "/three", { command: "git status" });

    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.entries).toHaveLength(2);
    expect(new BashSafetyCache(path, 2).has(config.model, "/one", { command: "git status" })).toBe(false);
    expect(new BashSafetyCache(path, 2).has(config.model, "/three", { command: "git status" })).toBe(true);
  });

  test("never bypasses verification for edit calls", async () => {
    const { cache } = temporaryCache();
    cache.add(config.model, "/repo", { path: "a", edits: [] });
    const verifier = runtime([result("SAFE"), result("SAFE")]);
    const call = { toolName: "edit" as const, input: { path: "a", edits: [] }, cwd: "/repo", config };

    await verifyToolCall(verifier, cache, call);
    await verifyToolCall(verifier, cache, call);
    expect(verifier.calls).toBe(2);
  });

  test("only admits simple read-only Git inspection commands", () => {
    expect(isBashCacheEligible({ command: "git status --short" })).toBe(true);
    expect(isBashCacheEligible({ command: "git diff --output=report" })).toBe(false);
    expect(isBashCacheEligible({ command: "git status && rm -rf tmp" })).toBe(false);
    expect(isBashCacheEligible({ command: "bun test" })).toBe(false);
  });

  test("marks blocked tool results for rejected rendering and replay", async () => {
    const handlers = new Map<string, Function>();
    const extension = createCheckModeExtension({
      getAvailableSnapshot: () => [],
      completeSimple: async () => { throw new Error("not called"); },
    }, temporaryCache().cache);
    (extension as { factory: (pi: any) => void }).factory({
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    });
    setCheckModeConfig({ enabled: true, model: "missing/model" });

    const block = await handlers.get("tool_call")?.(
      { toolName: "bash", toolCallId: "call-1", input: { command: "echo test" } },
      { cwd: process.cwd() },
    );
    const patch = await handlers.get("tool_result")?.({
      toolName: "bash",
      toolCallId: "call-1",
      details: {},
    });

    expect(block).toMatchObject({ block: true });
    expect(isRejectedToolResult({ details: patch.details })).toBe(true);
  });
});

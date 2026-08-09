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
  const contexts: any[] = [];
  const options: any[] = [];
  return {
    get calls() { return calls; },
    contexts,
    options,
    getAvailableSnapshot: () => [model],
    completeSimple: async (_model: unknown, context: unknown, requestOptions: unknown) => {
      contexts.push(context);
      options.push(requestOptions);
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

  test("does not cache rejected, unclear, failed, or aborted decisions", async () => {
    const cases = [
      { replies: [result("UNSAFE: no")], callsAfterBlock: 1 },
      { replies: [result("maybe"), result("still maybe")], callsAfterBlock: 2 },
      { replies: [new Error("offline")], callsAfterBlock: 1 },
      { replies: [result("SAFE", "aborted")], callsAfterBlock: 1 },
    ];

    for (const testCase of cases) {
      const { cache } = temporaryCache();
      const verifier = runtime([...testCase.replies, result("SAFE")]);
      const call = { toolName: "bash" as const, input: { command: "git status" }, cwd: "/repo", config };
      expect(await verifyToolCall(verifier, cache, call)).toBeDefined();
      expect(await verifyToolCall(verifier, cache, call)).toBeUndefined();
      expect(verifier.calls).toBe(testCase.callsAfterBlock + 1);
    }
  });

  test("sends complete long composed commands with structured shell stages", async () => {
    const { cache } = temporaryCache();
    const segments = Array.from({ length: 90 }, (_, index) => `printf '${String(index).padStart(3, "0")}${"x".repeat(157)}'`);
    const command = `${segments.slice(0, 30).join(" && ")} ; ${segments.slice(30, 60).join(" | ")} ; ${segments.slice(60).join(" && ")}`;
    expect(command.length).toBeGreaterThan(12_000);
    const verifier = runtime([result("SAFE: bounded development inspection")]);

    expect(await verifyToolCall(verifier, cache, { toolName: "bash", input: { command }, cwd: "/repo", config })).toBeUndefined();
    expect(verifier.calls).toBe(1);
    const prompt = verifier.contexts[0].messages[0].content as string;
    expect(prompt).toContain(command);
    expect(prompt).toContain('"operator": "&&"');
    expect(prompt).toContain('"operator": ";"');
    expect(prompt).toContain('"operator": "|"');
    expect(prompt).toContain('"stages"');
    expect(prompt).toContain('"cwd": "/repo"');
  });

  test("annotates command substitutions, redirections, and mutation intent", async () => {
    const { cache } = temporaryCache();
    const command = "printf '%s' \"$(git rev-parse HEAD)\" | tee report.txt 2>>errors.log; echo \"`git status --short`\"";
    const verifier = runtime([result("SAFE")]);

    expect(await verifyToolCall(verifier, cache, { toolName: "bash", input: { command }, cwd: "/repo", config })).toBeUndefined();
    const prompt = verifier.contexts[0].messages[0].content as string;
    expect(prompt).toContain('"kind": "dollar-paren"');
    expect(prompt).toContain('"kind": "backtick"');
    expect(prompt).toContain('"operator": "2>>"');
    expect(prompt).toContain("output redirection can write files");
    expect(prompt).toContain("filesystem write command");
  });

  test("preserves dangerous segments hidden late in a long command", async () => {
    const { cache } = temporaryCache();
    const lateSegment = "rm -rf /tmp/important-build-state";
    const command = `${Array.from({ length: 100 }, (_, index) => `printf '%0140d' ${index}`).join(" && ")} && ${lateSegment}`;
    const verifier = runtime([result("UNSAFE: destructive late stage")]);

    const block = await verifyToolCall(verifier, cache, { toolName: "bash", input: { command }, cwd: "/repo", config });
    expect(block?.reason).toContain("UNSAFE");
    expect(verifier.calls).toBe(1);
    expect(verifier.contexts[0].messages[0].content).toContain(lateSegment);
  });

  test("blocks oversized input instead of sending a truncated verifier request", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result("SAFE")]);
    const command = `${"echo safe && ".repeat(12_000)}rm -rf /late-danger`;

    const block = await verifyToolCall(verifier, cache, { toolName: "bash", input: { command }, cwd: "/repo", config });
    expect(block?.reason).toMatch(/too (?:large|complex)/);
    expect(block?.reason).toMatch(/complete|truncated/);
    expect(verifier.calls).toBe(0);
  });

  test("does not retry an explicit UNSAFE decision", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result("UNSAFE: destructive"), result("SAFE")]);

    const block = await verifyToolCall(verifier, cache, {
      toolName: "bash",
      input: { command: "rm -rf build" },
      cwd: "/repo",
      config,
    });
    expect(block?.reason).toContain("UNSAFE");
    expect(verifier.calls).toBe(1);
  });

  test("permits one clarification for an unclear first response", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result("This looks ordinary."), result("SAFE: adjudicated")]);

    expect(await verifyToolCall(verifier, cache, {
      toolName: "bash",
      input: { command: "bun test src/check-mode.test.ts" },
      cwd: "/repo",
      config,
    })).toBeUndefined();
    expect(verifier.calls).toBe(2);
    expect(verifier.contexts[1].messages[0].content).toContain("Adjudication request");
    expect(verifier.options[1].timeoutMs).toBeLessThanOrEqual(verifier.options[0].timeoutMs);
  });

  test("uses one shared watchdog across the first response and clarification", async () => {
    const { cache } = temporaryCache();
    let calls = 0;
    let secondSignal: AbortSignal | undefined;
    const verifier = {
      getAvailableSnapshot: () => [model],
      completeSimple: async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        calls++;
        if (calls === 1) {
          await Bun.sleep(15);
          return result("unclear");
        }
        secondSignal = options.signal;
        return await new Promise<never>(() => {});
      },
    } as any;

    const started = Date.now();
    const block = await verifyToolCall(verifier, cache, {
      toolName: "bash",
      input: { command: "bun test" },
      cwd: "/repo",
      config,
      timeoutMs: 30,
    });

    expect(block?.reason).toContain("timeout");
    expect(calls).toBe(2);
    expect(secondSignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(150);
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

  test("hard-aborts a verifier that ignores its request timeout", async () => {
    const { cache } = temporaryCache();
    let verifierSignal: AbortSignal | undefined;
    const verifier = {
      getAvailableSnapshot: () => [model],
      completeSimple: async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        verifierSignal = options.signal;
        return await new Promise<never>(() => {});
      },
    } as any;

    const started = Date.now();
    const block = await verifyToolCall(verifier, cache, {
      toolName: "bash",
      input: { command: "find src -type f" },
      cwd: "/repo",
      config,
      timeoutMs: 20,
    });

    expect(block?.reason).toContain("Safety check timed out after 20ms");
    expect(verifierSignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("never bypasses verification for file mutation calls", async () => {
    const { cache } = temporaryCache();
    cache.add(config.model, "/repo", { path: "a", edits: [] });
    cache.add(config.model, "/repo", { patch: "*** Begin Patch\n*** End Patch" });
    const verifier = runtime([result("SAFE"), result("SAFE"), result("SAFE"), result("SAFE")]);
    const editCall = { toolName: "edit" as const, input: { path: "a", edits: [] }, cwd: "/repo", config };
    const patchCall = {
      toolName: "apply_patch" as const,
      input: { patch: "*** Begin Patch\n*** End Patch" },
      cwd: "/repo",
      config,
    };

    await verifyToolCall(verifier, cache, editCall);
    await verifyToolCall(verifier, cache, editCall);
    await verifyToolCall(verifier, cache, patchCall);
    await verifyToolCall(verifier, cache, patchCall);
    expect(verifier.calls).toBe(4);
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

    const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("Do not put bash, edit, or apply_patch in the same parallel tool batch");
    expect(prompt.systemPrompt).toContain("Do not retry it in a loop");

    for (const [toolName, input] of [
      ["bash", { command: "echo test" }],
      ["apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
    ] as const) {
      const id = `call-${toolName}`;
      const block = await handlers.get("tool_call")?.(
        { toolName, toolCallId: id, input },
        { cwd: process.cwd() },
      );
      const patch = await handlers.get("tool_result")?.({
        toolName,
        toolCallId: id,
        details: {},
      });

      expect(block).toMatchObject({ block: true });
      expect(isRejectedToolResult({ details: patch.details })).toBe(true);
    }
  });
});

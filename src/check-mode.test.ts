import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BashSafetyCache,
  createCheckModeExtension,
  evaluateToolCall,
  isBashCacheEligible,
  isRejectedToolResult,
  redactApprovalPreview,
  safetyDecision,
  setCheckModeConfig,
  verifyToolCall,
  type CheckModeConfig,
} from "./check-mode";
import { CheckApprovalCoordinator, CheckApprovalStore } from "./check-approvals";

const temporaryDirectories: string[] = [];
const config: CheckModeConfig = { profile: "strict", model: "test/verifier" };
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
    expect(prompt).toContain('"kind": "command"');
    expect(prompt).toContain('"kind": "backtick"');
    expect(prompt).toContain('"operator": "2>>"');
    expect(prompt).toContain("output redirection");
    expect(prompt).toContain("file output");
  });

  test("preserves dangerous segments hidden late in a long command", async () => {
    const { cache } = temporaryCache();
    const lateSegment = "rm -rf /tmp/important-build-state";
    const command = `${Array.from({ length: 100 }, (_, index) => `printf '%0140d' ${index}`).join(" && ")} && ${lateSegment}`;
    const verifier = runtime([result("UNSAFE: destructive late stage")]);

    const block = await verifyToolCall(verifier, cache, { toolName: "bash", input: { command }, cwd: "/repo", config });
    expect(block?.reason).toContain("hard block");
    expect(block?.reason).toContain("outside the project");
    expect(verifier.calls).toBe(0);
  });

  test("blocks oversized input instead of sending a truncated verifier request", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result("SAFE")]);
    const command = `${"echo safe && ".repeat(12_000)}rm -rf /late-danger`;

    const block = await verifyToolCall(verifier, cache, { toolName: "bash", input: { command }, cwd: "/repo", config });
    expect(block?.reason).toMatch(/incomplete|exceeds/);
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

  test("never bypasses verification for valid file mutation calls in strict mode", async () => {
    const { cache } = temporaryCache();
    const cwd = mkdtempSync(join(tmpdir(), "pum-check-mutation-"));
    temporaryDirectories.push(cwd);
    await Bun.write(join(cwd, "a.txt"), "old\n");
    const verifier = runtime([result("SAFE"), result("SAFE"), result("SAFE"), result("SAFE")]);
    const editCall = { toolName: "edit" as const, input: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] }, cwd, config };
    const patchCall = {
      toolName: "apply_patch" as const,
      input: { patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" },
      cwd,
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
    expect(prompt.systemPrompt).toContain("Do not put a checked tool in the same parallel tool batch");
    expect(prompt.systemPrompt).toContain("Do not retry a blocked or timed-out tool in a loop");

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

describe("profile evaluation and structured verdicts", () => {
  test("parses the structured schema and legacy verdicts", () => {
    expect(safetyDecision('{"decision":"safe","category":"build","confidence":0.92,"reason":"local test"}')).toMatchObject({
      decision: "safe", category: "build", confidence: 0.92,
    });
    expect(safetyDecision("UNSAFE: destructive")).toMatchObject({ decision: "unsafe", legacy: true });
    expect(safetyDecision('{"decision":"safe","reason":"missing fields"}').decision).toBe("unclear");
  });

  test("balanced permits narrow deterministic operations and verifies ordinary builds", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result('{"decision":"safe","category":"test","confidence":0.9,"reason":"local test command"}')]);
    const balanced = { profile: "balanced" as const, model: config.model };
    expect((await evaluateToolCall(verifier, cache, {
      toolName: "bash", input: { command: "git status --short" }, cwd: process.cwd(), config: balanced,
    })).decision).toBe("allow");
    expect(verifier.calls).toBe(0);
    expect((await evaluateToolCall(verifier, cache, {
      toolName: "bash", input: { command: "bun test src/check-mode.test.ts" }, cwd: process.cwd(), config: balanced,
    })).decision).toBe("allow");
    expect(verifier.calls).toBe(1);
  });

  test("balanced permits an ordinary source edit but verifies config-sensitive changes", async () => {
    const { cache } = temporaryCache();
    const cwd = mkdtempSync(join(tmpdir(), "pum-balanced-edit-"));
    temporaryDirectories.push(cwd);
    await Bun.write(join(cwd, "source.ts"), "const value = 1;\n");
    await Bun.write(join(cwd, "package.json"), "{\"name\":\"old\"}\n");
    const verifier = runtime([result('{"decision":"safe","category":"config","confidence":0.8,"reason":"bounded config edit"}')]);
    const balanced = { profile: "balanced" as const, model: config.model };
    expect((await evaluateToolCall(verifier, cache, {
      toolName: "edit", input: { path: "source.ts", edits: [{ oldText: "1", newText: "2" }] }, cwd, config: balanced,
    })).decision).toBe("allow");
    expect(verifier.calls).toBe(0);
    expect((await evaluateToolCall(verifier, cache, {
      toolName: "edit", input: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] }, cwd, config: balanced,
    })).decision).toBe("allow");
    expect(verifier.calls).toBe(1);
    const prompt = verifier.contexts[0].messages[0].content as string;
    expect(prompt).toContain('"unifiedDiff"');
    expect(prompt).toContain('"configSensitive": true');
    expect(prompt).toContain('"projectContained": true');
  });

  test("explicit structured UNSAFE is blocked and never reaches ask UI", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result('{"decision":"unsafe","category":"destructive","confidence":1,"reason":"deletes state"}')]);
    const evaluation = await evaluateToolCall(verifier, cache, {
      toolName: "bash", input: { command: "bun run unknown-script" }, cwd: process.cwd(),
      config: { profile: "ask", model: config.model },
    });
    expect(evaluation).toMatchObject({ decision: "block", explicitUnsafe: true, category: "destructive" });
    expect(verifier.calls).toBe(1);
  });

  test("includes bounded task context and inspected paths as untrusted data", async () => {
    const { cache } = temporaryCache();
    const verifier = runtime([result("SAFE")]);
    await evaluateToolCall(verifier, cache, {
      toolName: "bash", input: { command: "bun test" }, cwd: process.cwd(), config,
      context: {
        currentUserRequest: "Run the focused tests",
        agentRationale: "Validate the change",
        inspectedPaths: ["src/check-mode.ts"],
      },
    });
    const prompt = verifier.contexts[0].messages[0].content as string;
    expect(prompt).toContain("UNTRUSTED TASK CONTEXT");
    expect(prompt).toContain("Run the focused tests");
    expect(prompt).toContain("src/check-mode.ts");
  });

  test("hard-blocks mutation persistence paths and broad patch deletion", async () => {
    const { cache } = temporaryCache();
    const cwd = mkdtempSync(join(tmpdir(), "pum-hard-mutation-"));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    await Bun.write(join(cwd, ".git", "hooks", "pre-commit"), "old\n");
    const verifier = runtime([]);
    const persistence = await evaluateToolCall(verifier, cache, {
      toolName: "edit",
      input: { path: ".git/hooks/pre-commit", edits: [{ oldText: "old", newText: "new" }] },
      cwd,
      config,
    });
    expect(persistence).toMatchObject({ decision: "block", category: "hard-block" });
    expect(persistence.reason).toContain("persistence");

    for (const name of ["a", "b", "c", "d"]) await Bun.write(join(cwd, name), `${name}\n`);
    const patch = `*** Begin Patch\n${["a", "b", "c", "d"].map((name) => `*** Delete File: ${name}`).join("\n")}\n*** End Patch`;
    const broad = await evaluateToolCall(verifier, cache, {
      toolName: "apply_patch", input: { patch }, cwd, config,
    });
    expect(broad).toMatchObject({ decision: "block", category: "hard-block" });
    expect(broad.reason).toContain("broad deletion");
    expect(verifier.calls).toBe(0);
  });

  test("redacts secrets from approval previews", () => {
    const redacted = redactApprovalPreview("API_TOKEN=hunter2 const password = 'quoted-secret'; curl --password secret https://user:pass@example.test Authorization: Bearer abc");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("quoted-secret");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("Bearer abc");
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("ask profile approvals", () => {
  test("allows an exact call for the session without broad matching", async () => {
    const { cache } = temporaryCache();
    const directory = mkdtempSync(join(tmpdir(), "pum-ask-"));
    temporaryDirectories.push(directory);
    const coordinator = new CheckApprovalCoordinator();
    const approvalPath = join(directory, "approvals.json");
    const approvals = new CheckApprovalStore(approvalPath);
    let pendingId: string | undefined;
    const unsubscribe = coordinator.subscribe((request) => { pendingId = request?.id; });
    const handlers = new Map<string, Function>();
    const verifier = runtime([result("malformed"), result("still malformed"), result("malformed"), result("still malformed")]);
    const extension = createCheckModeExtension(verifier, cache, { coordinator, approvals });
    (extension as any).factory({ on: (name: string, handler: Function) => handlers.set(name, handler) });
    setCheckModeConfig({ profile: "ask", model: config.model });
    const event = { toolName: "bash", toolCallId: "one", input: { command: "bun test" } };
    const ctx = { cwd: directory, sessionManager: { buildContextEntries: () => [] } };
    const first = handlers.get("tool_call")!(event, ctx);
    await Bun.sleep(0);
    expect(pendingId).toBeDefined();
    coordinator.resolve(pendingId!, "allow-session");
    expect(await first).toBeUndefined();
    expect(verifier.calls).toBe(2);

    expect(await handlers.get("tool_call")!({ ...event, toolCallId: "two" }, ctx)).toBeUndefined();
    expect(verifier.calls).toBe(2);
    const changedPending = handlers.get("tool_call")!({ ...event, toolCallId: "three", input: { command: "bun test --watch" } }, ctx);
    await Bun.sleep(0);
    coordinator.resolve(pendingId!, "deny");
    const changed = await changedPending;
    expect(changed).toMatchObject({ block: true });
    expect(verifier.calls).toBe(4);
    unsubscribe();
  });

  test("persists only the exact approved call for later project sessions", async () => {
    const { cache } = temporaryCache();
    const directory = mkdtempSync(join(tmpdir(), "pum-project-approval-"));
    temporaryDirectories.push(directory);
    const coordinator = new CheckApprovalCoordinator();
    const approvals = new CheckApprovalStore(join(directory, "approvals.json"));
    let pendingId: string | undefined;
    const unsubscribe = coordinator.subscribe((request) => { pendingId = request?.id; });
    const verifier = runtime([result("malformed"), result("still malformed")]);
    const extension = createCheckModeExtension(verifier, cache, { coordinator, approvals });
    const handlers = new Map<string, Function>();
    (extension as any).factory({ on: (name: string, handler: Function) => handlers.set(name, handler) });
    setCheckModeConfig({ profile: "ask", model: config.model });
    const ctx = { cwd: directory, sessionManager: { buildContextEntries: () => [] } };
    const event = { toolName: "bash", toolCallId: "first", input: { command: "bun test" } };
    const first = handlers.get("tool_call")!(event, ctx);
    await Bun.sleep(0);
    coordinator.resolve(pendingId!, "allow-project");
    expect(await first).toBeUndefined();
    expect(verifier.calls).toBe(2);

    const restoredHandlers = new Map<string, Function>();
    (extension as any).factory({ on: (name: string, handler: Function) => restoredHandlers.set(name, handler) });
    expect(await restoredHandlers.get("tool_call")!({ ...event, toolCallId: "restored" }, ctx)).toBeUndefined();
    expect(verifier.calls).toBe(2);
    unsubscribe();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionServices, createBashTool,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type BashOperations, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model, type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ProjectValidationController, validationForSession } from "../src/project-validation";
import { ContextWindowController, CONTEXT_TOOL_NAMES } from "../src/context-window";
import { createCheckModeExtension, getCheckModeConfig, setCheckModeConfig } from "../src/check-mode";
import { SandboxController } from "../src/sandbox";

// Real installed SDK event dispatch, tool preflight/result middleware, native file
// tools, model-loop ordering, queues and persistence. Only transport/auth and the
// registered Bash backend are replaced: no paid model, shell process or UI.
const MODEL: Model<"openai-completions"> = {
  id: "validation-script", name: "validation-script", provider: "pum-validation-sdk-fixture",
  api: "openai-completions", baseUrl: "https://unused.invalid", reasoning: false,
  input: ["text"], contextWindow: 32_000, maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Reply = AssistantMessage["content"] | "retry-error";
type Command = { kind: "format" | "lint" | "typecheck" | "test"; command: string; timeoutSeconds: number };
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { await session.abort(); session.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const text = (value = "Done."): AssistantMessage["content"] => [{ type: "text", text: value }];
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ type: "toolCall", id, name, arguments: args });
const write = (id = "write-one", path = "source.txt", content = "new\n") => call(id, "write", { path, content });
const command = (value = "fixture-test"): Command => ({ kind: "test", command: value, timeoutSeconds: 1 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function evidence(manager: SessionManager) {
  return manager.getEntries().filter((entry) => entry.type === "custom_message" && /validation/i.test(entry.customType));
}
function evidenceText(manager: SessionManager): string {
  return evidence(manager).map((entry) => JSON.stringify(entry)).join("\n");
}
function result(manager: SessionManager, id: string) {
  return manager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolCallId === id ? [entry.message] : [])[0];
}
async function fixture(options: { commands?: Command[]; maxRuns?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pum-validation-sdk-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "isolated-agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(join(cwd, ".pum"), { recursive: true }); mkdirSync(agentDir);
  const configPath = join(cwd, ".pum", "validation.json");
  const bytes = JSON.stringify({ version: 1, commands: options.commands ?? [command()], maxRuns: options.maxRuns ?? 5 });
  writeFileSync(configPath, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === MODEL.provider;

  async function open(options: {
    readonly?: boolean; bind?: boolean; sessionFile?: string; retry?: boolean;
    contextOrder?: "validation-first" | "context-first";
    beforeBind?: (session: AgentSession) => void;
    execute?: BashOperations["exec"]; extensions?: InlineExtension[]; nativeBash?: boolean;
  } = {}) {
    const controller = new ProjectValidationController({ cwd, readonly: options.readonly });
    const contextWindow = options.contextOrder ? new ContextWindowController() : undefined;
    const executed: Array<{ command: string; cwd: string; signal?: AbortSignal; timeout?: number }> = [];
    const lifecycle: string[] = [];
    const checks: Array<Record<string, unknown>> = [];
    const postflight: string[] = [];
    const uiStates: boolean[] = [];
    const bash = createBashTool(cwd, { exposeSessionEnvironment: false, operations: { async exec(command, cwd, opts) {
      executed.push({ command, cwd, signal: opts.signal, timeout: opts.timeout });
      lifecycle.push(`execute:${command}`);
      if (options.execute) return options.execute(command, cwd, opts);
      opts.onData(Buffer.from(`VALIDATION_OUTPUT:${command}\n`));
      return { exitCode: 0 };
    } } });
    const probe: InlineExtension = { name: "validation-sdk-probe", factory(pi) {
      if (!options.nativeBash) pi.registerTool({ ...bash, label: "Bash" });
      pi.registerTool({ name: "finish_subagent", label: "Finish fixture", description: "Record fixture completion.",
        parameters: Type.Object({}), async execute() {
          lifecycle.push("finish-execute");
          return { content: [{ type: "text", text: "FINISH_EXECUTED" }], details: {} };
        } });
      pi.on("tool_call", (event, ctx) => {
        uiStates.push(ctx.hasUI);
        if (event.toolName === "bash") { checks.push(structuredClone(event.input)); lifecycle.push(`check:${event.input.command}`); }
      });
      pi.on("tool_result", (event) => {
        lifecycle.push(`result:${event.toolName}`);
        if (event.toolName === "bash") postflight.push(JSON.stringify(event.content));
      });
      pi.on("agent_end", () => { lifecycle.push("agent-end"); });
      pi.on("agent_settled", () => { lifecycle.push("settled"); });
    } };
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false },
        retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [controller.extension(), ...(contextWindow ? [contextWindow.extension()] : []),
          probe, ...(options.extensions ?? [])] },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    const manager = options.sessionFile ? SessionManager.open(options.sessionFile, sessionDir) : SessionManager.create(cwd, sessionDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
      model: MODEL, thinkingLevel: "off", tools: ["write", "edit", "read", "bash", "finish_subagent",
        ...(contextWindow ? CONTEXT_TOOL_NAMES : [])] });
    sessions.push(session);
    options.beforeBind?.(session);
    if (options.contextOrder === "context-first") contextWindow!.bind(session);
    if (options.bind !== false) controller.bind(session);
    if (options.contextOrder === "validation-first") contextWindow!.bind(session);
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => { errors.push(error); } });
    // User Bash bypasses tool preflight. Any regression to that path fails.
    session.executeBash = async () => { throw new Error("FORBIDDEN_USER_BASH_PATH"); };
    const requests: Context["messages"][] = [];
    const requestModels: string[] = [];
    const replies: Reply[] = [];
    session.agent.streamFunction = (model, context) => {
      requestModels.push(model.id);
      requests.push(structuredClone(context.messages)); lifecycle.push("model-request");
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected model request: fixture script exhausted");
      const stopReason = reply === "retry-error" ? "error" : reply.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", content: reply === "retry-error" ? [] : reply,
        provider: MODEL.provider, model: MODEL.id, api: MODEL.api, timestamp: Date.now(), stopReason,
        ...(reply === "retry-error" ? { errorMessage: "503 service unavailable" } : {}),
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: stopReason, message });
      return stream;
    };
    return { controller, session, manager, replies, requests, requestModels, errors, executed, checks, postflight, lifecycle, uiStates };
  }
  return { open, cwd, configPath, bytes, digest, runtime, agentDir };
}

function expectClean(run: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["open"]>>) {
  expect(run.errors).toEqual([]);
  expect(run.replies).toEqual([]);
  expect(run.session.getSteeringMessages()).toEqual([]);
  expect(run.session.getFollowUpMessages()).toEqual([]);
}

describe("project validation through the installed pi SDK", () => {
  test("awaits the complete edit batch and sequential checked Bash before next-model evidence, without UI or recursive followups", async () => {
    const f = await fixture({ commands: [{ ...command("fixture-format"), kind: "format" }, command()] });
    writeFileSync(join(f.cwd, "editable.txt"), "old\n");
    const started = deferred(); const release = deferred();
    const run = await f.open({ execute: async (command, cwd, opts) => {
      expect(readFileSync(join(cwd, "source.txt"), "utf8")).toBe("new\n");
      expect(readFileSync(join(cwd, "editable.txt"), "utf8")).toBe("changed\n");
      if (command === "fixture-format") { started.resolve(); await release.promise;
        writeFileSync(join(cwd, "formatted.txt"), "formatter mutation\n"); }
      opts.onData(Buffer.from(`VALIDATION_OUTPUT:${command}\n`));
      return { exitCode: 0 };
    } });
    expect(validationForSession(run.session)).toBe(run.controller);
    expect(run.controller.preview()).toContain(f.digest);
    run.controller.enable(f.digest);
    run.replies.push([write(), call("edit-two", "edit", { path: "editable.txt", edits: [{ oldText: "old", newText: "changed" }] })], text());
    const pending = run.session.prompt("Apply the coherent batch.");
    try {
      await started.promise;
      expect(run.requests).toHaveLength(1);
      expect(run.executed.map((entry) => entry.command)).toEqual(["fixture-format"]);
      expect(run.lifecycle).not.toContain("agent-end");
      expect(evidence(run.manager)).toHaveLength(0);
    } finally { release.resolve(); await pending; }
    expect(run.executed.map((entry) => entry.command)).toEqual(["fixture-format", "fixture-test"]);
    expect(run.checks).toEqual([expect.objectContaining({ command: "fixture-format", timeout: 1 }),
      expect.objectContaining({ command: "fixture-test", timeout: 1 })]);
    expect(run.postflight).toHaveLength(2);
    expect(run.requests).toHaveLength(2);
    const next = JSON.stringify(run.requests[1]);
    expect(next).toContain(f.digest); expect(next).toContain("VALIDATION_OUTPUT:fixture-test");
    expect(evidence(run.manager)).toHaveLength(1);
    const entries = run.manager.getEntries(); const marker = entries.indexOf(evidence(run.manager)[0]!);
    for (const id of ["write-one", "edit-two"]) {
      const index = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
      expect(index).toBeGreaterThan(-1); expect(index).toBeLessThan(marker);
    }
    expect(run.controller.lastFailed).toBe(false);
    expect(run.uiStates.length).toBeGreaterThan(0); expect(run.uiStates.every((state) => state === false)).toBe(true);
    run.replies.push(text("Later answer.")); await run.session.prompt("No edits this time.");
    expect(run.executed).toHaveLength(2); expect(evidence(run.manager)).toHaveLength(1);
    expectClean(run);
  });

  for (const contextOrder of [undefined, "validation-first", "context-first"] as const) {
    for (const legacy of [false, true]) {
      for (const partial of [false, true]) {
        test(`fresh evidence survives ${legacy ? "legacy" : "contextual"} ${partial ? "partial" : "undefined"} predecessor without rollover (${contextOrder ?? "no context controller"})`, async () => {
          const f = await fixture();
          const update = partial ? { model: { ...MODEL, id: "predecessor-model" }, thinkingLevel: "off" as const } : undefined;
          const predecessorInputs: string[] = [];
          let predecessorCalls = 0;
          const run = await f.open({ contextOrder, beforeBind(session) {
            session.agent.prepareNextTurnWithContext = undefined;
            if (legacy) session.agent.prepareNextTurn = function (signal) {
              expect(this).toBe(session.agent); expect(signal?.aborted).toBe(false);
              predecessorCalls++; return update;
            };
            else session.agent.prepareNextTurnWithContext = function (turn, signal) {
              expect(this).toBe(session.agent); expect(signal?.aborted).toBe(false);
              predecessorInputs.push(JSON.stringify(turn.context.messages));
              predecessorCalls++; return update;
            };
          } });
          const prepare = run.session.agent.prepareNextTurnWithContext!;
          const returned: Awaited<ReturnType<typeof prepare>>[] = [];
          run.session.agent.prepareNextTurnWithContext = async function (turn, signal) {
            const value = await prepare.call(this, turn, signal); returned.push(value); return value;
          };
          // Without our own refresh, preserve even an undefined result verbatim.
          run.replies.push([call("read-config", "read", { path: ".pum/validation.json" })], text());
          await run.session.prompt("Read only: no evidence refresh.");
          expect(returned.length).toBeGreaterThan(0);
          for (const value of returned) expect(value).toBe(update);
          returned.length = 0;
          run.controller.enable(f.digest); run.replies.push([write()], text());
          await run.session.prompt("Write and retain the predecessor contract.");
          expect(predecessorCalls).toBeGreaterThan(1);
          expect(run.executed).toHaveLength(1);
          expect(run.requests).toHaveLength(4);
          const next = JSON.stringify(run.requests[3]);
          expect(next).toContain(f.digest); expect(next).toContain("VALIDATION_OUTPUT:fixture-test");
          expect(next).toContain("Read only: no evidence refresh.");
          expect(evidence(run.manager)).toHaveLength(1);
          expect(run.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pum.context_window")).toHaveLength(0);
          const refreshed = returned.find((value) => value?.context);
          expect(JSON.stringify(refreshed?.context?.messages)).toContain("VALIDATION_OUTPUT:fixture-test");
          if (!legacy) expect(predecessorInputs.some((input) => input.includes("VALIDATION_OUTPUT:fixture-test"))).toBe(true);
          if (partial) {
            expect(refreshed?.model).toBe(update!.model);
            expect(refreshed?.thinkingLevel).toBe("off");
            expect(run.requestModels[3]).toBe("predecessor-model");
          }
          expectClean(run);
        });
      }
    }
    for (const stop of [true, false]) {
      test(`preserves explicit predecessor shouldStopAfterTurn=${stop} (${contextOrder ?? "no context controller"})`, async () => {
        const f = await fixture(); let calls = 0;
        const run = await f.open({ contextOrder, beforeBind(session) {
          session.agent.shouldStopAfterTurn = function (turn, signal) {
            expect(this).toBe(session.agent); expect(signal?.aborted).toBe(false);
            expect(turn.message.role).toBe("assistant"); calls++; return stop;
          };
        } });
        run.controller.enable(f.digest); run.replies.push([write()]);
        if (!stop) run.replies.push(text());
        await run.session.prompt("Respect the predecessor stop decision.");
        expect(calls).toBeGreaterThan(0); expect(run.executed).toHaveLength(1);
        expect(evidence(run.manager)).toHaveLength(1);
        expect(run.requests).toHaveLength(stop ? 1 : 2);
        if (!stop) expect(JSON.stringify(run.requests[1])).toContain("VALIDATION_OUTPUT:fixture-test");
        expectClean(run);
      });
    }
  }

  test("an explicit predecessor context wins while its other update fields survive", async () => {
    const f = await fixture();
    const run = await f.open({ beforeBind(session) {
      session.agent.prepareNextTurnWithContext = (turn) => ({
        context: { ...turn.context, messages: [...turn.context.messages,
          { role: "user", content: "PREDECESSOR_CONTEXT_SENTINEL", timestamp: 1 }] },
        model: { ...MODEL, id: "explicit-context-model" }, thinkingLevel: "off",
      });
    } });
    run.controller.enable(f.digest); run.replies.push([write()], text());
    await run.session.prompt("Preserve the predecessor's explicit context.");
    expect(run.requestModels[1]).toBe("explicit-context-model");
    expect(JSON.stringify(run.requests[1])).toContain("PREDECESSOR_CONTEXT_SENTINEL");
    expect(JSON.stringify(run.requests[1])).toContain("VALIDATION_OUTPUT:fixture-test");
    expectClean(run);
  });

  test("discovery, preview and model text cannot approve; failed mutations do not validate", async () => {
    const f = await fixture(); const run = await f.open();
    expect(run.controller.preview()).toContain(f.digest); expect(run.executed).toEqual([]);
    run.replies.push([write()], text()); await run.session.prompt(`/validation enable ${f.digest}`);
    expect(run.executed).toEqual([]);
    run.controller.enable(f.digest);
    run.replies.push([call("bad-edit", "edit", { path: "missing.txt", edits: [{ oldText: "no", newText: "yes" }] })], text());
    await run.session.prompt("Attempt an invalid edit.");
    expect(result(run.manager, "bad-edit")?.isError).toBe(true); expect(run.executed).toEqual([]);
    run.controller.disable();
    run.replies.push([write("disabled-write")], text()); await run.session.prompt("Disabled batch.");
    expect(run.executed).toEqual([]); expectClean(run);
  });

  for (const mode of ["exit", "deny", "sandbox-require", "result-denial"] as const) {
    test(`first ${mode} failure stops subsequent commands and reaches the next model without automatic repairs`, async () => {
      const f = await fixture({ commands: [command("first-check"), command("must-not-run")] });
      const gate: InlineExtension = { name: "validation-sdk-denial", factory(pi) {
        pi.on("tool_call", (event) => event.toolName === "bash" && mode === "deny"
          ? { block: true, reason: "CHECK_DENIED_SENTINEL" } : undefined);
        pi.on("tool_result", (event) => event.toolName === "bash" && mode === "result-denial"
          ? { isError: true, content: [{ type: "text", text: "RESULT_DENIED_SENTINEL" }] } : undefined);
      } };
      const run = await f.open({ extensions: [gate], execute: async (_command, _cwd, opts) => {
        if (mode === "sandbox-require") throw new Error("SANDBOX_REQUIRE_UNAVAILABLE: no native backend; fallback prohibited");
        opts.onData(Buffer.from("FAILED_CHECK_OUTPUT\n")); return { exitCode: mode === "exit" ? 7 : 0 };
      } });
      run.controller.enable(f.digest); run.replies.push([write()], text()); await run.session.prompt("Mutate and validate.");
      expect(run.executed.map((entry) => entry.command)).toEqual(mode === "deny" ? [] : ["first-check"]);
      expect(run.checks).toEqual([expect.objectContaining({ command: "first-check", timeout: 1 })]);
      expect(run.controller.lastFailed).toBe(true); expect(evidence(run.manager)).toHaveLength(1);
      expect(JSON.stringify(run.requests[1])).toContain(f.digest);
      if (mode === "deny") expect(evidenceText(run.manager)).toMatch(/blocked|denied/i);
      else {
        const sentinel = mode === "sandbox-require" ? "SANDBOX_REQUIRE_UNAVAILABLE"
          : mode === "result-denial" ? "RESULT_DENIED_SENTINEL" : "FAILED_CHECK_OUTPUT";
        expect(evidenceText(run.manager)).toContain(sentinel);
      }
      expect(run.requests).toHaveLength(2); expectClean(run);
    });
  }

  test("runtime approval maxRuns caps ordinary model repairs and reports exhaustion, never success", async () => {
    const f = await fixture({ maxRuns: 1 }); const run = await f.open(); run.controller.enable(f.digest);
    run.replies.push([write("first")], [write("repair", "source.txt", "repaired\n")], text());
    await run.session.prompt("Make two batches.");
    expect(run.executed).toHaveLength(1); expect(run.requests).toHaveLength(3);
    expect(evidenceText(run.manager)).toMatch(/exhaust|limit|budget/i);
    expect(run.controller.lastFailed).toBe(true); expectClean(run);
  });

  for (const stage of ["preflight", "execution"] as const) {
    test(`cancelling during ${stage} propagates abort, stops the run and cannot start a followup`, async () => {
      const f = await fixture({ commands: [command("cancel-check"), command("must-not-run")] });
      const started = deferred(); let observedSignal: AbortSignal | undefined;
      const waitForAbort = async (signal?: AbortSignal) => {
        observedSignal = signal; started.resolve();
        if (!signal) throw new Error("Missing cancellation signal");
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("FIXTURE_CANCELLED");
      };
      const gate: InlineExtension = { name: "validation-sdk-cancel-gate", factory(pi) {
        pi.on("tool_call", async (event, ctx) => { if (event.toolName === "bash" && stage === "preflight") await waitForAbort(ctx.signal); });
      } };
      const run = await f.open({ extensions: [gate], execute: async (_command, _cwd, opts) => {
        await waitForAbort(opts.signal); return { exitCode: null };
      } });
      run.controller.enable(f.digest); run.replies.push([write()]);
      const pending = run.session.prompt("Cancel validation.");
      await started.promise; await run.session.abort(); await pending;
      expect(observedSignal?.aborted).toBe(true);
      expect(run.executed).toHaveLength(stage === "execution" ? 1 : 0);
      expect(run.requests).toHaveLength(1); expect(evidenceText(run.manager)).toMatch(/cancel|abort/i);
      expect(run.controller.lastFailed).toBe(true); expectClean(run);
    });
  }

  test("a deadline includes pending Check preflight and never executes after a late approval", async () => {
    const f = await fixture({ commands: [command("timeout-check"), command("must-not-run")] });
    const release = deferred();
    const gate: InlineExtension = { name: "validation-sdk-deadline-gate", factory(pi) {
      pi.on("tool_call", async (event) => { if (event.toolName === "bash") await release.promise; });
    } };
    const run = await f.open({ extensions: [gate] }); run.controller.enable(f.digest);
    run.replies.push([write()], text());
    const pending = run.session.prompt("Bound the verifier deadline.");
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("Validation failed to bound its one-second preflight deadline")), 2_500);
      })]);
    } finally { clearTimeout(watchdog); release.resolve(); await pending; }
    expect(run.executed).toEqual([]); expect(evidenceText(run.manager)).toMatch(/timeout|timed out/i);
    expect(run.controller.lastFailed).toBe(true); expect(run.requests).toHaveLength(2); expectClean(run);
  });

  for (const revoke of ["disable", "changed", "missing", "invalid"] as const) {
    test(`${revoke} during delayed preflight prevents late execution and releases the runtime for new approval`, async () => {
      const f = await fixture({ commands: [command("pending-check"), command("second-check")] });
      const started = deferred(); const release = deferred(); const finished = deferred();
      let observedSignal: AbortSignal | undefined;
      let delayed = true;
      const gate: InlineExtension = { name: "validation-sdk-revocation-gate", factory(pi) {
        pi.on("tool_call", async (event, ctx) => {
          if (event.toolName !== "bash" || !delayed) return;
          delayed = false; observedSignal = ctx.signal; started.resolve();
          await release.promise; finished.resolve();
        });
      } };
      const run = await f.open({ extensions: [gate] }); run.controller.enable(f.digest);
      run.replies.push([write()], text());
      const pending = run.session.prompt("Revoke while the verifier is pending.");
      try {
        await started.promise;
        expect(run.requests).toHaveLength(1); expect(run.executed).toEqual([]);
        if (revoke === "disable") {
          run.controller.disable();
          // A noncooperative predecessor may finish later. Disable must settle
          // cancelled evidence without waiting for that hook or its deadline.
          await pending;
        } else {
          if (revoke === "missing") rmSync(f.configPath);
          else writeFileSync(f.configPath, revoke === "invalid" ? "not JSON" : `${f.bytes}\n`);
          release.resolve(); await pending;
        }
        // SDK extension context retains the parent-turn signal: revocation
        // cancels validation, not the ordinary model continuation.
        expect(observedSignal?.aborted).toBe(false);
        expect(run.executed).toEqual([]); expect(run.checks).toHaveLength(1);
        expect(run.controller.status()).toContain("disabled");
        expect(evidenceText(run.manager)).toContain('"outcome":"cancelled"');
        expect(run.requests).toHaveLength(2);
        expect(JSON.stringify(run.requests[1])).toContain("Automatic validation: cancelled");
        const settledEvidence = evidenceText(run.manager);
        release.resolve(); await finished.promise;
        run.replies.push(text()); await run.session.prompt("No mutations after late approval.");
        expect(run.executed).toEqual([]); expect(evidenceText(run.manager)).toBe(settledEvidence);
        // Explicit new consent, not delayed approval, is needed for another run.
        writeFileSync(f.configPath, f.bytes); run.controller.enable(f.digest);
        run.replies.push([write("reapproved-write")], text());
        await run.session.prompt("A newly approved batch can validate.");
        expect(run.executed.map((entry) => entry.command)).toEqual(["pending-check", "second-check"]);
        expect(evidence(run.manager)).toHaveLength(2); expectClean(run);
      } finally { release.resolve(); await pending; }
    });
  }

  test("a command deadline aborts the registered Bash backend and stops later commands", async () => {
    const f = await fixture({ commands: [command("deadline-check"), command("must-not-run")] });
    let backendSignal: AbortSignal | undefined;
    const run = await f.open({ execute: async (_command, _cwd, opts) => {
      backendSignal = opts.signal;
      if (!backendSignal) throw new Error("Missing backend abort signal");
      if (!backendSignal.aborted) await new Promise<void>((resolve) => backendSignal!.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("BACKEND_ABORTED_AT_DEADLINE");
    } });
    run.controller.enable(f.digest); run.replies.push([write()], text());
    await run.session.prompt("Bound command execution.");
    expect(backendSignal?.aborted).toBe(true); expect(run.executed).toHaveLength(1);
    expect(evidenceText(run.manager)).toMatch(/timeout|timed out/i);
    expect(run.controller.lastFailed).toBe(true); expectClean(run);
  });

  test("readonly and unbound runtimes cannot acquire validation authority", async () => {
    const f = await fixture();
    for (const options of [{ readonly: true }, { bind: false }]) {
      const run = await f.open(options);
      expect(() => run.controller.enable(f.digest)).toThrow();
      run.replies.push([write()], text()); await run.session.prompt("The host has not authorized this role.");
      expect(run.executed).toEqual([]); expectClean(run);
    }
  });

  test("config bytes changed by a successful native write revoke approval before execution", async () => {
    const f = await fixture(); const run = await f.open(); run.controller.enable(f.digest);
    run.replies.push([write("tamper", ".pum/validation.json", `${f.bytes}\n`), write()], text());
    await run.session.prompt("Change proposal bytes in the batch.");
    expect(run.executed).toEqual([]); expect(run.controller.lastFailed).toBe(true);
    expect(evidenceText(run.manager)).toMatch(/chang|revok|digest|config/i); expectClean(run);
  });

  test("same-cwd workers do not overlap or inherit approval, and a skipped worker can run a later new batch", async () => {
    const f = await fixture(); const started = deferred(); const release = deferred();
    const a = await f.open({ execute: async (_command, _cwd, opts) => { started.resolve(); await release.promise;
      opts.onData(Buffer.from("WORKER_A_RESULT")); return { exitCode: 0 }; } });
    const b = await f.open(); const unapproved = await f.open();
    a.controller.enable(f.digest); b.controller.enable(f.digest);
    a.replies.push([write("a", "a.txt")], text()); const pending = a.session.prompt("Worker A batch.");
    try {
      await started.promise;
      b.replies.push([write("b", "b.txt")], text()); await b.session.prompt("Worker B contends.");
      expect(b.executed).toEqual([]); expect(evidenceText(b.manager)).toMatch(/defer|skip|another|busy|concurrent/i);
      unapproved.replies.push([write("c", "c.txt")], text()); await unapproved.session.prompt("No inherited approval.");
      expect(unapproved.executed).toEqual([]);
    } finally { release.resolve(); await pending; }
    b.replies.push([write("b-later", "b.txt", "later\n")], text()); await b.session.prompt("New batch after release.");
    expect(a.executed).toHaveLength(1); expect(b.executed).toHaveLength(1);
    expect(evidenceText(b.manager)).not.toContain("WORKER_A_RESULT");
    for (const run of [a, b, unapproved]) expectClean(run);
  });

  for (const finishFirst of [true, false]) {
    test(`finish_subagent cannot race sibling edits in the same real parallel batch (finish first: ${finishFirst})`, async () => {
      const f = await fixture(); const run = await f.open(); run.controller.enable(f.digest);
      const finish = call("premature-finish", "finish_subagent"); const mutation = write();
      run.replies.push(finishFirst ? [finish, mutation] : [mutation, finish], text());
      await run.session.prompt("Attempt premature completion.");
      expect(result(run.manager, "premature-finish")?.isError).toBe(true);
      expect(run.lifecycle).not.toContain("finish-execute");
      expect(JSON.stringify(result(run.manager, "premature-finish"))).toMatch(/batch|validat|edit|mutat/i);
      run.replies.push([call("later-finish", "finish_subagent")], text());
      await run.session.prompt("Finish separately after the validation evidence.");
      expect(result(run.manager, "later-finish")?.isError).toBe(false);
      expect(run.lifecycle.filter((event) => event === "finish-execute")).toHaveLength(1);
      expectClean(run);
    });
  }

  test("SDK retry after validation does not rerun the clean batch at agent_end", async () => {
    const f = await fixture(); const run = await f.open({ retry: true }); run.controller.enable(f.digest);
    run.replies.push([write()], "retry-error", text("Recovered provider request."));
    await run.session.prompt("Retry transport, not validation.");
    expect(run.requests).toHaveLength(3); expect(run.executed).toHaveLength(1);
    expect(evidence(run.manager)).toHaveLength(1);
    for (const request of run.requests.slice(1)) expect(JSON.stringify(request)).toContain("VALIDATION_OUTPUT:fixture-test");
    expectClean(run);
  });

  for (const contextOrder of ["validation-first", "context-first"] as const) {
    test(`same-batch rollover preserves validation evidence and private memory without restoring archives (${contextOrder})`, async () => {
      const f = await fixture();
      const memory: InlineExtension = { name: "validation-sdk-private-memory-projection", factory(pi) {
        pi.on("context", (event) => ({ messages: [{ role: "custom" as const, customType: "pum.memory",
          content: "CURRENT_PRIVATE_MEMORY_SENTINEL", display: false, timestamp: 1 }, ...event.messages] }));
      } };
      const run = await f.open({ contextOrder, extensions: [memory] });
      run.replies.push(text("ARCHIVED_ANSWER_SENTINEL")); await run.session.prompt("ARCHIVED_USER_SENTINEL");
      run.controller.enable(f.digest);
      run.replies.push([write(), call("rollover", "new_context", { handoff: "VALIDATION_ROLLOVER_HANDOFF" })], text("AFTER_ROLLOVER_ANSWER"));
      await run.session.prompt("Apply mutations and roll over coherently.");
      expect(run.executed).toHaveLength(1); expect(run.requests).toHaveLength(3);
      const next = JSON.stringify(run.requests[2]);
      expect(next).toContain("VALIDATION_ROLLOVER_HANDOFF");
      expect(next).toContain("VALIDATION_OUTPUT:fixture-test");
      expect(next).toContain(f.digest);
      expect(next.split("CURRENT_PRIVATE_MEMORY_SENTINEL")).toHaveLength(2);
      for (const old of ["ARCHIVED_ANSWER_SENTINEL", "ARCHIVED_USER_SENTINEL", "Apply mutations and roll over coherently."]) {
        expect(next).not.toContain(old);
      }
      expect(run.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pum.context_window")).toHaveLength(1);
      expect(JSON.stringify(run.manager.getEntries())).not.toContain("CURRENT_PRIVATE_MEMORY_SENTINEL");
      run.replies.push(text()); await run.session.prompt("Later prompt preserves both projections.");
      const later = JSON.stringify(run.requests[3]);
      expect(later).toContain("VALIDATION_OUTPUT:fixture-test"); expect(later).toContain("AFTER_ROLLOVER_ANSWER");
      expect(later).not.toContain("ARCHIVED_USER_SENTINEL");
      expect(run.executed).toHaveLength(1);
      run.replies.push([write("post-rollover-write", "source.txt", "later mutation\n")], text());
      await run.session.prompt("Refresh new validation evidence inside the active window.");
      const refreshed = JSON.stringify(run.requests[5]);
      expect(refreshed).toContain("Automatic validation: passed (run 2,");
      expect(refreshed).toContain("VALIDATION_ROLLOVER_HANDOFF");
      expect(refreshed).toContain("AFTER_ROLLOVER_ANSWER");
      expect(refreshed.split("CURRENT_PRIVATE_MEMORY_SENTINEL")).toHaveLength(2);
      expect(refreshed).not.toContain("ARCHIVED_USER_SENTINEL");
      expect(refreshed).not.toContain("ARCHIVED_ANSWER_SENTINEL");
      expect(run.executed).toHaveLength(2); expectClean(run);
    });

    test(`cancellation preserves the predecessor rollover stop guard (${contextOrder})`, async () => {
      const f = await fixture(); const started = deferred();
      const run = await f.open({ contextOrder, execute: async (_command, _cwd, opts) => {
        started.resolve();
        if (!opts.signal) throw new Error("Missing cancellation signal");
        if (!opts.signal.aborted) await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("COMPOSED_VALIDATION_CANCELLED");
      } });
      run.controller.enable(f.digest);
      run.replies.push([write(), call("cancel-rollover", "new_context", { handoff: "CANCELLED_HANDOFF_MUST_NOT_APPLY" })]);
      const pending = run.session.prompt("Cancel the composed batch.");
      await started.promise; await run.session.abort(); await pending;
      expect(run.requests).toHaveLength(1); expect(run.executed).toHaveLength(1);
      expect(run.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pum.context_window")).toHaveLength(0);
      expect(evidenceText(run.manager)).toMatch(/cancel|abort/i); expectClean(run);
    });
  }

  test("real Check mode denies automatic privileged commands before native execution", async () => {
    const previous = getCheckModeConfig();
    try {
      setCheckModeConfig({ profile: "on", model: "unavailable/test" });
      const f = await fixture({ commands: [command("sudo touch blocked.txt")] });
      const run = await f.open({ extensions: [createCheckModeExtension(f.runtime, { identity: { kind: "subagent", agentId: "validation-test" } })] });
      run.controller.enable(f.digest); run.replies.push([write()], text());
      await run.session.prompt("Check the edited batch.");
      expect(run.executed).toEqual([]);
      expect(evidenceText(run.manager)).toContain('"outcome":"blocked"');
      expect(existsSync(join(f.cwd, "blocked.txt"))).toBe(false);
      expectClean(run);
    } finally { setCheckModeConfig(previous); }
  });

  test("real Require sandbox controller refuses unsupported native enforcement without local fallback", async () => {
    const previous = getCheckModeConfig();
    try {
      setCheckModeConfig({ profile: "on", model: "unavailable/test" });
      const f = await fixture({ commands: [command("printf validation-native-test")] });
      const sandbox = new SandboxController({ mode: "require", platform: "darwin", agentDir: f.agentDir });
      const run = await f.open({ nativeBash: true, extensions: [createCheckModeExtension(f.runtime), sandbox.extension()] });
      run.controller.enable(f.digest); run.replies.push([write()], text());
      await run.session.prompt("Check through Require.");
      expect(run.executed).toEqual([]);
      expect(evidenceText(run.manager)).toContain('"outcome":"failed"');
      expect(evidenceText(run.manager)).toMatch(/sandbox|supported/i);
      expectClean(run);
    } finally { setCheckModeConfig(previous); }
  });

  test("real registered PUM Bash executes approved validation and reports nonzero exits", async () => {
    const previous = getCheckModeConfig();
    try {
      setCheckModeConfig({ profile: "off", model: "unavailable/test" });
      const f = await fixture({ commands: [command("printf VALIDATION_REAL_BASH; exit 7")] });
      const sandbox = new SandboxController({ mode: "off", agentDir: f.agentDir });
      const run = await f.open({ nativeBash: true, extensions: [createCheckModeExtension(f.runtime), sandbox.extension()] });
      run.controller.enable(f.digest); run.replies.push([write()], text());
      await run.session.prompt("Run the actual PUM Bash path.");
      expect(run.executed).toEqual([]); // probe backend was overridden by PUM
      expect(evidenceText(run.manager)).toContain("VALIDATION_REAL_BASH");
      expect(evidenceText(run.manager)).toContain('"outcome":"failed"');
      expect(run.controller.lastFailed).toBe(true);
      expectClean(run);
    } finally { setCheckModeConfig(previous); }
  });

  test("evidence persists and replays but resume/dispose never preserves execution authority", async () => {
    const f = await fixture(); const run = await f.open(); run.controller.enable(f.digest);
    run.replies.push([write()], text()); await run.session.prompt("Persist evidence.");
    const file = run.session.sessionFile!; expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("VALIDATION_OUTPUT:fixture-test");
    const oldEvidence = structuredClone(evidence(run.manager)); expect(oldEvidence).toHaveLength(1);
    run.session.dispose(); sessions.splice(sessions.indexOf(run.session), 1);
    expect(validationForSession(run.session)).toBeUndefined();
    const resumed = await f.open({ sessionFile: file });
    expect(evidence(resumed.manager)).toEqual(oldEvidence);
    resumed.replies.push([write("resumed-write")], text()); await resumed.session.prompt("Resume without new approval.");
    expect(resumed.executed).toEqual([]);
    expect(JSON.stringify(resumed.requests[0])).toContain("VALIDATION_OUTPUT:fixture-test");
    expectClean(resumed);
  });
});

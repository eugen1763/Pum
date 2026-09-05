import { bindRuntimeSettingsActivity } from "../src/runtime-settings";
import { afterEach, expect, test } from "bun:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createBashTool, createReadTool, createAgentSessionFromServices, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindCheckModeApprovalSession, setCheckModeConfig } from "../src/check-mode";
import { ProjectValidationController } from "../src/project-validation";

const roots: string[] = [];
afterEach(() => {
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const model: Model<"openai-completions"> = {
  id: "policy-epoch", name: "policy-epoch", provider: "pum-test", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("installed SDK parallel preflight cannot run an earlier local Bash after a sibling crosses tightening", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pum-policy-sdk-")); roots.push(cwd);
  writeFileSync(join(cwd, "input"), "read fixture");
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  const entered = deferred(); const release = deferred();
  let request = 0;
  const agent = new Agent({
    toolExecution: "parallel",
    initialState: { model, systemPrompt: "Local policy test", tools: [createBashTool(cwd), createReadTool(cwd)] },
    beforeToolCall: async (event) => {
      if (event.toolCall.name === "read") { entered.resolve(); await release.promise; }
      return undefined;
    },
    streamFn: () => {
      const content: AssistantMessage["content"] = request++ === 0 ? [
        { type: "toolCall", id: "first-bash", name: "bash", arguments: { command: "printf x > output" } },
        { type: "toolCall", id: "second-read", name: "read", arguments: { path: "input" } },
      ] : [{ type: "text", text: "Stopped after policy changed." }];
      const message: AssistantMessage = {
        role: "assistant", content, provider: model.provider, model: model.id, api: model.api,
        timestamp: 1, stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop",
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    },
  });
  const session = { agent, subscribe: agent.subscribe.bind(agent), dispose() {} } as any;
  bindCheckModeApprovalSession(session);
  try {
    const running = agent.prompt("Run a two-tool batch.");
    await entered.promise;
    // First Bash already passed preflight, but SDK has not invoked execute.
    expect(existsSync(join(cwd, "output"))).toBe(false);
    setCheckModeConfig({ profile: "on", model: "test/verifier" });
    release.resolve();
    await running;
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.every((message) => message.isError)).toBe(true);
    expect(JSON.stringify(results)).toContain("earlier approval is invalid");
    expect(existsSync(join(cwd, "output"))).toBe(false);
  } finally { release.resolve(); session.dispose(); }
});

// Real installed prepare/validate/preflight/execute ordering. The fake tool body
// records dispatch instead of touching the OS; neither ID uniqueness nor raw
// arguments identity is assumed by this fixture.
async function batchFixture(options: {
  batches: Array<Array<{ id: string; name: string; arguments: Record<string, unknown> }>>;
  before?: (event: any) => Promise<any>;
  transform?: boolean;
  beforePrompt?: (agent: Agent, tools: AgentTool[]) => void;
}) {
  const executed: number[] = [];
  const prepared: object[] = [];
  const tools: AgentTool[] = ["bash", "read"].map((name) => ({
    name, label: name, description: "Local dispatch probe",
    parameters: Type.Object({ n: Type.Number() }),
    ...(options.transform ? { prepareArguments: (raw: any) => ({ n: Number(raw.raw) }) } : {}),
    execute: async (_id, args: any) => {
      expect(prepared).toContain(args);
      executed.push(args.n);
      return { content: [{ type: "text", text: "executed" }], details: {} };
    },
  }));
  let request = 0;
  const agent = new Agent({
    toolExecution: "parallel", initialState: { model, systemPrompt: "Dispatch probe", tools },
    beforeToolCall: async (event) => {
      prepared.push(event.args as object);
      // SDK validation clones the prepared input before this boundary.
      expect(event.args).not.toBe(event.toolCall.arguments);
      return options.before?.(event);
    },
    streamFn: () => {
      const batch = options.batches[request++];
      const content: AssistantMessage["content"] = batch
        ? batch.map((call) => ({ type: "toolCall", ...call }))
        : [{ type: "text", text: "Done." }];
      const message: AssistantMessage = {
        role: "assistant", content, provider: model.provider, model: model.id, api: model.api,
        timestamp: 1, stopReason: batch ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: batch ? "toolUse" : "stop", message });
      return stream;
    },
  });
  const session = { agent, subscribe: agent.subscribe.bind(agent), dispose() {} } as any;
  bindCheckModeApprovalSession(session);
  try {
    options.beforePrompt?.(agent, tools);
    await agent.prompt("Dispatch the fixture batches.");
    return { executed, results: agent.state.messages.filter((message) => message.role === "toolResult") };
  } finally { session.dispose(); }
}
const call = (id: string, name: string, n: number) => ({ id, name, arguments: { n } });

for (const sibling of ["read", "bash"]) {
  test(`installed SDK duplicate ${sibling} ID cannot delete stale Bash authority`, async () => {
    setCheckModeConfig({ profile: "off", model: "test/verifier" });
    const result = await batchFixture({
      batches: [[call("same", "bash", 1), call("same", sibling, 2)]],
      before: async (event) => {
        if (event.args.n === 2) {
          setCheckModeConfig({ profile: "on", model: "test/verifier" });
          return { block: true, reason: "blocked sibling" };
        }
      },
    });
    expect(result.executed).toEqual([]);
    expect(result.results.map((result) => result.isError)).toEqual([true, true]);
  });

  test(`installed SDK duplicate ${sibling} IDs remain independently executable without tightening`, async () => {
    const result = await batchFixture({ batches: [[call("same", "bash", 1), call("same", sibling, 2)]] });
    expect(result.executed).toEqual([1, 2]);
    expect(result.results.every((result) => !result.isError)).toBe(true);
  });
}

test("installed SDK later same-ID approval cannot overwrite stale earlier authority", async () => {
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  const result = await batchFixture({
    batches: [[call("same", "bash", 1), call("change", "read", 2), call("same", "bash", 3)]],
    before: async (event) => {
      if (event.args.n === 2) setCheckModeConfig({ profile: "on", model: "test/verifier" });
    },
  });
  expect(result.executed).toEqual([3]);
  expect(result.results.map((result) => result.isError)).toEqual([true, true, false]);
});

test("installed SDK reused IDs on retry obtain only fresh per-call authority", async () => {
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  const result = await batchFixture({
    batches: [[call("same", "bash", 1), call("same", "read", 2)], [call("same", "bash", 3)]],
    before: async (event) => {
      if (event.args.n === 2) setCheckModeConfig({ profile: "on", model: "test/verifier" });
    },
  });
  expect(result.executed).toEqual([3]);
  expect(result.results.map((result) => result.isError)).toEqual([true, true, false]);
});

test("installed SDK wrapped execution fails closed when preflight authority is missing", async () => {
  const result = await batchFixture({
    batches: [[call("missing", "bash", 1)]],
    beforePrompt: (agent) => { agent.beforeToolCall = undefined; },
  });
  expect(result.executed).toEqual([]);
  expect(result.results[0]?.isError).toBe(true);
});

test("installed SDK prepareArguments transformation is preserved and authority binds validated args", async () => {
  const result = await batchFixture({
    batches: [[{ id: "transformed", name: "bash", arguments: { raw: "7" } }]], transform: true,
    before: async (event) => { expect(event.args).toEqual({ n: 7 }); expect(event.toolCall.arguments).toEqual({ raw: "7" }); },
  });
  expect(result.executed).toEqual([7]);
  expect(result.results[0]?.isError).toBe(false);
});

async function sessionFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pum-approval-session-sdk-")); roots.push(cwd);
  mkdirSync(join(cwd, ".pum"));
  const config = JSON.stringify({ version: 1, commands: [{ kind: "test", command: "fixture-test", timeoutSeconds: 1 }] });
  writeFileSync(join(cwd, ".pum", "validation.json"), config);
  const controller = new ProjectValidationController({ cwd });
  const executed: string[] = [];
  const checked: string[] = [];
  const bash = createBashTool(cwd, { exposeSessionEnvironment: false, operations: { async exec(command) {
    executed.push(command); return { exitCode: 0 };
  } } });
  const probe: InlineExtension = { name: "approval-probe", factory(pi) {
    pi.registerTool({ ...bash, label: "Bash" });
    pi.on("tool_call", (event) => { if (event.toolName === "bash") checked.push(String(event.input.command)); });
  } };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(cwd, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.hasConfiguredAuth = (provider) => provider === model.provider;
  const services = await createAgentSessionServices({ cwd, agentDir: cwd, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      noContextFiles: true, extensionFactories: [controller.extension(), probe] } });
  const { session } = await createAgentSessionFromServices({ services,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), model, thinkingLevel: "off", tools: ["write", "bash"] });
  bindCheckModeApprovalSession(session);
  bindRuntimeSettingsActivity(session);
  controller.bind(session);
  await session.bindExtensions({ onError: (error) => { throw error; } });
  const replies: Array<AssistantMessage["content"] | "retry-error"> = [];
  session.agent.streamFunction = () => {
    const reply = replies.shift();
    if (!reply) throw new Error("Fixture replies exhausted");
    const error = reply === "retry-error";
    const content = error ? [] : reply;
    const stopReason = error ? "error" : content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
    const message: AssistantMessage = { role: "assistant", content, provider: model.provider, model: model.id,
      api: model.api, timestamp: 1, stopReason, ...(error ? { errorMessage: "503 service unavailable" } : {}),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    if (error) stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: stopReason as "toolUse" | "stop", message });
    return stream;
  };
  return { session, controller, replies, executed, checked, digest: createHash("sha256").update(config).digest("hex") };
}

test("installed AgentSession automatic transport retry accepts fresh reused IDs after agent_end cleanup", async () => {
  const f = await sessionFixture();
  let ends = 0;
  f.session.subscribe((event) => { if (event.type === "agent_end") ends++; });
  f.replies.push(
    [{ type: "toolCall", id: "same", name: "bash", arguments: { command: "first" } }], "retry-error",
    [{ type: "toolCall", id: "same", name: "bash", arguments: { command: "retry" } }], [{ type: "text", text: "Done" }],
  );
  try {
    await f.session.prompt("Retry the transport with reused IDs.");
    expect(ends).toBe(2);
    expect(f.executed).toEqual(["first", "retry"]);
    expect(f.checked).toEqual(f.executed);
    expect(f.replies).toEqual([]);
  } finally { await f.session.abort(); f.session.dispose(); }
});

test("installed AgentSession direct user Bash retains its separate supported execution path", async () => {
  const f = await sessionFixture();
  const commands: string[] = [];
  try {
    const result = await f.session.executeBash("user-command", undefined, { operations: { async exec(command) {
      commands.push(command); return { exitCode: 0 };
    } } });
    expect(result.exitCode).toBe(0);
    expect(commands).toEqual(["user-command"]);
    expect(f.checked).toEqual([]);
  } finally { await f.session.abort(); f.session.dispose(); }
});

test("installed AgentSession automatic validation uses exact synthetic approval rather than user Bash", async () => {
  const f = await sessionFixture();
  f.session.executeBash = async () => { throw new Error("User Bash must not be used"); };
  f.controller.enable(f.digest);
  f.replies.push([{ type: "toolCall", id: "write", name: "write", arguments: { path: "output", content: "x" } }], [{ type: "text", text: "Done" }]);
  try {
    await f.session.prompt("Mutate and validate.");
    expect(f.executed).toEqual(["fixture-test"]);
    expect(f.checked).toEqual(f.executed);
    expect(f.replies).toEqual([]);
  } finally { await f.session.abort(); f.session.dispose(); }
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionServices, estimateTokens, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model, type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONTEXT_TOOL_NAMES, CONTEXT_WINDOW_CUSTOM_TYPE, ContextWindowController } from "../src/context-window";
import { createMemoryExtension, ProjectMemoryStore } from "../src/memory";
import { registerOperationalNotice } from "../src/operational-context";
import { buildSubagentCapacityPrompt, SubagentManager } from "../src/subagents/manager";

// Real installed SDK extension ordering, requests, retries, tools and JSONL IO;
// only auth preflight/transport are replaced. No provider/server/network is used.
const MODEL: Model<"openai-completions"> = {
  id: "operational-sdk", name: "operational-sdk", provider: "pum-operational-sdk", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const CAPACITY = "Subagent capacity:";
const POLICY = "SDK_EFFECTIVE_POLICY";
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const input = (context: Context) => context.messages.map(({ timestamp: _timestamp, ...message }) => message);
const notices = (context: Context, marker = CAPACITY) => context.messages.filter((message) =>
  message.role === "user" && JSON.stringify(message.content).includes(marker));
function prefix(previous: Context, next: Context) {
  expect(next.systemPrompt).toBe(previous.systemPrompt);
  expect(next.tools).toEqual(previous.tools);
  expect(input(next).slice(0, previous.messages.length)).toEqual(input(previous));
}

async function fixture(options: { retry?: boolean; memoryFirst?: boolean; root?: string; resume?: string } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "pum-operational-sdk-"));
  if (!options.root) roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "isolated-agent");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  const store = new ProjectMemoryStore(agentDir, cwd);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === MODEL.provider;
  const controller = new ContextWindowController();
  let active = 0;
  let policy = `${POLICY}: off`;
  let mutation = () => {};
  const operational: InlineExtension = { name: "sdk-operational-observations", factory(pi) {
    registerOperationalNotice(pi, { customType: "pum.subagent_capacity", observe: () => buildSubagentCapacityPrompt(active, 2) });
    registerOperationalNotice(pi, { customType: "pum.sdk_effective_policy", observe: () => policy });
    pi.registerTool({
      name: "sdk_transition", label: "SDK transition", description: "Change runtime observations during a real tool batch.",
      parameters: Type.Object({}), executionMode: "sequential",
      async execute() { mutation(); return { content: [{ type: "text", text: "Transition completed" }], details: {} }; },
    });
  } };
  const memory = createMemoryExtension({ agentDir, audience: "main" });
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false, reserveTokens: 1000 } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Stable SDK operational test instructions.",
      extensionFactories: [controller.extension(), ...(options.memoryFirst ? [memory, operational] : [operational, memory])],
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const manager = options.resume ? SessionManager.open(options.resume) : SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: MODEL,
    thinkingLevel: "off", tools: [...CONTEXT_TOOL_NAMES, "memory_read", "memory_edit", "sdk_transition"] });
  sessions.push(session); controller.bind(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  const requests: Context[] = [];
  const replies: Array<AssistantMessage["content"] | "error"> = [];
  let onRequest = () => {};
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    onRequest();
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected operational SDK request");
    const content = reply === "error" ? [] : reply;
    const message: AssistantMessage = {
      role: "assistant", content, provider: MODEL.provider, model: MODEL.id, api: MODEL.api, timestamp: Date.now(),
      stopReason: reply === "error" ? "error" : content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
      ...(reply === "error" ? { errorMessage: "503 Service Unavailable" } : {}),
      usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 5100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    if (reply === "error") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  const changeMemory = (value: string) => { const current = store.read(); store.edit(current.revision, current.content, value); };
  const prompt = async (value = "Continue") => { replies.push(text("Answer")); await session.prompt(value); return requests.at(-1)!; };
  const meter = async () => (await session.agent.state.tools.find((tool) => tool.name === "get_context_remaining")!
    .execute("meter", {}, new AbortController().signal)).details as { estimatedOverheadTokens: number; usedTokens: number };
  return { root, cwd, agentDir, session, manager, controller, errors, requests, replies, changeMemory, prompt, meter,
    setActive: (value: number) => { active = value; }, setPolicy: (value: string) => { policy = `${POLICY}: ${value}`; },
    setMutation: (fn: () => void) => { mutation = fn; }, setOnRequest: (fn: () => void) => { onRequest = fn; } };
}

function expectPrivate(h: Awaited<ReturnType<typeof fixture>>) {
  const serialized = JSON.stringify(h.manager.getEntries());
  const file = readFileSync(h.manager.getSessionFile()!, "utf8");
  for (const value of [CAPACITY, POLICY, "SDK_PRIVATE_", "pum.subagent_capacity", "pum.sdk_effective_policy", "pum.project_memory"]) {
    expect(serialized).not.toContain(value); expect(file).not.toContain(value);
  }
  expect(h.errors).toEqual([]);
}

describe("operational notices composed with memory/window through the installed SDK (#47)", () => {
  for (const memoryFirst of [false, true]) {
    test(`full/available transitions preserve serialized prefix and complete tool blocks (memory first: ${memoryFirst})`, async () => {
      const h = await fixture({ memoryFirst });
      h.changeMemory("SDK_PRIVATE_ORIGINAL");
      const initial = await h.prompt("Original durable instruction");
      expect(notices(initial)).toHaveLength(1);
      expect(JSON.stringify(notices(initial))).toContain("slots are available");
      expect(initial.systemPrompt).not.toContain(CAPACITY);
      h.setMutation(() => { h.setActive(2); h.setPolicy("on"); h.changeMemory("SDK_PRIVATE_UPDATED"); });
      h.replies.push([call("transition", "sdk_transition"), call("meter", "get_context_remaining")], text("Done"));
      await h.session.prompt("Transition during the tool loop");
      const before = h.requests.at(-2)!; const after = h.requests.at(-1)!;
      prefix(initial, before); prefix(before, after);
      expect(notices(after)).toHaveLength(2);
      expect(notices(after, POLICY)).toHaveLength(2);
      expect(notices(after, "PUM project memory")).toHaveLength(2);
      const pair = after.messages.findIndex((message) => message.role === "assistant"
        && message.content.some((part) => part.type === "toolCall" && part.id === "transition"));
      expect(pair).toBeGreaterThan(-1);
      expect(after.messages.slice(pair, pair + 6).map((message) => message.role))
        .toEqual(["assistant", "toolResult", "toolResult", "user", "user", "user"]);
      expect(JSON.stringify(notices(after).at(-1))).toContain("all 2 slots are active");
      const unchanged = await h.prompt(); prefix(after, unchanged);
      expect(notices(unchanged)).toHaveLength(2);
      h.setActive(1);
      const available = await h.prompt(); prefix(unchanged, available);
      expect(notices(available)).toHaveLength(3);
      expect(JSON.stringify(notices(available).at(-1))).toContain("slots are available");
      h.setActive(0); // Exact active counts do not churn the available observation.
      const stillAvailable = await h.prompt(); prefix(available, stillAvailable);
      expect(notices(stillAvailable)).toHaveLength(3);
      expectPrivate(h);
    });
  }

  for (const changed of [false, true]) {
    test(`transport retry ${changed ? "appends changed state" : "deduplicates unchanged state"} without rewriting input`, async () => {
      const h = await fixture({ retry: true });
      h.setOnRequest(() => { if (changed && h.requests.length === 1) h.setActive(2); });
      h.replies.push("error", text("Recovered"));
      await h.session.prompt("Retry operational request");
      expect(h.requests).toHaveLength(2);
      prefix(h.requests[0]!, h.requests[1]!);
      expect(notices(h.requests[1]!)).toHaveLength(changed ? 2 : 1);
      if (!changed) expect(input(h.requests[1]!)).toEqual(input(h.requests[0]!));
      const next = await h.prompt(); prefix(h.requests[1]!, next);
      expect(notices(next)).toHaveLength(changed ? 2 : 1);
      expectPrivate(h);
    });
  }

  test("meter charges every retained notice plus memory before new usage, never only latest or twice", async () => {
    const h = await fixture();
    h.changeMemory("SDK_PRIVATE_BUDGET_INITIAL");
    await h.prompt();
    const before = await h.meter();
    const durable = structuredClone(h.manager.getEntries());
    const file = readFileSync(h.manager.getSessionFile()!, "utf8");
    const files = readdirSync(join(h.root, "sessions")).sort();
    let prior = await h.session.agent.transformContext!(h.session.agent.state.messages);
    let overhead = before.estimatedOverheadTokens;
    for (let index = 0; index < 6; index++) {
      h.setActive(index % 2 === 0 ? 2 : 0);
      h.setPolicy(`${index} ${"bounded effective observation ".repeat(100)}`);
      h.changeMemory(`SDK_PRIVATE_BUDGET_${index} ${"project fact ".repeat(100)}`);
      const projected = await h.session.agent.transformContext!(h.session.agent.state.messages);
      const delta = projected.reduce((sum, message) => sum + estimateTokens(message), 0)
        - prior.reduce((sum, message) => sum + estimateTokens(message), 0);
      const current = await h.meter();
      expect(delta).toBeGreaterThan(900);
      expect(current.estimatedOverheadTokens - overhead).toBe(delta);
      expect(current.usedTokens).toBeGreaterThan(before.usedTokens);
      await h.session.agent.transformContext!(h.session.agent.state.messages);
      expect((await h.meter()).estimatedOverheadTokens).toBe(current.estimatedOverheadTokens);
      prior = projected; overhead = current.estimatedOverheadTokens;
    }
    expect(prior.filter((message) => message.role === "custom" && message.customType === "pum.subagent_capacity")).toHaveLength(7);
    expect(h.manager.getEntries()).toEqual(durable);
    expect(readFileSync(h.manager.getSessionFile()!, "utf8")).toBe(file);
    expect(readdirSync(join(h.root, "sessions")).sort()).toEqual(files);
    await h.prompt("Obtain new provider usage baseline");
    expect((await h.meter()).estimatedOverheadTokens).toBe(0);
    expectPrivate(h);
  });

  test("explicit no-summary rollover consolidates notices and memory without rewriting durable history; resume retains boundary", async () => {
    const h = await fixture();
    h.changeMemory("SDK_PRIVATE_OLD");
    await h.prompt("ARCHIVED_OPERATIONAL_INSTRUCTION");
    h.setActive(2); h.setPolicy("on"); h.changeMemory("SDK_PRIVATE_CURRENT");
    await h.prompt();
    const durable = structuredClone(h.manager.getEntries());
    h.replies.push([call("roll", "new_context", { handoff: "EXACT_OPERATIONAL_HANDOFF" })], text("Fresh answer"));
    const count = h.requests.length;
    await h.session.prompt("Roll now");
    expect(h.requests).toHaveLength(count + 2); // No hidden model summary request.
    const fresh = h.requests.at(-1)!;
    expect(notices(fresh)).toHaveLength(1);
    expect(notices(fresh, POLICY)).toHaveLength(1);
    expect(notices(fresh, "PUM project memory")).toHaveLength(1);
    expect(JSON.stringify(notices(fresh))).toContain("all 2 slots are active");
    expect(JSON.stringify(fresh)).toContain("SDK_PRIVATE_CURRENT");
    expect(JSON.stringify(fresh)).toContain("EXACT_OPERATIONAL_HANDOFF");
    expect(JSON.stringify(fresh)).not.toContain("SDK_PRIVATE_OLD");
    expect(JSON.stringify(fresh)).not.toContain("ARCHIVED_OPERATIONAL_INSTRUCTION");
    expect(h.manager.getEntries().slice(0, durable.length)).toEqual(durable);
    expect(h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_WINDOW_CUSTOM_TYPE)).toHaveLength(1);
    expect(h.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
    expect(JSON.stringify(h.manager.getEntries())).toContain("ARCHIVED_OPERATIONAL_INSTRUCTION");
    expectPrivate(h);
    const file = h.manager.getSessionFile()!;
    h.session.dispose(); sessions.splice(sessions.indexOf(h.session), 1);
    const resumed = await fixture({ root: h.root, resume: file });
    const next = await resumed.prompt("After runtime replacement");
    expect(notices(next)).toHaveLength(1);
    expect(JSON.stringify(notices(next))).toContain("slots are available");
    expect(JSON.stringify(next)).not.toContain("all 2 slots are active");
    expect(JSON.stringify(next)).not.toContain("ARCHIVED_OPERATIONAL_INSTRUCTION");
    expect(JSON.stringify(next)).toContain("EXACT_OPERATIONAL_HANDOFF");
    expectPrivate(resumed);
  });

  test("real manager extension registers capacity only for main/mutable workers, never internal/readonly roles", () => {
    // Capture factories only: no worker spawn, runtime, filesystem, or provider.
    const manager = new SubagentManager({ modelRuntime: {} as ModelRuntime, agentDir: "/unused" });
    const inspect = (extension: InlineExtension) => {
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const api = { registerTool() {}, on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      } } as unknown as ExtensionAPI;
      if (typeof extension === "function") extension(api);
      else extension.factory(api);
      return handlers;
    };
    expect(inspect(manager.mainExtension()).get("context")).toHaveLength(1);
    for (const [role, readonly, allowed] of [["worker", false, true], ["worker", true, false],
      ["judge", false, false], ["afk", false, false]] as const) {
      const id = `${role}-${readonly}`;
      (manager as any).records.set(id, { snapshot: { id, role, readonly } });
      const handlers = inspect((manager as any).childExtension(id));
      expect(handlers.get("context")?.length ?? 0).toBe(allowed ? 1 : 0);
    }
    // Headless deliberately never installs delegation, rather than relying on
    // a projection's text to restrict authority. This is a wiring assertion.
    const headless = readFileSync(join(import.meta.dir, "../src/headless.ts"), "utf8");
    expect(headless).not.toContain("buildSubagentCapacityPrompt");
    expect(headless).not.toContain("pum.subagent_capacity");
    expect(headless).not.toContain(".mainExtension()");
  });
});

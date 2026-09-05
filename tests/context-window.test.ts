import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CONTEXT_HANDOFF_MAX_CHARS, CONTEXT_TOOL_NAMES, CONTEXT_WINDOW_CUSTOM_TYPE, ContextWindowController } from "../src/context-window";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "pum-context-window-")); roots.push(path); return path; };
const model = (id = "one", contextWindow = 100_000) => ({ id, name: id, provider: "test", api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as any;
const assistant = (calls: Array<{ id: string; name: string }> = [], overrides: Record<string, unknown> = {}) => ({
  role: "assistant", content: calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
  api: "openai-completions", provider: "test", model: "one", timestamp: Date.now(), stopReason: calls.length ? "toolUse" : "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...overrides,
}) as any;
const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const result = (id: string, name = "new_context", isError = false) => ({ role: "toolResult" as const, toolCallId: id, toolName: name, content: [{ type: "text" as const, text: "result" }], isError, timestamp: Date.now() });

function harness(manager = SessionManager.inMemory(), settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1000 } }), transformContext?: Agent["transformContext"]) {
  const controller = new ContextWindowController();
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const extension = controller.extension();
  if (typeof extension === "function") throw new Error("Expected named inline extension");
  extension.factory({ on: (event: string, handler: Function) => handlers.set(event, handler), registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  const agent = new Agent({ transformContext, streamFn: (() => { throw new Error("This harness does not stream"); }) as any, initialState: { model: model(), systemPrompt: "Current system instructions.", messages: manager.buildSessionContext().messages } });
  const priorTurns: any[] = [];
  agent.prepareNextTurnWithContext = (turn) => { priorTurns.push(turn); return { context: { ...turn.context, systemPrompt: "dynamic prompt", tools: agent.state.tools }, model: agent.state.model }; };
  const compactions: unknown[] = [];
  const compactResult = { summary: "Native compact result", firstKeptEntryId: "kept", tokensBefore: 10 };
  const session = { agent, settingsManager: settings, sessionManager: manager,
    async compact(...args: unknown[]) { compactions.push({ receiver: this, args }); return compactResult; },
    get model() { return agent.state.model; } } as unknown as AgentSession;
  controller.bind(session);
  const execute = (name: string, args: unknown = {}, id = "roll", signal?: AbortSignal) => tools.get(name).execute(id, args, signal, undefined, { sessionManager: manager });
  const end = (message: any, results: any[], signal?: AbortSignal) => {
    manager.appendMessage(message); agent.state.messages.push(message);
    for (const output of results) { manager.appendMessage(output); agent.state.messages.push(output); }
    handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: results }, { signal });
  };
  const roll = async (handoff?: string, id = "roll") => { await execute("new_context", handoff === undefined ? {} : { handoff }, id); end(assistant([{ id, name: "new_context" }]), [result(id)]); };
  const boundaries = () => manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_WINDOW_CUSTOM_TYPE);
  // Use real public Agent events so usage is paired with an actual request.
  const respond = async (overrides: Record<string, unknown> = {}) => {
    agent.streamFunction = () => {
      const message = assistant([], { model: agent.state.model.id, ...overrides });
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    await agent.prompt("Meter request");
  };
  return { controller, handlers, tools, agent, session, manager, settings, priorTurns, execute, end, roll, boundaries,
    respond, compactions, compactResult };
}

describe("context-window lifecycle", () => {
  test("exports the fixed core tool identities", () => {
    expect(CONTEXT_TOOL_NAMES).toEqual(["history", "get_context_remaining", "new_context"]);
    expect([...harness().tools.keys()]).toEqual([...CONTEXT_TOOL_NAMES]);
  });

  test("two rollovers and disk resume preserve every transcript entry, file, session ID, and tool pair", async () => {
    const directory = root();
    const manager = SessionManager.create(directory, directory);
    const originalUserId = manager.appendMessage(user("Exact original instruction."));
    // SessionManager starts writing after the first assistant message.
    manager.appendMessage(assistant([], { content: [{ type: "text", text: "Original answer." }] }));
    const file = manager.getSessionFile()!;
    const sessionId = manager.getSessionId();
    const original = manager.getEntries().map((entry) => JSON.stringify(entry));
    const h = harness(manager);
    await h.roll("Literal first handoff", "first");
    manager.appendMessage(user("Second-window instruction"));
    h.agent.state.messages.push(user("Second-window instruction"));
    await h.roll("Literal second handoff", "second");
    const after = manager.appendMessage(user("After latest boundary"));
    expect(h.boundaries()).toHaveLength(2);
    expect(manager.getEntries().slice(0, original.length).map((entry) => JSON.stringify(entry))).toEqual(original);
    expect(manager.getEntry(originalUserId)).toBeDefined();
    expect(manager.getEntry(after)).toBeDefined();
    expect(manager.getSessionFile()).toBe(file);
    expect(manager.getSessionId()).toBe(sessionId);
    expect(h.agent.state.messages).toHaveLength(1);
    expect(JSON.stringify(h.agent.state.messages)).toContain("Literal second handoff");
    expect(JSON.stringify(h.agent.state.messages)).not.toContain("Literal first handoff");
    const reopened = SessionManager.open(file);
    const resumed = harness(reopened);
    expect(reopened.getSessionId()).toBe(sessionId);
    expect(reopened.getSessionFile()).toBe(file);
    expect(reopened.getEntries()).toEqual(manager.getEntries());
    expect(JSON.stringify(resumed.agent.state.messages)).toContain("After latest boundary");
    expect(JSON.stringify(resumed.agent.state.messages)).not.toContain("Exact original instruction");
    const calls = reopened.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(calls).toHaveLength(3);
    expect(reopened.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toContain("Exact original instruction.");
  });

  test("the inner loop receives fresh state through the previous public refresh hook", async () => {
    const h = harness();
    h.agent.state.messages.push(user("old window"));
    const old = h.agent.state.messages.slice();
    await h.roll("carry this");
    // A queued custom message may be flushed by pi after turn_end.
    h.agent.state.messages.push(user("steering message"));
    const update = await h.agent.prepareNextTurnWithContext!({ context: { messages: old, systemPrompt: "old", tools: [] }, message: assistant(), toolResults: [], newMessages: [] });
    expect(h.priorTurns[0].context.messages).toEqual(h.agent.state.messages);
    expect(update?.context?.systemPrompt).toBe("dynamic prompt");
    expect(JSON.stringify(update?.context?.messages)).not.toContain("old window");
    expect(JSON.stringify(update?.context?.messages)).toContain("steering message");
    expect(h.agent.state.messages.some((message) => message.role === "toolResult")).toBe(false);
  });

  test("restoration follows only the current branch", async () => {
    const manager = SessionManager.inMemory();
    const ancestor = manager.appendMessage(user("Shared ancestor"));
    const first = harness(manager);
    await first.roll("branch A");
    manager.branch(ancestor);
    manager.appendMessage(user("Branch B"));
    const second = harness(manager);
    expect(JSON.stringify(second.agent.state.messages)).toContain("Shared ancestor");
    expect(JSON.stringify(second.agent.state.messages)).not.toContain("branch A");
    await second.roll("branch B handoff", "b");
    const resumed = harness(manager);
    expect(JSON.stringify(resumed.agent.state.messages)).toContain("branch B handoff");
    expect(JSON.stringify(resumed.agent.state.messages)).not.toContain("branch A");
    expect(manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(2);
  });

  test("later manual compaction is retained without resurrecting older-window entries", async () => {
    const manager = SessionManager.inMemory();
    const old = manager.appendMessage(user("Discard from active context only"));
    const h = harness(manager);
    await h.roll("handoff");
    manager.appendMessage(user("Kept recent text"));
    manager.appendCompaction("Manual summary", old, 1000);
    const resumed = harness(manager);
    expect(JSON.stringify(resumed.agent.state.messages)).toContain("Manual summary");
    expect(JSON.stringify(resumed.agent.state.messages)).toContain("Literal handoff supplied to new_context:\\nhandoff");
    expect(JSON.stringify(resumed.agent.state.messages)).toContain("Kept recent text");
    expect(JSON.stringify(resumed.agent.state.messages)).not.toContain("Discard from active context only");
    expect(manager.getEntry(old)).toBeDefined();
  });

  test("malformed boundary on tree navigation clears unfiltered SDK messages before reporting failure", () => {
    const h = harness();
    h.agent.state.messages.push(user("Must not leak from old window"));
    h.manager.appendCustomEntry(CONTEXT_WINDOW_CUSTOM_TYPE, { version: 99 });
    expect(() => h.handlers.get("session_tree")!({})).toThrow();
    expect(h.agent.state.messages).toEqual([]);
  });

  test("malformed latest boundaries fail closed instead of restoring an earlier window", () => {
    for (const data of [{ version: 2 }, { version: 1, handoff: 8 }, { version: 1, handoff: "x".repeat(20_001) }, { version: 1, unknown: true }]) {
      const manager = SessionManager.inMemory();
      manager.appendMessage(user("Do not expose through malformed boundary"));
      manager.appendCustomEntry(CONTEXT_WINDOW_CUSTOM_TYPE, data);
      expect(() => harness(manager)).toThrow();
    }
  });
});

describe("full-batch transaction", () => {
  test("an append failure leaves the original active branch and messages intact", async () => {
    const h = harness();
    const append = h.manager.appendCustomEntry.bind(h.manager);
    h.manager.appendCustomEntry = (type, data) => { append(type, data); throw new Error("disk failure"); };
    await h.execute("new_context");
    expect(() => h.end(assistant([{ id: "roll", name: "new_context" }]), [result("roll")])).toThrow("disk failure");
    expect(h.manager.getLeafEntry()?.type).toBe("message");
    expect(h.manager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
    expect(h.agent.state.messages.some((message) => message.role === "toolResult")).toBe(true);
    const original = h.agent.state.messages.slice();
    const update = await h.agent.prepareNextTurnWithContext!({ context: { messages: original, tools: [], systemPrompt: "before" }, message: assistant(), toolResults: [], newMessages: [] });
    expect(update?.context?.messages).toEqual(original);
  });

  test("empty handoff provides stable IDs to recover exact instructions without a search query", async () => {
    const h = harness();
    const id = h.manager.appendMessage(user("Find me by stable ID"));
    await h.roll();
    const text = (h.agent.state.messages[0] as any).content;
    expect(text).toContain(`latest prior user entry ID: ${id}`);
    const recovered = await h.execute("history", { op: "read", entryId: id });
    expect(recovered.details.text).toBe("Find me by stable ID");
  });

  test("queues without committing and commits only after every sibling result succeeds", async () => {
    const h = harness();
    await h.execute("new_context", { handoff: "literal" });
    expect(h.boundaries()).toHaveLength(0);
    h.end(assistant([{ id: "roll", name: "new_context" }, { id: "read", name: "read" }]), [result("roll"), result("read", "read")]);
    expect(h.boundaries()).toHaveLength(1);
    expect(h.manager.getEntries().at(-1)?.type).toBe("custom");
  });

  test("sibling failure, missing/duplicate results, abort, and assistant failure never commit", async () => {
    const cases = [
      { outputs: [result("roll"), result("sibling", "read", true)] },
      { outputs: [result("roll")] },
      { outputs: [result("roll"), result("roll")] },
      { outputs: [result("roll"), result("sibling", "read")], stopReason: "error" },
      { outputs: [result("roll"), result("sibling", "read")], stopReason: "aborted" },
      { outputs: [result("roll"), result("sibling", "read")], stopReason: "length" },
      { outputs: [result("roll", "new_context", true), result("sibling", "read")] },
      { outputs: [result("roll"), result("sibling", "read")], abort: true },
    ];
    for (const scenario of cases) {
      const h = harness();
      const abort = new AbortController();
      await h.execute("new_context", {}, "roll", abort.signal);
      if (scenario.abort) abort.abort();
      h.end(assistant([{ id: "roll", name: "new_context" }, { id: "sibling", name: "read" }], scenario.stopReason ? { stopReason: scenario.stopReason } : {}), scenario.outputs);
      expect(h.boundaries()).toHaveLength(0);
      // A failed turn cannot leave a request that commits with a later batch.
      h.end(assistant([{ id: "roll", name: "new_context" }]), [result("roll")]);
      expect(h.boundaries()).toHaveLength(0);
      await h.roll(undefined, "later");
      expect(h.boundaries()).toHaveLength(1);
    }
  });

  test("duplicate invocations invalidate the batch even if both results claim success", async () => {
    const h = harness();
    await h.execute("new_context", {}, "first");
    await expect(h.execute("new_context", {}, "second")).rejects.toThrow("Only one");
    h.end(assistant([{ id: "first", name: "new_context" }, { id: "second", name: "new_context" }]), [result("first"), result("second")]);
    expect(h.boundaries()).toHaveLength(0);
    await h.roll(undefined, "next");
    expect(h.boundaries()).toHaveLength(1);
  });

  test("commit revalidates capacity after a model change during sibling execution", async () => {
    const h = harness();
    await h.execute("new_context", { handoff: "x".repeat(15_000) });
    h.agent.state.model = model("tiny", 2048);
    expect(() => h.end(assistant([{ id: "roll", name: "new_context" }]), [result("roll")])).toThrow("do not fit");
    expect(h.boundaries()).toHaveLength(0);
    expect(h.agent.state.messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  test("agent end clears an uncommitted request", async () => {
    const h = harness();
    await h.execute("new_context");
    h.handlers.get("agent_end")!({ messages: [] });
    h.end(assistant([{ id: "roll", name: "new_context" }]), [result("roll")]);
    expect(h.boundaries()).toHaveLength(0);
  });

  test("handoffs are literal and bounded by both characters and fresh capacity", async () => {
    const h = harness();
    for (const invalid of [null, [], { handoff: 1 }, { summary: "wrong" }, { handoff: "x".repeat(CONTEXT_HANDOFF_MAX_CHARS + 1) }]) {
      await expect(h.execute("new_context", invalid)).rejects.toThrow();
    }
    h.agent.state.model = model("tiny", 1100);
    await expect(h.execute("new_context", { handoff: "x".repeat(1000) })).rejects.toThrow("do not fit");
    h.agent.state.model = model();
    const literal = "  ${do not expand}\n[not a generated summary]  ";
    await h.roll(literal);
    expect((h.boundaries()[0] as any).data.handoff).toBe(literal);
    expect(JSON.stringify(h.agent.state.messages)).toContain(JSON.stringify(literal).slice(1, -1));
  });
});

describe("capacity and compaction policy", () => {
  test("counts cache usage, estimates trailing messages, and clamps both remaining capacities", async () => {
    const h = harness();
    await h.respond({ usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 10, totalTokens: 130 } });
    let meter = (await h.execute("get_context_remaining")).details;
    expect(meter.providerUsageTokens).toBe(210);
    expect(meter.remainingTokens).toBe(100_000 - 210);
    h.agent.state.messages.push(user("a".repeat(800)));
    meter = (await h.execute("get_context_remaining")).details;
    expect(meter.source).toBe("provider_usage_plus_estimate");
    expect(meter.usedTokens).toBeGreaterThan(210);
    await h.respond({ usage: { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 200_000 } });
    meter = (await h.execute("get_context_remaining")).details;
    expect(meter.remainingTokens).toBe(0);
    expect(meter.remainingBeforeReserve).toBe(0);
  });

  test("rollover and model switches discard stale provider usage", async () => {
    const h = harness();
    await h.respond({ usage: { input: 80_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 80_100 } });
    expect((await h.execute("get_context_remaining")).details.providerUsageTokens).toBe(80_100);
    h.agent.state.model = model("two");
    expect((await h.execute("get_context_remaining")).details.source).toBe("estimate");
    h.agent.state.model = model();
    expect((await h.execute("get_context_remaining")).details.source).toBe("estimate");
    await h.roll();
    const meter = (await h.execute("get_context_remaining")).details;
    expect(meter.source).toBe("estimate");
    expect(meter.providerUsageTokens).toBe(0);
    expect(meter.usedTokens).toBeLessThan(1000);
  });

  test("request overhead is not counted twice and only positive component growth is added", async () => {
    const h = harness();
    h.agent.state.systemPrompt = "s".repeat(4000);
    await h.respond({ usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2100 } });
    const meter = async () => (await h.execute("get_context_remaining")).details;
    expect((await meter()).usedTokens).toBe(2100);
    expect((await meter()).estimatedOverheadTokens).toBe(0);
    h.agent.state.systemPrompt += "g".repeat(800);
    expect((await meter()).usedTokens).toBe(2300);
    expect((await meter()).source).toBe("provider_usage_plus_estimate");
    h.agent.state.systemPrompt = "short";
    expect((await meter()).usedTokens).toBe(2100);
    h.agent.state.tools = [{ name: "revealed", description: "tool".repeat(500), parameters: { type: "object" } } as any];
    const expanded = await meter();
    expect(expanded.usedTokens).toBeGreaterThan(2600);
    expect(expanded.estimatedOverheadTokens).toBeGreaterThan(500);
    expect(expanded.note).toContain("Conservative estimates");
    // The next measured request incorporates the new schema; no old growth stays.
    await h.respond({ usage: { input: 3000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 3100 } });
    expect((await meter()).usedTokens).toBe(3100);
    expect((await meter()).estimatedOverheadTokens).toBe(0);
  });

  test("request baselines use the effective public next-turn prompt rather than stale agent state", async () => {
    const h = harness();
    h.agent.state.systemPrompt = "stale state prompt".repeat(1000);
    const meters: any[] = [];
    h.agent.state.tools = [{ name: "measure", description: "Measure", parameters: { type: "object" },
      async execute() {
        meters.push((await h.execute("get_context_remaining")).details);
        return { content: [{ type: "text", text: "measured" }], details: {} };
      },
    } as any];
    const contents = [[{ id: "first", name: "measure" }], [{ id: "second", name: "measure" }], []];
    const prompts: string[] = [];
    h.agent.streamFunction = (_model, context) => {
      prompts.push(context.systemPrompt ?? "");
      const message = assistant(contents.shift(), { usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5000 } });
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    };
    await h.agent.prompt("request");
    expect(prompts[0]).toBe(h.agent.state.systemPrompt);
    expect(prompts[1]).toBe("dynamic prompt");
    expect(meters.map((meter) => meter.usedTokens)).toEqual([5000, 5000]);
    expect(meters.map((meter) => meter.estimatedOverheadTokens)).toEqual([0, 0]);
  });

  test("changing the same model's capacity invalidates measured usage, including a switch back", async () => {
    const h = harness();
    await h.respond({ usage: { input: 80_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 80_000 } });
    h.agent.state.model = model("one", 90_000);
    expect((await h.execute("get_context_remaining")).details.source).toBe("estimate");
    h.agent.state.model = model();
    expect((await h.execute("get_context_remaining")).details.source).toBe("estimate");
    await h.respond({ usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 200 } });
    expect((await h.execute("get_context_remaining")).details.source).toBe("provider_usage");
    await h.roll("next window");
    expect((await h.execute("get_context_remaining")).details.providerUsageTokens).toBe(0);
  });

  test("restored provider usage without a request snapshot is a full estimate", async () => {
    const h = harness();
    h.agent.state.messages.push(assistant([], { usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } }));
    h.agent.state.systemPrompt = "new effective prompt".repeat(1000);
    const meter = (await h.execute("get_context_remaining")).details;
    expect(meter.source).toBe("estimate");
    expect(meter.providerUsageTokens).toBe(0);
    expect(meter.estimatedOverheadTokens).toBeGreaterThan(1000);
  });

  test("injected context is included once and later observed growth remains conservative", async () => {
    let memory = user("m".repeat(4000));
    const h = harness(undefined, undefined, async (messages) => [memory, ...messages]);
    await h.respond({ usage: { input: 2000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2000 } });
    expect((await h.execute("get_context_remaining")).details.usedTokens).toBe(2000);
    memory = user("m".repeat(8000));
    await h.agent.transformContext!(h.agent.state.messages);
    const grown = (await h.execute("get_context_remaining")).details;
    expect(grown.usedTokens).toBe(3000);
    expect(grown.estimatedOverheadTokens).toBe(1000);
    memory = user("short");
    await h.agent.transformContext!(h.agent.state.messages);
    expect((await h.execute("get_context_remaining")).details.usedTokens).toBe(2000);
  });

  test("negative or nonfinite saved reserves cannot increase hard capacity", async () => {
    for (const reserveTokens of [-100_000, Infinity, NaN]) {
      const h = harness(undefined, SettingsManager.inMemory({ compaction: { reserveTokens } }));
      // JSON-backed SDK settings normalize nonfinite numbers to null. Also cover
      // malformed values from a public settings accessor without that round trip.
      const settings = h.settings.getCompactionSettings.bind(h.settings);
      h.settings.getCompactionSettings = () => ({ ...settings(), reserveTokens });
      h.agent.state.model = model("small", 2048);
      const meter = (await h.execute("get_context_remaining")).details;
      expect(meter.reserveTokens).toBe(0);
      expect(meter.remainingBeforeReserve).toBe(meter.remainingTokens);
      await expect(h.execute("new_context", { handoff: "x".repeat(9000) })).rejects.toThrow("do not fit");
    }
  });

  test("resume ignores usage before the latest persisted model change", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(assistant([], { usage: { input: 80_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 80_000 } }));
    manager.appendModelChange("test", "two");
    manager.appendModelChange("test", "one");
    const h = harness(manager);
    expect((await h.execute("get_context_remaining")).details.source).toBe("estimate");
  });

  test("small models can roll over and recover history when the default reserve exceeds capacity", async () => {
    const h = harness(undefined, SettingsManager.inMemory());
    h.agent.state.model = model("small", 8192);
    const userId = h.manager.appendMessage(user("Small-model exact user instructions"));
    await h.roll();
    const meter = (await h.execute("get_context_remaining")).details;
    expect(meter.reserveExceedsCapacity).toBe(true);
    expect(meter.remainingBeforeReserve).toBe(0);
    expect(meter.remainingTokens).toBeGreaterThan(0);
    const recovered = await h.execute("history", { op: "read", entryId: userId });
    expect(recovered.details.text).toBe("Small-model exact user instructions");
  });

  test("public transformContext wrapper preserves later memory injection and observes its overhead", async () => {
    const memory = user("m".repeat(4000));
    const h = harness(undefined, undefined, async (messages) => [memory, ...messages]);
    const before = (await h.execute("get_context_remaining")).details.estimatedOverheadTokens;
    const transformed = await h.agent.transformContext!([user("current")]);
    expect(transformed[0]).toBe(memory);
    const after = (await h.execute("get_context_remaining")).details.estimatedOverheadTokens;
    expect(after - before).toBeGreaterThanOrEqual(1000);
  });

  test("manual compaction does not reuse usage from kept older assistant messages", async () => {
    const manager = SessionManager.inMemory();
    const h = harness(manager);
    await h.roll();
    const old = manager.appendMessage(assistant([], { usage: { input: 80_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 80_000 } }));
    manager.appendCompaction("Manual summary", old, 80_000);
    const resumed = harness(manager);
    const meter = (await resumed.execute("get_context_remaining")).details;
    expect(meter.source).toBe("estimate");
    expect(meter.providerUsageTokens).toBe(0);
  });

  test("unknown models, invalid usage, and prompt/tool overhead remain explicit estimates", async () => {
    const h = harness();
    h.agent.state.tools = [{ name: "tool", description: "Description".repeat(100), parameters: { type: "object" } } as any];
    h.agent.state.messages.push(assistant([], { usage: { input: NaN, output: -1, cacheRead: 0, cacheWrite: 0, totalTokens: Infinity } }));
    h.agent.state.messages.push(assistant([], { usage: undefined }));
    const meter = (await h.execute("get_context_remaining")).details;
    expect(meter.source).toBe("estimate");
    expect(meter.estimatedOverheadTokens).toBeGreaterThan(250);
    h.agent.state.model = undefined as any;
    expect((await h.execute("get_context_remaining")).details.remainingTokens).toBeNull();
    await expect(h.execute("get_context_remaining", { path: "other-session" })).rejects.toThrow();
  });

  test("public manual compact delegates before rollover, refuses after, and follows the active branch", async () => {
    const h = harness();
    const ancestor = h.manager.appendMessage(user("before boundary"));
    expect(await h.session.compact("literal native instructions")).toBe(h.compactResult as any);
    expect(h.compactions).toEqual([{ receiver: h.session, args: ["literal native instructions"] }]);
    await h.roll("retain this handoff");
    const entries = structuredClone(h.manager.getEntries());
    const messages = structuredClone(h.agent.state.messages);
    await expect(h.session.compact()).rejects.toThrow("Use new_context instead. The full transcript is retained.");
    expect(h.compactions).toHaveLength(1);
    expect(h.manager.getEntries()).toEqual(entries);
    expect(h.agent.state.messages).toEqual(messages);
    expect(h.handlers.get("session_before_compact")!({ reason: "manual" })).toEqual({ cancel: true });
    h.manager.branch(ancestor);
    h.handlers.get("session_tree")!({});
    expect(await h.session.compact()).toBe(h.compactResult as any);
    expect(h.compactions).toHaveLength(2);
    expect(h.handlers.get("session_before_compact")!({ reason: "manual" })).toBeUndefined();
  });

  test("automatic compaction overrides never persist, reload reapplies them, and manual compact is not cancelled", () => {
    const directory = root();
    const path = join(directory, "settings.json");
    const contents = JSON.stringify({ compaction: { enabled: true, reserveTokens: 500 } });
    writeFileSync(path, contents);
    const settings = SettingsManager.create(directory, directory);
    const h = harness(SessionManager.inMemory(), settings);
    expect(settings.getCompactionSettings().enabled).toBe(false);
    expect(settings.getCompactionSettings().reserveTokens).toBe(500);
    expect(readFileSync(path, "utf8")).toBe(contents);
    settings.reload();
    expect(settings.getCompactionEnabled()).toBe(false);
    expect(settings.getCompactionSettings().enabled).toBe(false);
    settings.setDefaultThinkingLevel("low");
    expect(settings.getCompactionEnabled()).toBe(false);
    expect(settings.getCompactionSettings().enabled).toBe(false);
    h.handlers.get("before_agent_start")!({ systemPrompt: "Keep dynamic instructions" });
    expect(settings.getCompactionSettings().enabled).toBe(false);
    const beforeCompact = h.handlers.get("session_before_compact")!;
    expect(beforeCompact({ reason: "manual" })).toBeUndefined();
    expect(beforeCompact({ reason: "threshold" })).toEqual({ cancel: true });
    expect(beforeCompact({ reason: "overflow" })).toEqual({ cancel: true });
    expect(JSON.parse(readFileSync(path, "utf8")).compaction.enabled).toBe(true);
    const prompt = h.handlers.get("before_agent_start")!({ systemPrompt: "Keep dynamic instructions" }).systemPrompt;
    expect(prompt).toContain("Keep dynamic instructions");
    expect(prompt).toContain("not an automatic rollover threshold");
    expect(prompt).not.toContain("remainingTokens");
  });
});

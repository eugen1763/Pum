import { afterEach, describe, expect, test } from "bun:test";
import {
  bindSearchSession,
  SEARCH_STATE_CUSTOM_TYPE,
  webSearch,
  wrapProvider,
  type SearchSessionRole,
} from "../src/web-search";
import { CONTEXT_WINDOW_CUSTOM_TYPE, ContextWindowController } from "../src/context-window";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { estimateContextMessage as estimateTokens } from "../src/context-estimate";

const readTool = { type: "function", name: "read" };
const hostedTool = { type: "web_search" };
const user = (text = "hello") => ({ role: "user", content: text, timestamp: 1 });
const notices = (messages: any[]) => messages.filter((message) => message.customType === SEARCH_STATE_CUSTOM_TYPE);

function harness(role: SearchSessionRole | undefined = "main", inner?: (messages: any[], signal?: AbortSignal) => Promise<any[]>, unknownRole = false) {
  if (unknownRole) role = undefined;
  const requests: any[] = [];
  const provider = wrapProvider({ streamSimple: (_model: any, _context: any, options: any) => {
    requests.push(options);
    return {};
  } } as any);
  const state = { cwd: "/project", branch: [] as any[] };
  const session = {
    sessionId: `session-${role}`,
    sessionManager: { getCwd: () => state.cwd, getBranch: () => state.branch },
    dispose() {},
    agent: {
      state: { systemPrompt: "stable instructions" },
      transformContext: inner,
      streamFunction: (model: any, context: any, options: any) => provider.streamSimple(model, context, options),
    },
  };
  bindSearchSession(session as any, role);
  return {
    session, state,
    prepare: (messages: any[] = [user()], signal?: AbortSignal) => session.agent.transformContext!(messages, signal),
    request(onPayload?: (payload: any) => any) {
      session.agent.streamFunction({} as any, {} as any, { sessionId: session.sessionId, onPayload });
      const hook = requests.at(-1).onPayload;
      return async (body: any = { tools: [readTool] }) => (await hook(body, {})) ?? body;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("request-bound hosted search state", () => {
  afterEach(() => { webSearch.enabled = false; });

  test.each(["main", "worker"] as const)("%s requires a successful context boundary, not binding alone", async (role) => {
    webSearch.enabled = true;
    const h = harness(role);
    expect((await h.request()({ tools: [readTool, hostedTool] })).tools).toEqual([readTool]);
    await h.prepare();
    expect((await h.request()()).tools).toEqual([readTool, hostedTool]);
  });

  test("enable after context preparation cannot grant a request whose notice says disabled", async () => {
    webSearch.enabled = false;
    const h = harness();
    const disabled = await h.prepare();
    expect(notices(disabled).at(-1).content).toContain("disabled for this request");
    // Represents async conversion/authentication between context and stream.
    webSearch.enabled = true;
    expect((await h.request()()).tools).toEqual([readTool]);
    const enabled = await h.prepare([user(), user("next request")]);
    expect(notices(enabled).at(-1).content).toContain("enabled for this request");
    expect((await h.request()()).tools).toEqual([readTool, hostedTool]);
  });

  test("capture and notice follow the complete awaited inner context chain", async () => {
    webSearch.enabled = false;
    const gate = deferred();
    const h = harness("main", async (messages) => { await gate.promise; return messages; });
    const preparing = h.prepare();
    webSearch.enabled = true;
    // A stream attempted before successful preparation still fails closed.
    expect((await h.request()()).tools).toEqual([readTool]);
    gate.resolve();
    const prepared = await preparing;
    expect(notices(prepared).at(-1).content).toContain("enabled for this request");
    expect((await h.request()()).tools).toEqual([readTool, hostedTool]);
  });

  test("disable during an awaited payload hook strips search; already dispatched bytes cannot be retracted", async () => {
    webSearch.enabled = true;
    const h = harness();
    await h.prepare();
    const alreadyDispatched = JSON.stringify(await h.request()());
    const gate = deferred();
    const pending = h.request(async (body) => {
      await gate.promise;
      return { ...body, tagged: true, tools: [readTool, hostedTool] };
    })();
    webSearch.enabled = false;
    gate.resolve();
    expect(await pending).toEqual({ tagged: true, tools: [readTool] });
    expect(JSON.parse(alreadyDispatched).tools).toEqual([readTool, hostedTool]);
    expect((await h.request()()).tools).toEqual([readTool]);
  });

  test("a disable epoch prevents re-enable from reviving old hooks or transport retries", async () => {
    webSearch.enabled = true;
    const h = harness();
    await h.prepare();
    const oldRequest = h.request();
    expect((await oldRequest()).tools).toEqual([readTool, hostedTool]);
    webSearch.enabled = false;
    webSearch.enabled = true;
    expect((await oldRequest()).tools).toEqual([readTool]);
    expect((await h.request()()).tools).toEqual([readTool]);
    // An SDK request that actually re-prepares context may observe the new grant.
    await h.prepare();
    expect((await h.request()()).tools).toEqual([readTool, hostedTool]);
    expect((await oldRequest()).tools).toEqual([readTool]);
  });

  test("same-state assignments do not revoke an unchanged prepared request", async () => {
    webSearch.enabled = true;
    const h = harness();
    await h.prepare();
    const request = h.request();
    webSearch.enabled = true;
    expect((await request()).tools).toEqual([readTool, hostedTool]);
  });

  test("a request keeps its capture when another request prepares newer context", async () => {
    webSearch.enabled = false;
    const h = harness();
    await h.prepare();
    const oldRequest = h.request();
    webSearch.enabled = true;
    await h.prepare([user(), user("new request")]);
    const newRequest = h.request();
    expect((await oldRequest()).tools).toEqual([readTool]);
    expect((await newRequest()).tools).toEqual([readTool, hostedTool]);
  });

  test("concurrent runtimes must each prepare their own effective grant", async () => {
    webSearch.enabled = false;
    const main = harness();
    const worker = harness("worker");
    await main.prepare();
    await worker.prepare();
    webSearch.enabled = true;
    await main.prepare();
    expect((await main.request()()).tools).toEqual([readTool, hostedTool]);
    expect((await worker.request()()).tools).toEqual([readTool]);
    await worker.prepare();
    expect((await worker.request()()).tools).toEqual([readTool, hostedTool]);
  });

  test.each(["readonly", "judge", "afk", undefined, "unknown"])("role %s has no invitation or inherited search authority", async (role) => {
    webSearch.enabled = true;
    const h = harness(role as SearchSessionRole, undefined, role === undefined);
    const prepared = await h.prepare();
    expect(notices(prepared).at(-1).content).toContain("unavailable for this runtime role");
    expect(notices(prepared).at(-1).content).not.toContain("enabled for this request");
    expect((await h.request((body) => ({ ...body, tools: [readTool, hostedTool] }))()).tools).toEqual([readTool]);
  });

  test("unchanged requests deduplicate and changed state appends without system or canonical mutation", async () => {
    webSearch.enabled = true;
    const h = harness();
    const source = [user()];
    const before = JSON.stringify(source);
    const first = await h.prepare(source);
    expect(notices(first)).toHaveLength(1);
    expect(await h.prepare(source)).toEqual(first);
    const result = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 };
    const next = [...source, { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 2 }, result];
    webSearch.enabled = false;
    const changed = await h.prepare(next);
    expect(changed.slice(0, first.length)).toEqual(first);
    expect(changed.at(-2)).toEqual(result);
    expect(changed.at(-1).customType).toBe(SEARCH_STATE_CUSTOM_TYPE);
    expect(notices(changed)).toHaveLength(2);
    expect(await h.prepare(next)).toEqual(changed);
    expect(JSON.stringify(source)).toBe(before);
    expect(h.session.agent.state.systemPrompt).toBe("stable instructions");
  });

  test("incomplete tool blocks cannot grant a relaxation before its matching notice can appear", async () => {
    webSearch.enabled = false;
    const h = harness();
    await h.prepare();
    webSearch.enabled = true;
    const source = [user(), { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 2 }];
    const pending = await h.prepare(source);
    expect(notices(pending)).toHaveLength(1);
    expect(notices(pending)[0].content).toContain("disabled for this request");
    expect((await h.request()()).tools).toEqual([readTool]);
    const completed = await h.prepare([...source, { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [], isError: false, timestamp: 3 }]);
    expect(notices(completed).at(-1).content).toContain("enabled for this request");
    expect((await h.request()()).tools).toEqual([readTool, hostedTool]);
  });

  test("rollover, directory, and branch-source changes reset private observations", async () => {
    webSearch.enabled = true;
    const h = harness();
    const source = [user()];
    await h.prepare(source);
    webSearch.enabled = false;
    const appended = [...source, user("again")];
    expect(notices(await h.prepare(appended))).toHaveLength(2);
    h.state.branch = [{ type: "custom", customType: CONTEXT_WINDOW_CUSTOM_TYPE, id: "fresh-window" }];
    expect(notices(await h.prepare(appended))).toHaveLength(1);
    webSearch.enabled = true;
    expect(notices(await h.prepare([...appended, user("third")]))).toHaveLength(2);
    h.state.cwd = "/another-project";
    expect(notices(await h.prepare([...appended, user("third")]))).toHaveLength(1);
    webSearch.enabled = false;
    expect(notices(await h.prepare([user("different branch")]))).toHaveLength(1);
  });

  test("failed or aborted preparation cannot leave an earlier grant active", async () => {
    webSearch.enabled = true;
    let fail = false;
    const h = harness("main", async (messages) => {
      if (fail) throw new Error("context failure");
      return messages;
    });
    await h.prepare();
    fail = true;
    await expect(h.prepare()).rejects.toThrow("context failure");
    expect((await h.request()()).tools).toEqual([readTool]);
    fail = false;
    const abort = new AbortController();
    abort.abort();
    await h.prepare([user()], abort.signal);
    expect((await h.request()()).tools).toEqual([readTool]);
  });

  test("the outer context meter counts every private search notice exactly once", async () => {
    webSearch.enabled = true;
    const manager = SessionManager.inMemory("/project");
    manager.appendMessage(user() as any);
    const agent = new Agent({ streamFn: () => { throw new Error("Meter harness does not stream"); }, initialState: {
      systemPrompt: "stable instructions",
      model: { id: "test", provider: "test", api: "openai-completions", contextWindow: 100_000, maxTokens: 1000 } as any,
      messages: manager.buildSessionContext().messages,
    } });
    const session = {
      sessionId: manager.getSessionId(), sessionManager: manager, agent,
      settingsManager: SettingsManager.inMemory({ compaction: { reserveTokens: 1000 } }),
      get model() { return agent.state.model; },
      async compact() {}, dispose() {},
    } as unknown as AgentSession;
    const meter = new ContextWindowController();
    const tools = new Map<string, any>();
    const extension = meter.extension();
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
    // Match main/headless/managed runtime installation order.
    bindSearchSession(session, "main");
    meter.bind(session);
    const used = async () => (await tools.get("get_context_remaining").execute("meter", {})).details.usedTokens;
    const baseline = await used();
    const first = await agent.transformContext!(agent.state.messages);
    const firstNoticeTokens = notices(first).reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(firstNoticeTokens).toBeGreaterThan(0);
    expect(await used()).toBe(baseline + firstNoticeTokens);
    await agent.transformContext!(agent.state.messages);
    expect(await used()).toBe(baseline + firstNoticeTokens);
    webSearch.enabled = false;
    const changed = await agent.transformContext!(agent.state.messages);
    const allNoticeTokens = notices(changed).reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(notices(changed)).toHaveLength(2);
    expect(await used()).toBe(baseline + allNoticeTokens);
    expect(manager.getEntries().some((entry: any) => entry.customType === SEARCH_STATE_CUSTOM_TYPE)).toBe(false);
    expect(agent.state.messages.some((message: any) => message.customType === SEARCH_STATE_CUSTOM_TYPE)).toBe(false);
    session.dispose();
  });

  test("disposal invalidates outstanding payload hooks and future preparation", async () => {
    webSearch.enabled = true;
    const h = harness();
    await h.prepare();
    const request = h.request();
    h.session.dispose();
    expect((await request()).tools).toEqual([readTool]);
    await h.prepare();
    expect((await h.request()()).tools).toEqual([readTool]);
  });
});

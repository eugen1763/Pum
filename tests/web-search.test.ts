import { afterEach, describe, expect, test } from "bun:test";
import {
  bindSearchSession,
  revokeSearchSession,
  type SearchSessionRole,
  withSearchRoute,
  SearchCallRouter,
  SearchCallTracker,
  webSearch,
  webSearchArgument,
  wrapProvider,
} from "../src/web-search";

describe("web search arguments", () => {
  test("uses current and legacy search query fields", () => {
    expect(webSearchArgument({
      action: { type: "search", queries: ["first query", " ", "second query"] },
    })).toBe("first query · second query");
    expect(webSearchArgument({ action: { type: "search", query: "legacy query" } }))
      .toBe("legacy query");
  });

  test("shows page and find arguments without inspecting unrelated payload fields", () => {
    expect(webSearchArgument({ action: { type: "open_page", url: "https://example.com/page" } }))
      .toBe("https://example.com/page");
    expect(webSearchArgument({
      action: {
        type: "find_in_page",
        pattern: "release date",
        url: "https://example.com/page",
      },
    })).toBe("release date · https://example.com/page");
    expect(webSearchArgument({
      action: { type: "unknown", payload: "do not display", query: "also hidden" },
      secret: "do not display",
    })).toBe("");
  });

  test("updates a live call when a later frame supplies the argument", () => {
    const tracker = new SearchCallTracker();
    expect(tracker.accept({
      type: "response.output_item.added",
      item: { type: "web_search_call", id: "search-1", status: "in_progress" },
    })).toEqual({ phase: "start", id: "search-1", query: "" });
    expect(tracker.accept({
      type: "response.output_item.done",
      item: {
        type: "web_search_call",
        id: "search-1",
        status: "completed",
        action: { type: "search", queries: ["late query"] },
      },
    })).toEqual({ phase: "end", id: "search-1", query: "late query", ok: true });
  });

  test("retains an earlier argument when the completion frame omits the action", () => {
    const tracker = new SearchCallTracker();
    tracker.accept({
      type: "response.output_item.added",
      item: {
        type: "web_search_call",
        id: "search-2",
        action: { type: "open_page", url: "https://example.com" },
      },
    });
    expect(tracker.accept({
      type: "response.output_item.done",
      item: { type: "web_search_call", id: "search-2", status: "failed" },
    })).toEqual({
      phase: "end",
      id: "search-2",
      query: "https://example.com",
      ok: false,
    });
  });
});

describe("web search routing", () => {
  test("delivers calls only to the matching session route", () => {
    const router = new SearchCallRouter();
    const main: string[] = [];
    const child: string[] = [];
    router.subscribe("main-session", (call) => main.push(call.id));
    router.subscribe("child-session", (call) => child.push(call.id));

    router.emit("child-session", { phase: "start", id: "child-search", query: "child" });
    router.emit("main-session", { phase: "start", id: "main-search", query: "main" });

    expect(main).toEqual(["main-search"]);
    expect(child).toEqual(["child-search"]);
  });
});

/** Fake base provider that records the options each stream method receives. */
function recordingProvider(received: any[]): any {
  return {
    stream: (_m: any, _c: any, options: any) => {
      received.push(options);
      return {};
    },
    streamSimple: (_m: any, _c: any, options: any) => {
      received.push(options);
      return {};
    },
  };
}

// ModelRuntime/SDK copy the options object but retain the payload callback.
async function boundSession(provider: any, sessionId: string, role: SearchSessionRole, method = "streamSimple", prepare = true) {
  const session = {
    sessionId,
    agent: {
      transformContext: undefined as undefined | ((messages: any[], signal?: AbortSignal) => Promise<any[]>),
      streamFunction: (model: any, context: any, options: any) =>
        provider[method](model, context, { ...options }),
    },
  };
  bindSearchSession(session as any, role);
  if (prepare) await session.agent.transformContext!([]);
  return session;
}

const functionTool = { type: "function", name: "read" };

describe("web search provider wrapping", () => {
  afterEach(() => {
    webSearch.enabled = false;
  });

  test("retirement revokes only the exact bound runtime before SDK disposal, including same-ID replacement", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const provider = wrapProvider(recordingProvider(received));
    const old = await boundSession(provider, "same-canonical-session", "main");
    old.agent.streamFunction({}, {}, { sessionId: old.sessionId });
    const replacement = await boundSession(provider, old.sessionId, "main");
    replacement.agent.streamFunction({}, {}, { sessionId: replacement.sessionId });
    const oldBody = await received[0].onPayload({ tools: [functionTool] }, {});
    expect(oldBody.tools).toContainEqual({ type: "web_search" });
    revokeSearchSession({ sessionId: old.sessionId }); // IDs/ambient objects grant no revocation.
    expect(received[0].signal.aborted).toBe(false);
    revokeSearchSession(old);
    revokeSearchSession(old);
    expect(webSearch.enabled).toBe(true);
    expect(received[0].signal.aborted).toBe(true);
    expect(received[1].signal.aborted).toBe(false);
    expect(() => JSON.stringify({ ...oldBody, type: "response.create" })).toThrow("aborted");
    const denied = await received[0].onPayload({ tools: [functionTool, { type: "web_search" }] }, {});
    expect(denied.tools).toEqual([functionTool]);
    const allowed = await received[1].onPayload({ tools: [functionTool] }, {});
    expect(allowed.tools).toContainEqual({ type: "web_search" });
    await old.agent.transformContext!([]);
    old.agent.streamFunction({}, {}, { sessionId: old.sessionId });
    expect(received[2].signal.aborted).toBe(true);
    const freshDenied = await received[2].onPayload({ tools: [{ type: "web_search" }] }, {});
    expect(freshDenied.tools).toEqual([]);
    revokeSearchSession(replacement);
    expect(received[1].signal.aborted).toBe(true);
  });

  // Defect 1: the wrapper must chain, not overwrite, a pre-existing onPayload,
  // so pi's before_provider_request extension hook still runs on Codex.
  test("chains a provided onPayload and appends the search tool after it", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const wrapped = wrapProvider(recordingProvider(received));

    let baseCalled = false;
    const baseHook = (payload: any) => {
      baseCalled = true;
      return { ...payload, tagged: true };
    };
    const session = await boundSession(wrapped, "main", "main");
    session.agent.streamFunction({}, {}, { sessionId: "main", onPayload: baseHook });

    const chained = received[0].onPayload as (p: unknown, m: unknown) => Promise<any>;
    expect(typeof chained).toBe("function");
    const out = await chained({ tools: [] }, {});

    expect(baseCalled).toBe(true); // the user extension hook still ran
    expect(out.tagged).toBe(true); // its transform survived
    expect(out.tools).toEqual([{ type: "web_search" }]); // tool appended around it
  });

  // The base hook must still run (and its result be preserved) even when search
  // is off, so the extension hook is never disabled by the toggle.
  test("preserves the base hook result when search is off", async () => {
    webSearch.enabled = false;
    const received: any[] = [];
    const wrapped = wrapProvider(recordingProvider(received));

    const baseHook = (payload: any) => ({ ...payload, tagged: true });
    wrapped.streamSimple({} as any, {} as any, { onPayload: baseHook } as any);

    const chained = received[0].onPayload as (p: unknown, m: unknown) => Promise<any>;
    const out = await chained({ tools: [] }, {});
    expect(out.tagged).toBe(true);
    expect(out.tools).toEqual([]); // no hosted tool while search is off
  });

  test.each(["main", "worker"] as const)("authorizes %s on both stream methods", async (role) => {
    webSearch.enabled = true;
    for (const method of ["stream", "streamSimple"]) {
      const received: any[] = [];
      const prototype = { inheritedMethod: () => "preserved" };
      const base = Object.assign(Object.create(prototype), recordingProvider(received));
      const wrapped = wrapProvider(base);
      const session = await boundSession(wrapped, role, role, method);
      const signal = new AbortController().signal;
      session.agent.streamFunction({}, {}, { sessionId: role, transport: "websocket-cached", signal });
      expect(received[0].transport).toBe("websocket-cached");
      expect(received[0].signal).not.toBe(signal); // request-specific composed cancellation
      expect(received[0].signal.aborted).toBe(false);
      expect((wrapped as any).inheritedMethod()).toBe("preserved");
      expect((await received[0].onPayload({ tools: [functionTool] }, {})).tools)
        .toEqual([functionTool, { type: "web_search" }]);
    }
  });

  test.each(["readonly", "judge", "afk", undefined, "unknown"])("denies role %s after extension transforms", async (role) => {
    webSearch.enabled = true;
    const received: any[] = [];
    const session = await boundSession(wrapProvider(recordingProvider(received)), "restricted", role as SearchSessionRole);
    session.agent.streamFunction({}, {}, {
      sessionId: "restricted",
      onPayload: (payload: any) => ({ ...payload, tagged: true, tools: [functionTool, { type: "web_search" }] }),
    });
    expect(await received[0].onPayload({}, {})).toEqual({ tagged: true, tools: [functionTool] });
  });

  test("denies absent and mismatched request session identities", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const session = await boundSession(wrapProvider(recordingProvider(received)), "main", "main");
    for (const sessionId of [undefined, "other"]) {
      session.agent.streamFunction({}, {}, { sessionId });
      expect(await received.at(-1).onPayload({ tools: [] }, {})).toBeUndefined();
    }
  });

  test("concurrent session hooks retain roles across routes, awaits, and toggle changes", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const provider = wrapProvider(recordingProvider(received));
    const roles = ["main", "readonly", "worker", "judge", "afk"] as const;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    for (const role of roles) {
      const session = await boundSession(provider, role, role);
      withSearchRoute("unrelated-observer-route", () => session.agent.streamFunction({}, {}, {
        sessionId: role,
        onPayload: async (payload: any) => { await gate; return { ...payload, tagged: role }; },
      }));
    }
    const pending = received.map((options) => options.onPayload({ tools: [functionTool] }, {}));
    webSearch.enabled = false;
    release();
    expect((await Promise.all(pending)).map((payload) => payload.tools)).toEqual(roles.map(() => [functionTool]));
    webSearch.enabled = true;
    const enabled = await Promise.all(received.map((options) => options.onPayload({ tools: [functionTool] }, {})));
    // Re-enabling cannot resurrect payload hooks from before the disable.
    expect(enabled.map((payload) => payload.tools.some((tool: any) => tool.type === "web_search")))
      .toEqual([false, false, false, false, false]);
    expect(enabled.map((payload) => payload.tagged)).toEqual([...roles]);
  });

  test("direct completions cannot inherit authority from a route or an authorized extension callback", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const provider = wrapProvider(recordingProvider(received));
    const session = await boundSession(provider, "main", "main");
    session.agent.streamFunction({}, {}, {
      sessionId: "main",
      onPayload: async (payload: any) => {
        // Mirrors completeSimple delegation to streamSimple, with a hook and even
        // the same sessionId. This call must not inherit the outer authorization.
        await withSearchRoute("main", async () => {
          await Promise.resolve();
          provider.streamSimple({} as any, {} as any, {
            sessionId: "main",
            onPayload: (body: any) => ({ ...body, verifier: true }),
          } as any);
        });
        return payload;
      },
    });
    expect((await received[0].onPayload({ tools: [] }, {})).tools).toEqual([{ type: "web_search" }]);
    expect(await received[1].onPayload({ tools: [] }, {})).toEqual({ tools: [], verifier: true });
  });

  test("request serialization fence preserves extension fields, receiver, and existing toJSON semantics", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const session = await boundSession(wrapProvider(recordingProvider(received)), "main", "main");
    session.agent.streamFunction({}, {}, { sessionId: "main", onPayload: (body: any) => ({ ...body,
      tagged: true,
      toJSON(this: any, key: string) { return { tools: this.tools, tagged: this.tagged, key }; },
    }) });
    const guarded = await received[0].onPayload({ tools: [functionTool] }, {});
    const json = JSON.stringify(guarded);
    expect(JSON.parse(json)).toEqual({ tools: [functionTool, { type: "web_search" }], tagged: true, key: "" });
    expect(json).not.toContain("toJSON");
    expect(JSON.stringify({ type: "response.create", ...guarded })).toBe(json);
    webSearch.enabled = false;
    expect(() => JSON.stringify({ type: "response.create", ...guarded })).toThrow("Request was aborted");
    expect(JSON.stringify(guarded)).toBe(json); // historical comparison is not dispatch
  });

  test("does not duplicate search and preserves undefined hook semantics", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const session = await boundSession(wrapProvider(recordingProvider(received)), "main", "main");
    session.agent.streamFunction({}, {}, { sessionId: "main", onPayload: () => undefined });
    const body = { tools: [functionTool, { type: "web_search" }] };
    // Undefined from the extension still means use the original body, but the
    // final policy installs its private fence even for an existing search tool.
    const guarded = await received[0].onPayload(body, {});
    expect(JSON.stringify(guarded)).toBe(JSON.stringify(body));
    expect(guarded.tools).not.toBe(body.tools);
    expect(body.tools).toHaveLength(2);
    webSearch.enabled = false;
    expect(await received[0].onPayload(body, {})).toEqual({ tools: [functionTool] });
    expect(body.tools).toHaveLength(2);
  });

  // Defect 2: verifier/safety requests reach the provider through completeSimple
  // with NO onPayload hook. They must never receive the hosted web_search tool,
  // even while search is enabled for chat turns.
  test("does not attach the search tool to hook-less (verifier) requests", async () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const wrapped = wrapProvider(recordingProvider(received));

    // Mirrors check-mode's completeSimple options: no onPayload.
    wrapped.streamSimple({} as any, {} as any, {
      temperature: 0,
      maxTokens: 180,
      maxRetries: 0,
    } as any);

    expect(await received[0].onPayload({ tools: [] }, {})).toBeUndefined();
    expect(await received[0].onPayload({ tools: [{ type: "web_search" }] }, {}))
      .toEqual({ tools: [] });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  SearchCallRouter,
  SearchCallTracker,
  webSearch,
  webSearchArgument,
  wrapProvider,
} from "./web-search";

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

describe("web search provider wrapping", () => {
  afterEach(() => {
    webSearch.enabled = false;
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
    wrapped.streamSimple({} as any, {} as any, { onPayload: baseHook } as any);

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

  // Defect 2: verifier/safety requests reach the provider through completeSimple
  // with NO onPayload hook. They must never receive the hosted web_search tool,
  // even while search is enabled for chat turns.
  test("does not attach the search tool to hook-less (verifier) requests", () => {
    webSearch.enabled = true;
    const received: any[] = [];
    const wrapped = wrapProvider(recordingProvider(received));

    // Mirrors check-mode's completeSimple options: no onPayload.
    wrapped.streamSimple({} as any, {} as any, {
      temperature: 0,
      maxTokens: 180,
      maxRetries: 0,
    } as any);

    // With no agent hook present, no onPayload is installed, so the request body
    // is never rewritten to include { type: "web_search" }.
    expect(received[0].onPayload).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  SearchCallRouter,
  SearchCallTracker,
  webSearchArgument,
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

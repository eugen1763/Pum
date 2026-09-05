import { describe, expect, test } from "bun:test";
import { HEADLESS_TOOL_NAMES, headlessSearchObserver } from "../src/headless";
import { WEB_SEARCH_CUSTOM_TYPE } from "../src/web-search";

type Entry = { type: string; data: unknown };

function recorder() {
  const entries: Entry[] = [];
  const lines: string[] = [];
  const sessionManager = {
    appendCustomEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
  };
  const observe = headlessSearchObserver(sessionManager as any, (line) => lines.push(line));
  return { entries, lines, observe };
}

test("headless exposes exactly coding, memory, and own-session context tools", () => {
  expect([...HEADLESS_TOOL_NAMES].sort()).toEqual([
    "bash", "edit", "get_context_remaining", "history", "memory_edit", "memory_read",
    "new_context", "read", "write",
  ]);
});

describe("headless web search", () => {
  test("persists every phase as a custom session entry", () => {
    const { entries, observe } = recorder();

    observe({ phase: "start", id: "ws_1", query: "bun test runner" });
    observe({ phase: "end", id: "ws_1", query: "bun test runner", ok: true });

    expect(entries).toEqual([
      {
        type: WEB_SEARCH_CUSTOM_TYPE,
        data: { id: "ws_1", query: "bun test runner", state: "running" },
      },
      {
        type: WEB_SEARCH_CUSTOM_TYPE,
        data: { id: "ws_1", query: "bun test runner", state: "ok" },
      },
    ]);
  });

  test("records a failed search as an error state", () => {
    const { entries, lines, observe } = recorder();

    observe({ phase: "end", id: "ws_2", query: "unreachable", ok: false });

    expect(entries).toEqual([
      { type: WEB_SEARCH_CUSTOM_TYPE, data: { id: "ws_2", query: "unreachable", state: "error" } },
    ]);
    expect(lines).toEqual(["· web_search failed\n"]);
  });

  test("logs only the start of a successful search", () => {
    const { lines, observe } = recorder();

    observe({ phase: "start", id: "ws_3", query: "opentui markdown" });
    observe({ phase: "end", id: "ws_3", query: "opentui markdown", ok: true });

    expect(lines).toEqual(["· web_search opentui markdown\n"]);
  });
});

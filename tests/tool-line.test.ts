import { describe, expect, test } from "bun:test";
import { displayToolPath, editCounts, toolArgs, toolArgText } from "../src/tool-line";

describe("read tool metadata", () => {
  test("shows the path and only supplied range arguments", () => {
    expect(toolArgs("read", { path: "/repo/src/file name.ts" }, "/repo"))
      .toEqual(["src/file name.ts"]);
    expect(toolArgs("read", {
      path: "/repo/src/file name.ts",
      offset: 12,
    }, "/repo"))
      .toEqual(["src/file name.ts", "offset=12"]);
    expect(toolArgs("read", {
      path: "/repo/src/file name.ts",
      limit: 40,
    }, "/repo"))
      .toEqual(["src/file name.ts", "limit=40"]);
    expect(toolArgs("read", {
      path: "/repo/src/file name.ts",
      offset: 12,
      limit: 40,
    }, "/repo"))
      .toEqual(["src/file name.ts", "offset=12", "limit=40"]);
  });

  test("preserves Windows paths and spaces", () => {
    expect(toolArgs("read", {
      path: "C:\\Users\\Jane Doe\\project\\file name.ts",
      offset: 2,
      limit: 8,
    }, "/repo"))
      .toEqual(["C:\\Users\\Jane Doe\\project\\file name.ts", "offset=2", "limit=8"]);
  });

  test("uses stable separators for project-relative Windows and UNC paths", () => {
    expect(displayToolPath("C:\\Users\\Jane Doe\\project\\src\\file name.ts", "C:\\Users\\Jane Doe\\project"))
      .toBe("src/file name.ts");
    expect(displayToolPath("\\\\server\\share\\project\\src\\file name.ts", "\\\\server\\share\\project"))
      .toBe("src/file name.ts");
    expect(displayToolPath("src\\file name.ts", "C:\\Users\\Jane Doe\\project"))
      .toBe("src/file name.ts");
    expect(displayToolPath("/repo/..hidden/file.ts", "/repo"))
      .toBe("..hidden/file.ts");
  });

  test("preserves external Windows drive and UNC syntax", () => {
    expect(displayToolPath("D:\\Other Files\\file name.ts", "C:\\Users\\Jane Doe\\project"))
      .toBe("D:\\Other Files\\file name.ts");
    expect(displayToolPath("\\\\server\\other share\\file name.ts", "C:\\Users\\Jane Doe\\project"))
      .toBe("\\\\server\\other share\\file name.ts");
  });
});

describe("context tool metadata", () => {
  test("shows history search queries and supplied finite pagination", () => {
    expect(toolArgs("history", { op: "search", query: "exact instructions" }, "/repo"))
      .toEqual(["search", "exact instructions"]);
    expect(toolArgs("history", {
      op: "search", query: "exact instructions", offset: 0, limit: 10,
      entryId: "not a search argument", imageOffset: 1, imageLimit: 2,
    }, "/repo"))
      .toEqual(["search", "exact instructions", "offset=0", "limit=10"]);
    expect(toolArgText("history", { op: "search", query: "first\nsecond", limit: 3 }, "/repo"))
      .toBe("search, first\\nsecond, limit=3");
  });

  test("shows history entry IDs and independent text and image pagination", () => {
    expect(toolArgs("history", { op: "read", entryId: "entry-1" }, "/repo"))
      .toEqual(["read", "entry-1"]);
    expect(toolArgs("history", {
      op: "read", entryId: "entry-1", query: "not a read argument",
      offset: 4000, limit: 800, imageOffset: 2, imageLimit: 0,
    }, "/repo"))
      .toEqual(["read", "entry-1", "offset=4000", "limit=800", "imageOffset=2", "imageLimit=0"]);
    expect(toolArgs("history", { op: "read", entryId: "entry-1", imageLimit: 2 }, "/repo"))
      .toEqual(["read", "entry-1", "imageLimit=2"]);
  });

  test("never echoes handoff prose into transcript labels or flat logs", () => {
    const handoff = "PRIVATE HANDOFF\n".repeat(10000);
    const args = { handoff, path: "/repo/private", unrelated: "private fallback" };
    expect(toolArgs("new_context", args, "/repo"))
      .toEqual([`handoff: ${handoff.length} chars`]);
    const text = toolArgText("new_context", args, "/repo");
    expect(text).toBe(`handoff: ${handoff.length} chars`);
    expect(text).not.toContain("PRIVATE");
    expect(text.length).toBeLessThan(40);
    expect(toolArgs("new_context", { handoff: "" }, "/repo"))
      .toEqual(["handoff: 0 chars"]);
    expect(toolArgs("new_context", {}, "/repo")).toEqual([]);
  });

  test("context budget has no display arguments, even with unexpected input", () => {
    expect(toolArgs("get_context_remaining", {}, "/repo")).toEqual([]);
    expect(toolArgText("get_context_remaining", { path: "/repo/private", handoff: "private" }, "/repo"))
      .toBe("");
  });

  test("rejects malformed context argument containers without exposing fallback text", () => {
    for (const name of ["history", "new_context", "get_context_remaining"]) {
      for (const args of [undefined, null, false, 12, "private", ["private"]]) {
        expect(toolArgs(name, args, "/repo")).toEqual([]);
        expect(toolArgText(name, args, "/repo")).toBe("");
      }
    }
    for (const handoff of [undefined, null, 12, false, ["private"], { text: "private" }]) {
      expect(toolArgs("new_context", { handoff, path: "/repo/private", other: "private" }, "/repo"))
        .toEqual([]);
    }
    for (const op of [undefined, null, false, 12, "unknown", ["search"]]) {
      expect(toolArgs("history", { op, query: "private", path: "/repo/private" }, "/repo"))
        .toEqual([]);
    }
  });

  test("ignores malformed history targets and non-finite range values", () => {
    expect(toolArgs("history", {
      op: "search", query: { text: "private" }, offset: "1", limit: Infinity,
    }, "/repo"))
      .toEqual(["search"]);
    expect(toolArgs("history", {
      op: "read", entryId: ["private"], offset: NaN, limit: -Infinity,
      imageOffset: "2", imageLimit: null,
    }, "/repo"))
      .toEqual(["read"]);
    expect(toolArgs("history", {
      op: "read", entryId: "entry-1", offset: 0, limit: undefined,
      imageOffset: 0, imageLimit: Infinity,
    }, "/repo"))
      .toEqual(["read", "entry-1", "offset=0", "imageOffset=0"]);
  });
});

describe("other tool metadata", () => {
  test("preserves every Bash command line for the transcript", () => {
    expect(toolArgs("bash", { command: "printf one \\\r\n  && printf two" }, "/repo"))
      .toEqual(["printf one \\\n  && printf two"]);
    expect(toolArgText("bash", { command: "printf one \\\n  && printf two" }, "/repo"))
      .toBe("printf one \\\\n  && printf two");
  });

  test("summarizes questionnaire arguments without exposing every option", () => {
    expect(toolArgs("questionnaire", {
      questions: [
        { id: "scope", label: "Scope", prompt: "Choose scope", options: [] },
        { id: "format", prompt: "Choose format", options: [] },
      ],
    }, "/repo"))
      .toEqual(["2 questions", "Scope"]);
  });

  test("shows enabled tool groups", () => {
    expect(toolArgs("enable_tools", { groups: ["Admin"] }, "/repo"))
      .toEqual(["Admin"]);
    expect(toolArgs("enable_tools", { groups: ["Admin", "Subagents"] }, "/repo"))
      .toEqual(["Admin", "Subagents"]);
  });

  test("shows only documented web search arguments", () => {
    expect(toolArgs("web_search", {
      action: { type: "search", queries: ["first query", "second query"] },
      unrelated: "must not display",
    }, "/repo"))
      .toEqual(["first query", "second query"]);
    expect(toolArgs("web_search", {
      action: { type: "unknown", payload: "must not display" },
      unrelated: "must not display",
    }, "/repo"))
      .toEqual([]);
  });

  test("marks readonly subagent spawns", () => {
    expect(toolArgs("spawn_subagent", { task: "Inspect the parser", readonly: true }, "/repo"))
      .toEqual(["readonly", "Inspect the parser"]);
    expect(toolArgs("spawn_subagent", { task: "Inspect", name: "reviewer", readonly: true }, "/repo"))
      .toEqual(["readonly", "reviewer", "Inspect"]);
  });

  test("marks explicit worktree subagent spawns", () => {
    expect(toolArgs("spawn_subagent", { task: "Implement", worktree: true }, "/repo"))
      .toEqual(["worktree", "Implement"]);
  });

  test("summarizes message cache actions without exposing cached text", () => {
    expect(toolArgs("message_cache_list", {}, "/repo"))
      .toEqual(["list"]);
    expect(toolArgs("message_cache_add", { text: "large private cached task" }, "/repo"))
      .toEqual(["add"]);
    expect(toolArgs("message_cache_delete", { id: "cache-1" }, "/repo"))
      .toEqual(["delete", "cache-1"]);
    expect(toolArgs("message_cache_send", { ids: ["cache-1", "cache-1"] }, "/repo"))
      .toEqual(["send", "2 ids"]);
  });

  test("summarizes trigger tools without exposing templates or argument vectors", () => {
    expect(toolArgs("create_trigger", {
      name: "tests",
      executable: "bun",
      args: ["test", "--watch"],
      template: "large output template",
    }, "/repo"))
      .toEqual(["tests", "bun"]);
    expect(toolArgs("pause_trigger", { id: "trigger-1" }, "/repo"))
      .toEqual(["trigger-1"]);
    expect(toolArgs("invoke_trigger", { id: "trigger-1" }, "/repo"))
      .toEqual(["trigger-1"]);
  });

  test("counts unified patch additions and removals", () => {
    expect(editCounts({
      details: {
        patch: "--- a.ts\n+++ a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
      },
    })).toBe("+2 −1");
  });
});

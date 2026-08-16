import { describe, expect, test } from "bun:test";
import { displayToolPath, editCounts, toolArgs } from "./tool-line";

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

describe("apply_patch tool metadata", () => {
  test("shows compact single-file and multi-file arguments", () => {
    expect(toolArgs("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src\\one.ts\n@@\n-a\n+b\n*** End Patch",
    }, "/repo"))
      .toEqual(["src/one.ts"]);

    expect(toolArgs("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch",
    }, "/repo"))
      .toEqual(["old.ts → new.ts"]);

    expect(toolArgs("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: one.ts\n+x\n*** Delete File: two.ts\n*** End Patch",
    }, "/repo"))
      .toEqual(["2 files", "one.ts"]);
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

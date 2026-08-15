import { describe, expect, test } from "bun:test";
import {
  displayToolPath,
  editCounts,
  toolArg,
  toolOutputPreview,
  toolResultOutput,
} from "./tool-line";

describe("read tool metadata", () => {
  test("shows the path and only supplied range arguments", () => {
    expect(toolArg("read", { path: "/repo/src/file name.ts" }, "/repo")).toBe("src/file name.ts");
    expect(toolArg("read", {
      path: "/repo/src/file name.ts",
      offset: 12,
    }, "/repo")).toBe("src/file name.ts · offset=12");
    expect(toolArg("read", {
      path: "/repo/src/file name.ts",
      limit: 40,
    }, "/repo")).toBe("src/file name.ts · limit=40");
    expect(toolArg("read", {
      path: "/repo/src/file name.ts",
      offset: 12,
      limit: 40,
    }, "/repo")).toBe("src/file name.ts · offset=12 · limit=40");
  });

  test("preserves Windows paths and spaces", () => {
    expect(toolArg("read", {
      path: "C:\\Users\\Jane Doe\\project\\file name.ts",
      offset: 2,
      limit: 8,
    }, "/repo")).toBe("C:\\Users\\Jane Doe\\project\\file name.ts · offset=2 · limit=8");
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

describe("tool result output", () => {
  test("extracts all text blocks and preserves leading whitespace", () => {
    expect(toolResultOutput({
      content: [
        { type: "text", text: "first\r\n  second" },
        { type: "image", data: "ignored" },
        { type: "text", text: "third\n" },
      ],
    })).toBe("first\n  second\nthird");
    expect(toolResultOutput({ content: [{ type: "text", text: "  \n" }] })).toBeUndefined();
  });

  test("uses one source-line limit for every tool result", () => {
    expect(toolOutputPreview("one\ntwo\nthree\nfour", 2)).toEqual({
      text: "one\ntwo",
      omittedLines: 2,
    });
    expect(toolOutputPreview("one\ntwo", 5)).toEqual({
      text: "one\ntwo",
      omittedLines: 0,
    });
  });
});

describe("apply_patch tool metadata", () => {
  test("shows compact single-file and multi-file arguments", () => {
    expect(toolArg("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src\\one.ts\n@@\n-a\n+b\n*** End Patch",
    }, "/repo")).toBe("src/one.ts");

    expect(toolArg("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch",
    }, "/repo")).toBe("old.ts → new.ts");

    expect(toolArg("apply_patch", {
      patch: "*** Begin Patch\n*** Add File: one.ts\n+x\n*** Delete File: two.ts\n*** End Patch",
    }, "/repo")).toBe("2 files · one.ts");
  });

  test("summarizes questionnaire arguments without exposing every option", () => {
    expect(toolArg("questionnaire", {
      questions: [
        { id: "scope", label: "Scope", prompt: "Choose scope", options: [] },
        { id: "format", prompt: "Choose format", options: [] },
      ],
    }, "/repo")).toBe("2 questions · Scope");
  });

  test("shows enabled tool groups", () => {
    expect(toolArg("enable_tools", { groups: ["Admin"] }, "/repo")).toBe("Admin");
    expect(toolArg("enable_tools", { groups: ["Admin", "Subagents"] }, "/repo"))
      .toBe("Admin, Subagents");
  });

  test("shows only documented web search arguments", () => {
    expect(toolArg("web_search", {
      action: { type: "search", queries: ["first query", "second query"] },
      unrelated: "must not display",
    }, "/repo")).toBe("first query · second query");
    expect(toolArg("web_search", {
      action: { type: "unknown", payload: "must not display" },
      unrelated: "must not display",
    }, "/repo")).toBe("");
  });

  test("marks readonly subagent spawns", () => {
    expect(toolArg("spawn_subagent", { task: "Inspect the parser", readonly: true }, "/repo"))
      .toBe("readonly · Inspect the parser");
    expect(toolArg("spawn_subagent", { task: "Inspect", name: "reviewer", readonly: true }, "/repo"))
      .toBe("readonly · reviewer · Inspect");
  });

  test("summarizes message cache actions without exposing cached text", () => {
    expect(toolArg("message_cache_list", {}, "/repo")).toBe("list");
    expect(toolArg("message_cache_add", { text: "large private cached task" }, "/repo")).toBe("add");
    expect(toolArg("message_cache_delete", { id: "cache-1" }, "/repo")).toBe("delete · cache-1");
    expect(toolArg("message_cache_send", { ids: ["cache-1", "cache-1"] }, "/repo"))
      .toBe("send · 2 ids");
  });

  test("summarizes trigger tools without exposing templates or argument vectors", () => {
    expect(toolArg("create_trigger", {
      name: "tests",
      executable: "bun",
      args: ["test", "--watch"],
      template: "large output template",
    }, "/repo")).toBe("tests · bun");
    expect(toolArg("pause_trigger", { id: "trigger-1" }, "/repo")).toBe("trigger-1");
    expect(toolArg("invoke_trigger", { id: "trigger-1" }, "/repo"))
      .toBe("trigger-1");
  });

  test("counts unified patch additions and removals", () => {
    expect(editCounts({
      details: {
        patch: "--- a.ts\n+++ a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n",
      },
    })).toBe("+2 −1");
  });
});

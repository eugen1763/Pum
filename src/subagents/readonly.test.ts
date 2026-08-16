import { describe, expect, test } from "bun:test";
import { readonlySubagentExtension, readonlyToolBlockReason } from "./readonly";
import {
  READONLY_CHILD_OMITTED_TOOL_NAMES,
  childAllowedToolNames,
} from "../tool-groups";

describe("readonly subagent guard", () => {
  test("allows inspection and blocks mutation or unknown child tools", () => {
    expect(readonlyToolBlockReason("read", { path: "README.md" })).toBeUndefined();
    expect(readonlyToolBlockReason("bash", { command: "git status --short" })).toBeUndefined();
    expect(readonlyToolBlockReason("worktree", { action: "status" })).toBeUndefined();
    expect(readonlyToolBlockReason("write", { path: "out.txt" })).toContain("cannot use write");
    expect(readonlyToolBlockReason("spawn_subagent", { task: "mutate" })).toContain("cannot use spawn_subagent");
    expect(readonlyToolBlockReason("message_agent", { target: "main" })).toContain("cannot use message_agent");
    expect(readonlyToolBlockReason("create_trigger", {})).toContain("cannot use create_trigger");
    expect(readonlyToolBlockReason("worktree", { action: "merge" })).toContain("worktree merge");
    expect(readonlyToolBlockReason("custom_mutator", {})).toContain("custom_mutator");
  });

  test("blocks guarded tool calls through the pi hook", () => {
    const handlers = new Map<string, Function>();
    (readonlySubagentExtension(true) as any).factory({
      on(name: string, handler: Function) { handlers.set(name, handler); },
    });

    expect(handlers.get("tool_call")?.({ toolName: "read", input: { path: "README.md" } }))
      .toBeUndefined();
    expect(handlers.get("tool_call")?.({ toolName: "message_cache_send", input: { ids: ["one"] } }))
      .toMatchObject({ block: true, reason: expect.stringContaining("Readonly subagent blocked") });
  });

  test("does not add hooks for mutable children", () => {
    const handlers: string[] = [];
    (readonlySubagentExtension(false) as any).factory({
      on(name: string) { handlers.push(name); },
    });
    expect(handlers).toEqual([]);
  });
});

describe("the two readonly lists", () => {
  /**
   * A readonly child is bounded twice: the schema list decides what it can see,
   * and the guard decides what it may run. They are written in different files
   * and have to agree, or a tool is either advertised and then refused, or
   * hidden while the guard would have allowed it.
   */
  test("what the schemas omit is exactly what the guard refuses", () => {
    for (const name of READONLY_CHILD_OMITTED_TOOL_NAMES) {
      expect(readonlyToolBlockReason(name, {})).toBeDefined();
    }
  });

  test("what a readonly child can see, it may run", () => {
    // `worktree` is the one split tool: the schema offers it, and the guard
    // narrows it to the two actions that read.
    for (const name of childAllowedToolNames(true)) {
      if (name === "worktree") {
        expect(readonlyToolBlockReason(name, { action: "list" })).toBeUndefined();
        expect(readonlyToolBlockReason(name, { action: "merge" })).toBeDefined();
        continue;
      }
      expect(readonlyToolBlockReason(name, {})).toBeUndefined();
    }
  });
});

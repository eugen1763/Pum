import { describe, expect, test } from "bun:test";
import { CONTEXT_GUIDANCE } from "../src/context-guidance";
import { contextRecoveryGuidance } from "../src/context-recovery";
import { createMemoryExtension, hasMemoryContextExtension } from "../src/memory";

const contextTools = ["history", "get_context_remaining", "new_context"];
const core = ["read", "bash", ...contextTools];

function namedRecoveryTools(text: string): string[] {
  return [...new Set(text.match(/\b(?:memory_read|memory_edit|todo_list|enable_tools|history)\b/g))].sort();
}

describe("capability-aware context recovery", () => {
  test("memory capability uses registered extension identity, never a guessed extension name", () => {
    const main = createMemoryExtension({ agentDir: "/unused", audience: "main" });
    const worker = createMemoryExtension({ agentDir: "/unused", audience: "subagent" });
    expect(hasMemoryContextExtension([main])).toBe(true);
    expect(hasMemoryContextExtension([worker])).toBe(true);
    expect(hasMemoryContextExtension([])).toBe(false);
    expect(hasMemoryContextExtension([{ name: "pum-project-memory-main", factory() {} }])).toBe(false);
    expect(hasMemoryContextExtension([{ ...main } as typeof main])).toBe(false);
  });
  test.each([
    ["main", [...core, "write", "edit", "memory_read", "memory_edit", "enable_tools"]],
    ["headless", [...core, "write", "edit", "memory_read", "memory_edit"]],
    ["mutable worker", [...core, "write", "edit", "memory_read", "enable_tools"]],
    ["readonly worker", [...core, "memory_read", "enable_tools"]],
  ] as const)("%s uses injected memory without redundant or unavailable tool calls", (_role, tools) => {
    const text = contextRecoveryGuidance(tools, true);
    expect(text).toContain("Use the supplied snapshot; do not reread it unless genuinely needed.");
    expect(text).toContain("Respect empty, unavailable, or withdrawn memory notices; they do not restore older facts.");
    expect(text).toContain("Do not enable hidden todo tools solely for recovery");
    expect(text).toContain("Use history selectively only for missing relevant instructions or results");
    expect(namedRecoveryTools(text)).toEqual(["history"]);
    expect(text).not.toContain("memory_edit");
    expect(text).not.toContain("Write");
  });

  test("available memory without injection is read only when needed", () => {
    const text = contextRecoveryGuidance([...core, "memory_read"], false);
    expect(text).toContain("Use memory_read only if relevant project facts are missing");
    expect(text).not.toContain("automatically injected");
    expect(namedRecoveryTools(text)).toEqual(["history", "memory_read"]);
  });

  test("memory injection is explicit and independent of tool availability", () => {
    const text = contextRecoveryGuidance([], true);
    expect(text).toContain("Project memory is automatically injected");
    expect(namedRecoveryTools(text)).toEqual([]);
    expect(contextRecoveryGuidance(["memory_read"], false)).not.toContain("automatically injected");
  });

  test("active todos are optional, not a prerequisite to continuing", () => {
    const text = contextRecoveryGuidance([...core, "todo_list"], true);
    expect(text).toContain("Use todo_list only if missing task state is needed to continue");
    expect(text).toContain("the handoff may already be sufficient");
    expect(namedRecoveryTools(text)).toEqual(["history", "todo_list"]);
  });

  test("unavailable memory, todos and history produce no invented tool names", () => {
    const text = contextRecoveryGuidance([], false);
    expect(namedRecoveryTools(text)).toEqual([]);
    expect(text).toContain("Continue from the literal handoff and supplied context");
    expect(text).toContain("no routine restoration is required");
    expect(text).not.toContain("Project memory is automatically injected");
  });

  test("exact active names alone control guidance, not roles, aliases or unknown names", () => {
    const tools = ["main", "headless", "readonly", "Todo", "Memory_Read", "todo_add", "memory_edit", "invented_tool", "history_like"];
    const text = contextRecoveryGuidance(tools, false);
    expect(namedRecoveryTools(text)).toEqual([]);
    for (const name of tools) expect(text).not.toContain(name);
    const active = Object.freeze(["history", "todo_list", "memory_read"]);
    expect(contextRecoveryGuidance(active, false)).toBe(contextRecoveryGuidance([...active].reverse().concat(active), false));
  });

  test("common system prefix stays identical across recovery capabilities", () => {
    const prefix = CONTEXT_GUIDANCE;
    for (const tools of [[], core, [...core, "memory_read", "todo_list", "memory_edit"]]) {
      for (const injected of [false, true]) {
        contextRecoveryGuidance(tools, injected);
        expect(CONTEXT_GUIDANCE).toBe(prefix);
      }
    }
    expect(CONTEXT_GUIDANCE).not.toContain("memory_read");
    expect(CONTEXT_GUIDANCE).not.toContain("memory_edit");
    expect(CONTEXT_GUIDANCE).not.toContain("todo_list");
    expect(CONTEXT_GUIDANCE).toContain("no memory or todo checkpoint is required");
  });
});

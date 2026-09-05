import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  describePlanRecord,
  isPlanModeActive,
  loadPlanRecord,
  planModeFromTranscript,
  planModeExtension,
  planModeToolBlockReason,
  PLAN_MODE_CUSTOM_TYPE,
  savePlanRecord,
  validatePlanText,
} from "../src/plan-mode";
import { readonlyToolBlockReason } from "../src/subagents/readonly";
import {
  childAllowedToolNames,
  mainAllowedToolNames,
  PLAN_MODE_OMITTED_TOOL_NAMES,
  READONLY_CHILD_OMITTED_TOOL_NAMES,
} from "../src/tool-groups";
import { headlessToolNames } from "../src/headless";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pum-plan-"));
  return { root, file: join(root, "session.jsonl"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("plan mode tool policy", () => {
  test("removes every readonly-omitted tool plus memory_edit and the MCP tools", () => {
    const full = mainAllowedToolNames();
    const planned = mainAllowedToolNames(true);
    for (const name of [...READONLY_CHILD_OMITTED_TOOL_NAMES, ...PLAN_MODE_OMITTED_TOOL_NAMES]) {
      expect(full).toContain(name);
      expect(planned).not.toContain(name);
    }
    // Inspection and the session's own companions survive, as they do for a
    // readonly child. LSP is document-only, so it stays.
    for (const name of ["read", "bash", "memory_read", "questionnaire", "lsp_diagnostics", "todo_write"]) {
      if (full.includes(name)) expect(planned).toContain(name);
    }
    expect(planned).not.toContain("write");
    expect(planned).not.toContain("edit");
  });

  test("headless plan mode drops the same mutation tools", () => {
    expect(headlessToolNames()).toContain("write");
    expect(headlessToolNames(true)).not.toContain("write");
    expect(headlessToolNames(true)).not.toContain("edit");
    expect(headlessToolNames(true)).not.toContain("memory_edit");
    expect(headlessToolNames(true)).toContain("read");
    expect(headlessToolNames(true)).toContain("bash");
  });

  test("the call guard refuses exactly what the schemas omit, and says plan mode", () => {
    for (const name of READONLY_CHILD_OMITTED_TOOL_NAMES) {
      expect(planModeToolBlockReason(name)).toContain("plan mode cannot");
      expect(planModeToolBlockReason(name)).not.toContain("readonly child");
    }
    expect(planModeToolBlockReason("memory_edit")).toContain("shared project memory");
    expect(planModeToolBlockReason("mcp_call")).toContain("cannot certify");
    expect(planModeToolBlockReason("worktree", { action: "list" })).toBeUndefined();
    expect(planModeToolBlockReason("worktree", { action: "create" })).toContain("plan mode cannot");
    expect(planModeToolBlockReason("read")).toBeUndefined();
    expect(planModeToolBlockReason("bash")).toBeUndefined();
    // The readonly child set stays exactly as it was.
    expect(readonlyToolBlockReason("write")).toBe("readonly child cannot use write");
    expect(childAllowedToolNames(true)).not.toContain("write");
  });
});

describe("plan mode durability", () => {
  test("either record holds the session, and neither loss releases it", () => {
    const space = workspace();
    try {
      const manager = SessionManager.inMemory(process.cwd());
      expect(isPlanModeActive(space.file, manager)).toBe(false);
      // Transcript alone.
      manager.appendCustomEntry(PLAN_MODE_CUSTOM_TYPE, { version: 1, mode: "plan" });
      expect(planModeFromTranscript(manager)).toBe("plan");
      expect(isPlanModeActive(space.file, manager)).toBe(true);
      expect(isPlanModeActive(undefined, manager)).toBe(true);
      // Companion alone.
      const empty = SessionManager.inMemory(process.cwd());
      savePlanRecord(space.file, { version: 1, mode: "plan", at: 1 });
      expect(isPlanModeActive(space.file, empty)).toBe(true);
      // A stale companion cannot release a transcript that still says plan.
      savePlanRecord(space.file, { version: 1, mode: "implement", at: 2 });
      expect(isPlanModeActive(space.file, manager)).toBe(true);
      // Only an explicit later transition on the ancestry leaves.
      manager.appendCustomEntry(PLAN_MODE_CUSTOM_TYPE, { version: 1, mode: "implement" });
      expect(isPlanModeActive(space.file, manager)).toBe(false);
    } finally { space.cleanup(); }
  });

  test("a corrupt or missing companion restrains rather than releases", () => {
    const space = workspace();
    try {
      const manager = SessionManager.inMemory(process.cwd());
      manager.appendCustomEntry(PLAN_MODE_CUSTOM_TYPE, { version: 1, mode: "plan" });
      savePlanRecord(space.file, { version: 1, mode: "plan", text: "the plan", at: 1 });
      expect(loadPlanRecord(space.file)?.text).toBe("the plan");
      // A companion that cannot be read is no answer at all, and the transcript
      // still holds the session in plan mode.
      writeFileSync(join(space.root, "session.plan.json"), "{ not json");
      expect(loadPlanRecord(space.file)).toBeNull();
      expect(isPlanModeActive(space.file, manager)).toBe(true);
      savePlanRecord(space.file, null);
      expect(isPlanModeActive(space.file, manager)).toBe(true);
    } finally { space.cleanup(); }
  });

  test("an invalid transition record and unreadable ancestry both fail closed", () => {
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendCustomEntry(PLAN_MODE_CUSTOM_TYPE, { version: 1, mode: "sideways" });
    expect(() => planModeFromTranscript(manager)).toThrow("invalid transition record");
    expect(isPlanModeActive(undefined, manager)).toBe(true);
    const broken = { getEntries: () => [{}], getEntry: () => undefined, getLeafId: () => "missing" } as any;
    expect(() => planModeFromTranscript(broken)).toThrow("invalid ancestry");
    expect(isPlanModeActive(undefined, broken)).toBe(true);
    // An object with no ancestry API carries no record, so it restrains nothing
    // by itself. Only the companion can speak for such a session.
    const noTree = { getEntries: () => [] } as any;
    expect(planModeFromTranscript(noTree)).toBeUndefined();
    expect(isPlanModeActive(undefined, noTree)).toBe(false);
  });

  test("plan text is bounded, kept as written and reported with the mode", () => {
    expect(validatePlanText("  step one  ")).toBe("step one");
    expect(() => validatePlanText("   ")).toThrow("needs text");
    expect(() => validatePlanText("x".repeat(100_001))).toThrow("limited to");
    expect(describePlanRecord(null, true)).toContain("Plan mode is ON");
    expect(describePlanRecord(null, true)).toContain("No plan text recorded");
    expect(describePlanRecord({ version: 1, mode: "plan", text: "step one", at: 1 }, true)).toContain("step one");
    expect(describePlanRecord(null, false)).toContain("Plan mode is off");
  });
});

function handlers(planMode: boolean) {
  const registered = new Map<string, (...args: any[]) => any>();
  const extension = planModeExtension(planMode);
  if (typeof extension === "function") throw new Error("expected a named extension");
  extension.factory({ on: (name: string, fn: any) => registered.set(name, fn), registerTool() {} } as any);
  return registered;
}

describe("plan mode call guard and wiring", () => {
  test("the guard blocks the call itself and rewrites the visible result", () => {
    const on = handlers(true);
    expect(on.get("tool_call")!({ toolName: "read", toolCallId: "a", input: {} })).toBeUndefined();
    const blocked = on.get("tool_call")!({ toolName: "write", toolCallId: "b", input: {} });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("Plan mode blocked write");
    expect(on.get("tool_result")!({ toolCallId: "b", details: {} })).toBeDefined();
    // The prompt states the role, so the model is not left guessing why.
    const prompt = on.get("before_agent_start")!({ systemPrompt: "BASE" }).systemPrompt;
    expect(prompt).toContain("Plan mode");
    expect(prompt).toContain("Only the user can leave plan mode");
    // Off, the guard registers nothing and blocks nothing.
    expect(handlers(false).size).toBe(0);
  });

  test("main and headless build every enforcement layer from the same flag", () => {
    const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    // The role is derived from the durable records unless a transition names it.
    expect(main).toContain("planMode ?? isPlanModeActive(sessionManager.getSessionFile(), sessionManager)");
    for (const layer of [
      'new ToolGroupsController("main", undefined, restricted)',
      'createFilesystemSandboxExtension({ readonly: true, roleLabel: "plan mode" })',
      "sandboxController.extension({ readonly: true })",
      "planModeExtension(restricted)",
      "createFileCheckpointExtension({ readonly: restricted })",
      "mainAllowedToolNames(restricted)",
    ]) expect(main).toContain(layer);
    // MCP tool registration is withheld rather than filtered later.
    expect(main.indexOf("restricted ? [] : [{ name: \"pum-main-mcp\"")).toBeGreaterThan(-1);

    const headless = readFileSync(new URL("../src/headless.ts", import.meta.url), "utf8");
    expect(headless).toContain("options.plan === true");
    expect(headless).toContain("isPlanModeActive(sessionManager.getSessionFile(), sessionManager)");
    expect(headless).toContain("sandboxController.extension({ readonly: restricted })");
    expect(headless).toContain("planModeExtension(restricted)");
    expect(headless).toContain("headlessToolNames(restricted)");
    expect(headless).toContain("Plan mode cannot approve project validation.");
  });
});

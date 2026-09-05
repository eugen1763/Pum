import type { AgentSession, InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { readCompanion, writeCompanionOrThrow } from "./session-companion";
import { readonlyRoleGuardExtension, readonlyToolBlockReason } from "./subagents/readonly";
import { PLAN_MODE_OMITTED_TOOL_NAMES } from "./tool-groups";

/** Append-only, context-excluded transition record inside the canonical JSONL. */
export const PLAN_MODE_CUSTOM_TYPE = "pum.plan_mode";
const PLAN_SUFFIX = "plan.json";
const MAX_PLAN_TEXT = 100_000;

export type PlanMode = "plan" | "implement";
export type PlanRecord = {
  version: 1;
  mode: PlanMode;
  /** The plan the user recorded, kept as written. Empty until one is set. */
  text?: string;
  at: number;
};

const isMode = (value: unknown): value is PlanMode => value === "plan" || value === "implement";
const isPlanRecord = (value: unknown): value is PlanRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PlanRecord>;
  return record.version === 1 && isMode(record.mode) && typeof record.at === "number"
    && (record.text === undefined || (typeof record.text === "string" && record.text.length <= MAX_PLAN_TEXT));
};

export function loadPlanRecord(sessionFile: string | undefined): PlanRecord | null {
  return readCompanion<PlanRecord | null>(sessionFile, PLAN_SUFFIX, (value): value is PlanRecord | null =>
    value === null || isPlanRecord(value), null);
}

/** Throws, so a transition can fail closed rather than report a mode it did not store. */
export function savePlanRecord(sessionFile: string, record: PlanRecord | null): void {
  writeCompanionOrThrow(sessionFile, PLAN_SUFFIX, record);
}

/**
 * The latest transition recorded on the selected ancestry, if any.
 *
 * Bounded by the already-loaded entry count, and it reads only this one custom
 * type's own mode field: never another extension's private data.
 */
export function planModeFromTranscript(manager: Pick<SessionManager,
  "getEntries" | "getEntry" | "getLeafId">): PlanMode | undefined {
  // No tree to read is not the same as a tree that cannot be read: an object
  // with no ancestry API carries no transition record, while a real manager
  // whose ancestry is broken must fail closed below.
  if (typeof manager?.getLeafId !== "function" || typeof manager?.getEntries !== "function"
    || typeof manager?.getEntry !== "function") return undefined;
  let remaining = manager.getEntries().length;
  let cursor = manager.getLeafId();
  while (cursor !== null) {
    const entry = manager.getEntry(cursor);
    if (!entry || remaining-- <= 0) throw new Error("Plan mode history has invalid ancestry.");
    if (entry.type === "custom" && entry.customType === PLAN_MODE_CUSTOM_TYPE) {
      const mode = (entry.data as { mode?: unknown })?.mode;
      if (!isMode(mode)) throw new Error("Plan mode history has an invalid transition record.");
      return mode;
    }
    cursor = entry.parentId;
  }
  return undefined;
}

/**
 * Whether this session starts restrained.
 *
 * Two independent records, and either one holds the session in plan mode. A
 * lost, truncated or invalid companion therefore cannot silently restore
 * mutation, and only an explicit user transition appends an `implement` entry,
 * so no crash or rollback can fabricate one. A session with neither record is an
 * ordinary mutable session.
 */
export function isPlanModeActive(
  sessionFile: string | undefined,
  manager: Pick<SessionManager, "getEntries" | "getEntry" | "getLeafId">,
): boolean {
  const companion = loadPlanRecord(sessionFile);
  if (companion?.mode === "plan") return true;
  try { return planModeFromTranscript(manager) === "plan"; }
  catch { return true; } // Unreadable ancestry restrains rather than releases.
}

/** The extra names plan mode refuses beyond the shared readonly-role set. */
const PLAN_ONLY_BLOCKED = new Set<string>(PLAN_MODE_OMITTED_TOOL_NAMES);

export function planModeToolBlockReason(
  toolName: string,
  input: Record<string, unknown> = {},
): string | undefined {
  if (PLAN_ONLY_BLOCKED.has(toolName)) {
    return toolName === "memory_edit"
      ? "plan mode cannot write shared project memory"
      : `plan mode cannot call ${toolName}: PUM cannot certify a server as non-mutating`;
  }
  const shared = readonlyToolBlockReason(toolName, input);
  return shared?.replace("readonly child cannot", "plan mode cannot");
}

/** Fail closed for every main tool path that can bypass plan mode. */
export function planModeExtension(planMode: boolean): InlineExtension {
  if (!planMode) return { name: "pum-plan-mode-guard", factory() {} };
  return readonlyRoleGuardExtension({
    name: "pum-plan-mode-guard",
    label: "Plan mode",
    systemPrompt: "## Plan mode\n\n"
      + "- This session is planning only. Inspect files and run non-mutating commands.\n"
      + "- Do not mutate files, delegate mutation, or start mutating services.\n"
      + "- File mutation tools, mutable delegation and MCP servers are blocked.\n"
      + "- Bash runs only with native sandbox enforcement and read-only project roots.\n"
      + "- Write the plan out for the user. Only the user can leave plan mode.",
    blockReason: planModeToolBlockReason,
  });
}

/** Bounded, user-authored plan text. Stored as written, never truncated silently. */
export function validatePlanText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A plan needs text. Usage: /plan <text>");
  if (trimmed.length > MAX_PLAN_TEXT) {
    throw new Error(`A plan is limited to ${MAX_PLAN_TEXT} characters.`);
  }
  return trimmed;
}

export function describePlanRecord(record: PlanRecord | null, active: boolean): string {
  const state = active
    ? "Plan mode is ON: this session cannot mutate files, delegate mutation or call MCP servers."
    : "Plan mode is off: this session has full capability.";
  return record?.text
    ? `${state}\n\nCurrent plan:\n${record.text}`
    : `${state}\n\nNo plan text recorded yet. Use /plan <text> to record one.`;
}

/** Exact-runtime lookup so a stale UI reference cannot report another session. */
export function planModeForSession(session: Pick<AgentSession, "sessionFile" | "sessionManager">): boolean {
  return isPlanModeActive(session.sessionFile, session.sessionManager);
}

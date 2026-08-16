import { companionFileFor, readCompanion, writeCompanion } from "./session-companion";
import { isPathInsideOrSame, pathIdentity } from "./platform";

/**
 * Where a relocated session is currently running, and what move it still owes.
 *
 * A session can be moved into a generated worktree and back without forking its
 * JSONL. The record is what survives a crash: the move itself is two steps -
 * persist the intent, then rebind - and either can be interrupted.
 */
export type RelocationLocation = "source" | "worktree";

/** A move the session owes. `null` means it is settled where it is. */
export type RelocationTransition = "start" | "return";

export type RelocationRecord = {
  id: string;
  /** Bumped by every accepted transition, so a stale settlement is ignorable. */
  generation: number;
  /** Canonical source repository the session belongs to. */
  sourceRoot: string;
  /** Canonical generated worktree. */
  worktreePath: string;
  name: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  location: RelocationLocation;
  pending?: RelocationTransition;
  /** Generation the pending transition was scheduled against. */
  pendingGeneration?: number;
  createdAt: number;
  updatedAt: number;
};

export const MAX_RELOCATION_FIELD = 4_096;

/** Companion file next to the session JSONL: `<session>.relocation.json`. */
const RELOCATION_SUFFIX = "relocation.json";

export function relocationFileFor(sessionFile: string): string {
  return companionFileFor(sessionFile, RELOCATION_SUFFIX);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_RELOCATION_FIELD
    && !value.includes("\0");
}

function isRelocationRecord(value: unknown): value is RelocationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return boundedText(record.id)
    && typeof record.generation === "number" && Number.isFinite(record.generation)
    && boundedText(record.sourceRoot)
    && boundedText(record.worktreePath)
    && boundedText(record.name)
    && boundedText(record.branch)
    && boundedText(record.baseBranch)
    && boundedText(record.baseCommit)
    && (record.location === "source" || record.location === "worktree")
    && (record.pending === undefined || record.pending === "start" || record.pending === "return")
    && typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
    && typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt);
}

/** Never throws: corrupt state means no relocation, which resumes in the source. */
export function loadRelocation(sessionFile: string | undefined): RelocationRecord | null {
  return readCompanion(sessionFile, RELOCATION_SUFFIX, isRelocationRecord, null);
}

export function saveRelocation(
  sessionFile: string | undefined,
  record: RelocationRecord | null,
): void {
  writeCompanion(sessionFile, RELOCATION_SUFFIX, record);
}

export type RelocationGuardInput = {
  relocation: RelocationRecord | null;
  /** True while the main agent is working. A move mid-turn would change its roots. */
  busy: boolean;
  /** Managed children still retained, at any status and any depth. */
  retainedChildren: number;
  /** True while a transition is already scheduled or running. */
  inFlight: boolean;
};

/** The reason a start is refused, or null when it may go ahead. */
export function startRelocationBlockReason(input: RelocationGuardInput): string | null {
  if (input.busy) return "wait for the current turn to finish before moving the session";
  if (input.inFlight) return "a worktree move is already in progress";
  if (input.retainedChildren > 0) {
    return `close ${input.retainedChildren} managed agent${input.retainedChildren === 1 ? "" : "s"} before moving the session`;
  }
  // One layer only. A worktree of a worktree has no meaning here, and the
  // record holds exactly one source to return to.
  if (input.relocation && input.relocation.location === "worktree") {
    return `this session already runs in worktree ${input.relocation.name}; return first`;
  }
  return null;
}

export function returnRelocationBlockReason(input: RelocationGuardInput): string | null {
  if (input.busy) return "wait for the current turn to finish before moving the session";
  if (input.inFlight) return "a worktree move is already in progress";
  if (input.retainedChildren > 0) {
    return `close ${input.retainedChildren} managed agent${input.retainedChildren === 1 ? "" : "s"} before moving the session`;
  }
  if (!input.relocation || input.relocation.location !== "worktree") {
    return "this session is not running in a generated worktree";
  }
  return null;
}

/** The directory a record says the session belongs in right now. */
export function relocationTargetDirectory(record: RelocationRecord): string {
  return record.location === "worktree" ? record.worktreePath : record.sourceRoot;
}

/**
 * Whether a settlement still belongs to the transition that scheduled it.
 *
 * A cancelled or superseded move leaves its settle event in flight, and acting
 * on it would move a session the user already put back.
 */
export function isRelocationSettlementCurrent(
  record: RelocationRecord | null,
  ticket: { id: string; generation: number },
): boolean {
  if (!record?.pending) return false;
  return record.id === ticket.id && record.pendingGeneration === ticket.generation;
}

export type RelocationTrust = {
  /** Directories the session may be authorized to run in and write to. */
  sourceRoot: string;
  worktreePath: string;
};

/**
 * Refuse a persisted path that no longer identifies what the record describes.
 *
 * A worktree deleted, pruned, moved or replaced outside PUM leaves a record
 * pointing at a path someone else may now own, and authorizing it would hand
 * write access to a directory the user never chose.
 */
export function relocationPathsTrusted(
  record: RelocationRecord,
  actual: { worktreeExists: boolean; worktreeBranch?: string; sourceRoot?: string },
): boolean {
  if (!actual.worktreeExists) return false;
  if (actual.worktreeBranch !== record.branch) return false;
  if (actual.sourceRoot && pathIdentity(actual.sourceRoot) !== pathIdentity(record.sourceRoot)) {
    return false;
  }
  // The generated worktree lives under the source repository, and a record that
  // says otherwise describes a layout PUM never creates.
  return isPathInsideOrSame(record.sourceRoot, record.worktreePath);
}

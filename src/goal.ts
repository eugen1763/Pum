import { randomUUID } from "node:crypto";
import { companionFileFor, readCompanion, writeCompanion } from "./session-companion";

/**
 * Autonomous goal mode.
 *
 * A goal is one durable instruction that outlives a single turn. After every
 * settled main-agent turn a fresh judge reviews the work and either completes
 * the goal, asks the user a question, or writes the next continuation message.
 * Everything that decides those transitions lives here so the App only wires
 * events to it.
 */

export type GoalState = "active" | "stopped" | "blocked" | "completed" | "failed";

export const GOAL_STATES: readonly GoalState[] = [
  "active",
  "stopped",
  "blocked",
  "completed",
  "failed",
];

/** Terminal states must be replaced or cleared; they never resume. */
export const TERMINAL_GOAL_STATES: readonly GoalState[] = ["completed", "failed"];

export type GoalVerdict = "completed" | "incomplete" | "blocked";

/** Longest goal text PUM stores. Longer input is refused, never truncated. */
export const MAX_GOAL_TEXT = 4_000;
/** Longest judge field PUM accepts. A longer field fails the verdict closed. */
export const MAX_JUDGE_FIELD = 8_000;

export const MIN_GOAL_RETRY_LIMIT = 0;
export const MAX_GOAL_RETRY_LIMIT = 100;
export const DEFAULT_GOAL_RETRY_LIMIT = 10;

export type GoalJudgeResult = {
  verdict: GoalVerdict;
  /** Evidence for completion, the remaining work, or the blocker. */
  summary: string;
  /** The next main-agent message. Required for `incomplete`. */
  continuation?: string;
  /** One clear user question. Required for `blocked`. */
  question?: string;
};

export type GoalContinuation = {
  /** Stable identity, so a redelivery after a crash cannot duplicate the turn. */
  id: string;
  text: string;
};

export type GoalRecord = {
  /** Stable per-goal identity. Replacement mints a new one. */
  id: string;
  /** Bumped by every lifecycle action, so a stale judge result can be ignored. */
  generation: number;
  text: string;
  state: GoalState;
  createdAt: number;
  updatedAt: number;
  /** Settled main-agent turns counted since the goal was set. */
  workGeneration: number;
  /** The settled work generation whose judge result was already processed. */
  lastJudgedWorkGeneration: number;
  /** Valid judge verdicts so far. */
  judgeCount: number;
  /** Consecutive `incomplete` verdicts. */
  incompleteCount: number;
  /** Effective limit captured when the goal was set. 0 means no limit. */
  retryLimit: number;
  lastVerdict?: GoalJudgeResult;
  /** Persisted until the generated continuation turn is actually delivered. */
  pendingContinuation?: GoalContinuation;
  /** The blocked question the user still has to answer. */
  pendingQuestion?: string;
};

export function normalizeGoalRetryLimit(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_GOAL_RETRY_LIMIT
    && value <= MAX_GOAL_RETRY_LIMIT
    ? value
    : DEFAULT_GOAL_RETRY_LIMIT;
}

export function isGoalState(value: unknown): value is GoalState {
  return GOAL_STATES.includes(value as GoalState);
}

export function isTerminalGoalState(state: GoalState): boolean {
  return TERMINAL_GOAL_STATES.includes(state);
}

/** Companion suffix for a session's goal. */
const GOAL_SUFFIX = "goal.json";

/** Companion file next to the session JSONL: `<session>.goal.json` */
export function goalFileFor(sessionFile: string): string {
  return companionFileFor(sessionFile, GOAL_SUFFIX);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max) return undefined;
  return text;
}

function isGoalRecord(value: unknown): value is GoalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" && record.id.length > 0 &&
    Number.isInteger(record.generation) && (record.generation as number) > 0 &&
    // The same bound `createGoal` enforces, so a hand-edited file cannot store
    // a goal PUM would have refused.
    typeof record.text === "string" &&
    record.text.trim().length > 0 && record.text.length <= MAX_GOAL_TEXT &&
    isGoalState(record.state) &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    Number.isInteger(record.workGeneration) &&
    Number.isInteger(record.lastJudgedWorkGeneration) &&
    Number.isInteger(record.judgeCount) &&
    Number.isInteger(record.incompleteCount) &&
    Number.isInteger(record.retryLimit) &&
    (record.lastVerdict === undefined || parseGoalVerdict(record.lastVerdict) !== undefined) &&
    (record.pendingContinuation === undefined || isContinuation(record.pendingContinuation)) &&
    (record.pendingQuestion === undefined || typeof record.pendingQuestion === "string")
  );
}

function isContinuation(value: unknown): value is GoalContinuation {
  if (!value || typeof value !== "object") return false;
  const continuation = value as Record<string, unknown>;
  return typeof continuation.id === "string" && continuation.id.length > 0
    && typeof continuation.text === "string" && continuation.text.trim().length > 0;
}

/** Load the persisted goal for a session. Never throws; corrupt state is no goal. */
export function loadGoal(sessionFile: string | undefined): GoalRecord | null {
  return readCompanion(sessionFile, GOAL_SUFFIX, isGoalRecord, null);
}

/** Persist the goal atomically beside the session. Best effort only. */
export function saveGoal(sessionFile: string | undefined, goal: GoalRecord | null): void {
  writeCompanion(sessionFile, GOAL_SUFFIX, goal);
}

export function createGoal(
  text: string,
  retryLimit: number,
  now = Date.now(),
  id = randomUUID().slice(0, 12),
): GoalRecord {
  const goal = text.trim();
  if (!goal) throw new Error("a goal needs text");
  if (goal.length > MAX_GOAL_TEXT) {
    throw new Error(`a goal is at most ${MAX_GOAL_TEXT} characters`);
  }
  return {
    id,
    generation: 1,
    text: goal,
    state: "active",
    createdAt: now,
    updatedAt: now,
    workGeneration: 0,
    lastJudgedWorkGeneration: 0,
    judgeCount: 0,
    incompleteCount: 0,
    retryLimit: normalizeGoalRetryLimit(retryLimit),
  };
}

function advanced(goal: GoalRecord, patch: Partial<GoalRecord>, now: number): GoalRecord {
  return { ...goal, ...patch, generation: goal.generation + 1, updatedAt: now };
}

/** Stop an active or blocked goal. Terminal and already stopped goals refuse. */
export function stopGoal(goal: GoalRecord, now = Date.now()): GoalRecord {
  if (goal.state === "stopped") throw new Error("the goal is already stopped");
  if (isTerminalGoalState(goal.state)) {
    throw new Error(`a ${goal.state} goal cannot be stopped; replace or clear it`);
  }
  // The pending question survives the stop. It is the only record of what the
  // judge asked, and continuing a stopped goal must not lose it.
  return advanced(goal, { state: "stopped", pendingContinuation: undefined }, now);
}

/** Resume a stopped goal. Every other state refuses. */
export function continueGoal(goal: GoalRecord, now = Date.now()): GoalRecord {
  if (goal.state !== "stopped") {
    throw new Error(
      isTerminalGoalState(goal.state)
        ? `a ${goal.state} goal cannot continue; replace or clear it`
        : `only a stopped goal can continue; this goal is ${goal.state}`,
    );
  }
  // Resuming answers the question by moving on, so it stops being pending.
  return advanced(goal, { state: "active", pendingQuestion: undefined }, now);
}

/**
 * A normal user message steers the goal and always leaves it active. Answering
 * a blocked question resumes the lifecycle; a stopped goal stays stopped.
 */
export function steerGoal(goal: GoalRecord, now = Date.now()): GoalRecord {
  if (goal.state === "blocked") {
    return advanced(goal, { state: "active", pendingQuestion: undefined }, now);
  }
  return goal;
}

/** Count one settled main-agent turn as a reviewable work generation. */
export function noteSettledWork(goal: GoalRecord, now = Date.now()): GoalRecord {
  return { ...goal, workGeneration: goal.workGeneration + 1, updatedAt: now };
}

export type GoalJudgeTicket = {
  judgeId: string;
  goalId: string;
  generation: number;
  workGeneration: number;
};

export type JudgeScheduleInput = {
  goal: GoalRecord | null;
  /** The main agent finished its turn and is not streaming. */
  mainSettled: boolean;
  /** Managed subagents in `starting` or `running`, judges excluded. */
  activeWorkerCount: number;
  /** External triggers with a process running or a result awaiting delivery. */
  activeTriggerCount: number;
  /** A judge is starting, running, or awaiting result processing. */
  judgeInFlight: boolean;
  /** Queued completion messages and steers not yet inserted into the session. */
  pendingInsertions: number;
};

/**
 * The complete review trigger. Every condition is event-derived, so nothing
 * here needs a timer or a status poll.
 */
export function shouldScheduleGoalJudge(input: JudgeScheduleInput): boolean {
  const { goal } = input;
  if (!goal || goal.state !== "active") return false;
  if (!input.mainSettled) return false;
  if (input.activeWorkerCount > 0) return false;
  if (input.activeTriggerCount > 0) return false;
  if (input.judgeInFlight) return false;
  if (input.pendingInsertions > 0) return false;
  if (goal.pendingContinuation) return false;
  return goal.workGeneration > goal.lastJudgedWorkGeneration;
}

export function judgeTicketFor(goal: GoalRecord, judgeId: string): GoalJudgeTicket {
  return {
    judgeId,
    goalId: goal.id,
    generation: goal.generation,
    workGeneration: goal.workGeneration,
  };
}

/** Fail closed: only a result for the exact live goal generation may act. */
export function isJudgeResultCurrent(goal: GoalRecord | null, ticket: GoalJudgeTicket): boolean {
  if (!goal) return false;
  return goal.id === ticket.goalId
    && goal.generation === ticket.generation
    && goal.workGeneration === ticket.workGeneration
    && goal.state === "active"
    && goal.lastJudgedWorkGeneration < ticket.workGeneration;
}

/** Validate one judge verdict. Anything missing, oversized, or unknown fails closed. */
export function parseGoalVerdict(value: unknown): GoalJudgeResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const verdict = raw.verdict;
  if (verdict !== "completed" && verdict !== "incomplete" && verdict !== "blocked") return undefined;
  const summary = boundedText(raw.summary, MAX_JUDGE_FIELD);
  if (!summary) return undefined;

  if (verdict === "incomplete") {
    const continuation = boundedText(raw.continuation, MAX_JUDGE_FIELD);
    if (!continuation) return undefined;
    return { verdict, summary, continuation };
  }
  if (verdict === "blocked") {
    const question = boundedText(raw.question, MAX_JUDGE_FIELD);
    if (!question) return undefined;
    return { verdict, summary, question };
  }
  return { verdict, summary };
}

export type GoalJudgeAction =
  | { kind: "ignored"; reason: string }
  | { kind: "completed"; summary: string }
  | { kind: "blocked"; question: string; summary: string }
  | { kind: "continue"; continuation: GoalContinuation }
  | { kind: "failed"; summary: string; attempts: number };

export type GoalJudgeOutcome = { goal: GoalRecord; action: GoalJudgeAction };

/**
 * Fold one validated verdict into the goal. The returned goal must be persisted
 * before the action runs, so a crash between the two cannot repeat the turn.
 */
export function applyJudgeResult(
  goal: GoalRecord | null,
  ticket: GoalJudgeTicket,
  result: GoalJudgeResult,
  now = Date.now(),
  continuationId = randomUUID().slice(0, 12),
): GoalJudgeOutcome {
  if (!goal || !isJudgeResultCurrent(goal, ticket)) {
    return {
      goal: goal ?? emptyGoalPlaceholder(now),
      action: { kind: "ignored", reason: "the judge result no longer matches the live goal" },
    };
  }

  const judged: Partial<GoalRecord> = {
    lastJudgedWorkGeneration: ticket.workGeneration,
    judgeCount: goal.judgeCount + 1,
    lastVerdict: result,
  };

  if (result.verdict === "completed") {
    return {
      goal: advanced(goal, { ...judged, state: "completed", incompleteCount: 0 }, now),
      action: { kind: "completed", summary: result.summary },
    };
  }
  if (result.verdict === "blocked") {
    return {
      goal: advanced(goal, {
        ...judged,
        state: "blocked",
        pendingQuestion: result.question,
      }, now),
      action: { kind: "blocked", question: result.question!, summary: result.summary },
    };
  }

  const incompleteCount = goal.incompleteCount + 1;
  if (goal.retryLimit > 0 && incompleteCount >= goal.retryLimit) {
    return {
      goal: advanced(goal, { ...judged, state: "failed", incompleteCount }, now),
      action: { kind: "failed", summary: result.summary, attempts: incompleteCount },
    };
  }
  const continuation: GoalContinuation = { id: continuationId, text: result.continuation! };
  return {
    goal: advanced(goal, { ...judged, incompleteCount, pendingContinuation: continuation }, now),
    action: { kind: "continue", continuation },
  };
}

/** Clear the durable continuation once its turn is actually delivered. */
export function continuationDelivered(
  goal: GoalRecord,
  continuationId: string,
  now = Date.now(),
): GoalRecord {
  if (goal.pendingContinuation?.id !== continuationId) return goal;
  return { ...goal, pendingContinuation: undefined, updatedAt: now };
}

function emptyGoalPlaceholder(now: number): GoalRecord {
  return {
    id: "",
    generation: 0,
    text: "",
    state: "stopped",
    createdAt: now,
    updatedAt: now,
    workGeneration: 0,
    lastJudgedWorkGeneration: 0,
    judgeCount: 0,
    incompleteCount: 0,
    retryLimit: DEFAULT_GOAL_RETRY_LIMIT,
  };
}

function formatTimestamp(at: number): string {
  return new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** The complete `/goal status` report, including untruncated goal text. */
export function formatGoalStatus(goal: GoalRecord | null): string {
  if (!goal) return "no goal is set. Use /goal <text> or /goalf <draft>.";
  const limit = goal.retryLimit === 0 ? "unlimited" : String(goal.retryLimit);
  const lines = [
    `goal: ${goal.text}`,
    `state: ${goal.state}`,
    `judge reviews: ${goal.judgeCount}`,
    `consecutive incomplete: ${goal.incompleteCount} (retry limit ${limit})`,
    `settled turns: ${goal.workGeneration} (judged through ${goal.lastJudgedWorkGeneration})`,
    `created: ${formatTimestamp(goal.createdAt)}`,
    `updated: ${formatTimestamp(goal.updatedAt)}`,
  ];
  if (goal.lastVerdict) {
    lines.push(`latest verdict: ${goal.lastVerdict.verdict} — ${goal.lastVerdict.summary}`);
  }
  if (goal.pendingQuestion) lines.push(`waiting on: ${goal.pendingQuestion}`);
  if (goal.pendingContinuation) lines.push("a generated continuation is queued");
  return lines.join("\n");
}

/** The first main-agent turn of a goal. */
export function goalStartPrompt(goal: GoalRecord): string {
  return `Pursue this goal until it is genuinely finished.\n\nGoal: ${goal.text}\n\n`
    + "Work on it directly. Use managed subagents for parallel work when that helps. "
    + "Do not poll or sleep waiting for background agents; end the turn once you have "
    + "started everything that can run now. An automatic reviewer inspects the repository "
    + "after every settled turn and sends the next instruction, so do not ask whether to continue.";
}

/** Marker the formulation turn ends with, so PUM can lift the proposed goal out. */
export const PROPOSED_GOAL_MARKER = "GOAL:";

/** The interview turn behind `/goalf`. It works a draft into one goal and stops. */
export function goalFormulationPrompt(draft: string): string {
  return `Work one specific, actionable goal out of this draft with me.\n\n`
    + `Draft: ${draft}\n\n`
    + "Use the questionnaire tool to ask only the questions that would change the goal: "
    + "scope, what done means, and hard constraints. Do not start the work, do not spawn "
    + "agents, and do not change any file.\n\n"
    + `End your turn with exactly one final line of the form:\n\n${PROPOSED_GOAL_MARKER} `
    + "<the goal, one paragraph, specific and checkable>";
}

/** Lift the proposed goal out of a formulation answer. */
export function parseProposedGoal(answer: string): string | undefined {
  // Built from the marker the prompt asks for, so the two cannot drift apart.
  const literal = PROPOSED_GOAL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`^\\s*${literal}\\s*(.+)$`, "gm");
  const matches = [...answer.matchAll(marker)];
  const proposed = matches.at(-1)?.[1]?.trim();
  if (!proposed || proposed.length > MAX_GOAL_TEXT) return undefined;
  return proposed;
}

/** The turn that resumes a stopped goal. */
export function goalContinuePrompt(goal: GoalRecord): string {
  return `Resume this goal.\n\nGoal: ${goal.text}\n\n`
    + "Re-check what is already done before repeating work.";
}

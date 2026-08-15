import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GOAL_RETRY_LIMIT,
  MAX_GOAL_TEXT,
  applyJudgeResult,
  continuationDelivered,
  continueGoal,
  createGoal,
  formatGoalStatus,
  goalFileFor,
  isJudgeResultCurrent,
  judgeTicketFor,
  loadGoal,
  normalizeGoalRetryLimit,
  noteSettledWork,
  parseGoalVerdict,
  parseProposedGoal,
  saveGoal,
  shouldScheduleGoalJudge,
  steerGoal,
  stopGoal,
  type GoalRecord,
} from "./goal";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempSessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-goal-"));
  temporaryDirectories.push(directory);
  return join(directory, "session-id.jsonl");
}

function active(partial: Partial<GoalRecord> = {}): GoalRecord {
  return { ...createGoal("ship the parser", DEFAULT_GOAL_RETRY_LIMIT, 1_700_000_000_000, "goal-1"), ...partial };
}

describe("goal creation", () => {
  test("starts active at generation one with no judged work", () => {
    const goal = createGoal("  ship the parser  ", 10, 42, "goal-1");
    expect(goal).toMatchObject({
      id: "goal-1",
      generation: 1,
      text: "ship the parser",
      state: "active",
      createdAt: 42,
      updatedAt: 42,
      workGeneration: 0,
      lastJudgedWorkGeneration: 0,
      judgeCount: 0,
      incompleteCount: 0,
      retryLimit: 10,
    });
  });

  test("refuses empty and oversized text", () => {
    expect(() => createGoal("   ", 10)).toThrow(/needs text/);
    expect(() => createGoal("x".repeat(MAX_GOAL_TEXT + 1), 10)).toThrow(/at most/);
  });

  test("clamps an out-of-range retry limit to the default", () => {
    expect(normalizeGoalRetryLimit(0)).toBe(0);
    expect(normalizeGoalRetryLimit(100)).toBe(100);
    expect(normalizeGoalRetryLimit(101)).toBe(DEFAULT_GOAL_RETRY_LIMIT);
    expect(normalizeGoalRetryLimit(-1)).toBe(DEFAULT_GOAL_RETRY_LIMIT);
    expect(normalizeGoalRetryLimit(2.5)).toBe(DEFAULT_GOAL_RETRY_LIMIT);
    expect(normalizeGoalRetryLimit("7")).toBe(DEFAULT_GOAL_RETRY_LIMIT);
  });
});

describe("goal transitions", () => {
  test("stop moves an active goal to stopped and bumps the generation", () => {
    const stopped = stopGoal(active(), 5);
    expect(stopped.state).toBe("stopped");
    expect(stopped.generation).toBe(2);
    expect(stopped.updatedAt).toBe(5);
  });

  test("stop drops a queued continuation and a blocked question", () => {
    const goal = active({
      state: "blocked",
      pendingQuestion: "which parser?",
      pendingContinuation: { id: "c1", text: "keep going" },
    });
    const stopped = stopGoal(goal);
    expect(stopped.pendingQuestion).toBeUndefined();
    expect(stopped.pendingContinuation).toBeUndefined();
  });

  test("stop refuses a stopped or terminal goal", () => {
    expect(() => stopGoal(active({ state: "stopped" }))).toThrow(/already stopped/);
    expect(() => stopGoal(active({ state: "completed" }))).toThrow(/replace or clear/);
    expect(() => stopGoal(active({ state: "failed" }))).toThrow(/replace or clear/);
  });

  test("continue resumes only a stopped goal", () => {
    expect(continueGoal(active({ state: "stopped" })).state).toBe("active");
    expect(() => continueGoal(active())).toThrow(/only a stopped goal/);
    expect(() => continueGoal(active({ state: "blocked" }))).toThrow(/only a stopped goal/);
    expect(() => continueGoal(active({ state: "completed" }))).toThrow(/replace or clear/);
    expect(() => continueGoal(active({ state: "failed" }))).toThrow(/replace or clear/);
  });

  test("a user message resumes a blocked goal and leaves every other state alone", () => {
    const blocked = active({ state: "blocked", pendingQuestion: "which parser?" });
    const resumed = steerGoal(blocked);
    expect(resumed.state).toBe("active");
    expect(resumed.pendingQuestion).toBeUndefined();
    expect(resumed.generation).toBe(blocked.generation + 1);

    const running = active();
    expect(steerGoal(running)).toBe(running);
    const stopped = active({ state: "stopped" });
    expect(steerGoal(stopped)).toBe(stopped);
  });

  test("a settled turn counts one reviewable work generation", () => {
    expect(noteSettledWork(active()).workGeneration).toBe(1);
    expect(noteSettledWork(noteSettledWork(active())).workGeneration).toBe(2);
  });
});

describe("review scheduling", () => {
  const base = {
    goal: noteSettledWork(active()),
    mainSettled: true,
    activeWorkerCount: 0,
    judgeInFlight: false,
    pendingInsertions: 0,
  };

  test("schedules once every condition holds", () => {
    expect(shouldScheduleGoalJudge(base)).toBe(true);
  });

  test("refuses without a goal, or for any non-active state", () => {
    expect(shouldScheduleGoalJudge({ ...base, goal: null })).toBe(false);
    for (const state of ["stopped", "blocked", "completed", "failed"] as const) {
      expect(shouldScheduleGoalJudge({ ...base, goal: { ...base.goal, state } })).toBe(false);
    }
  });

  test("refuses while the main agent works, a worker runs, or messages wait", () => {
    expect(shouldScheduleGoalJudge({ ...base, mainSettled: false })).toBe(false);
    expect(shouldScheduleGoalJudge({ ...base, activeWorkerCount: 1 })).toBe(false);
    expect(shouldScheduleGoalJudge({ ...base, pendingInsertions: 1 })).toBe(false);
  });

  test("allows only one review in flight per work generation", () => {
    expect(shouldScheduleGoalJudge({ ...base, judgeInFlight: true })).toBe(false);
    const judged = { ...base.goal, lastJudgedWorkGeneration: base.goal.workGeneration };
    expect(shouldScheduleGoalJudge({ ...base, goal: judged })).toBe(false);
    expect(shouldScheduleGoalJudge({ ...base, goal: noteSettledWork(judged) })).toBe(true);
  });

  test("refuses while a generated continuation is still owed", () => {
    const owed = { ...base.goal, pendingContinuation: { id: "c1", text: "keep going" } };
    expect(shouldScheduleGoalJudge({ ...base, goal: owed })).toBe(false);
  });

  test("the last worker settling is what makes a settled main turn reviewable", () => {
    expect(shouldScheduleGoalJudge({ ...base, activeWorkerCount: 2 })).toBe(false);
    expect(shouldScheduleGoalJudge({ ...base, activeWorkerCount: 0 })).toBe(true);
  });
});

describe("judge verdict validation", () => {
  test("accepts each complete verdict", () => {
    expect(parseGoalVerdict({ verdict: "completed", summary: "tests pass" }))
      .toEqual({ verdict: "completed", summary: "tests pass" });
    expect(parseGoalVerdict({ verdict: "incomplete", summary: "no tests", continuation: "add tests" }))
      .toEqual({ verdict: "incomplete", summary: "no tests", continuation: "add tests" });
    expect(parseGoalVerdict({ verdict: "blocked", summary: "needs a key", question: "which key?" }))
      .toEqual({ verdict: "blocked", summary: "needs a key", question: "which key?" });
  });

  test("fails closed on anything missing, unknown, or oversized", () => {
    expect(parseGoalVerdict(undefined)).toBeUndefined();
    expect(parseGoalVerdict("completed")).toBeUndefined();
    expect(parseGoalVerdict({ verdict: "done", summary: "x" })).toBeUndefined();
    expect(parseGoalVerdict({ verdict: "completed", summary: "  " })).toBeUndefined();
    expect(parseGoalVerdict({ verdict: "incomplete", summary: "x" })).toBeUndefined();
    expect(parseGoalVerdict({ verdict: "blocked", summary: "x" })).toBeUndefined();
    expect(parseGoalVerdict({ verdict: "completed", summary: "x".repeat(8_001) })).toBeUndefined();
  });
});

describe("judge results", () => {
  const settled = noteSettledWork(active());
  const ticket = judgeTicketFor(settled, "judge-1");

  test("a completed verdict ends the goal without another turn", () => {
    const { goal, action } = applyJudgeResult(settled, ticket, {
      verdict: "completed",
      summary: "parser lands in src/parse.ts and its tests pass",
    }, 9);
    expect(goal.state).toBe("completed");
    expect(goal.judgeCount).toBe(1);
    expect(goal.lastJudgedWorkGeneration).toBe(1);
    expect(action).toEqual({ kind: "completed", summary: "parser lands in src/parse.ts and its tests pass" });
  });

  test("a blocked verdict waits for the user and does not count as incomplete", () => {
    const { goal, action } = applyJudgeResult(settled, ticket, {
      verdict: "blocked",
      summary: "no credentials",
      question: "which registry token should it use?",
    });
    expect(goal.state).toBe("blocked");
    expect(goal.incompleteCount).toBe(0);
    expect(goal.pendingQuestion).toBe("which registry token should it use?");
    expect(action.kind).toBe("blocked");
  });

  test("an incomplete verdict queues exactly one continuation", () => {
    const { goal, action } = applyJudgeResult(settled, ticket, {
      verdict: "incomplete",
      summary: "no tests",
      continuation: "add tests for the parser",
    }, 9, "cont-1");
    expect(goal.state).toBe("active");
    expect(goal.incompleteCount).toBe(1);
    expect(goal.pendingContinuation).toEqual({ id: "cont-1", text: "add tests for the parser" });
    expect(action).toEqual({
      kind: "continue",
      continuation: { id: "cont-1", text: "add tests for the parser" },
    });
  });

  test("ten consecutive incomplete verdicts fail the goal by default", () => {
    let goal = settled;
    for (let round = 1; round <= DEFAULT_GOAL_RETRY_LIMIT; round++) {
      const outcome = applyJudgeResult(goal, judgeTicketFor(goal, `judge-${round}`), {
        verdict: "incomplete",
        summary: `round ${round}`,
        continuation: "keep going",
      }, 9, `cont-${round}`);
      goal = outcome.goal;
      if (round < DEFAULT_GOAL_RETRY_LIMIT) {
        expect(outcome.action.kind).toBe("continue");
        goal = noteSettledWork(continuationDelivered(goal, `cont-${round}`));
      } else {
        expect(outcome.action).toEqual({ kind: "failed", summary: `round ${round}`, attempts: 10 });
      }
    }
    expect(goal.state).toBe("failed");
    expect(goal.incompleteCount).toBe(DEFAULT_GOAL_RETRY_LIMIT);
  });

  test("retry limit 0 never fails the goal", () => {
    let goal = noteSettledWork(active({ retryLimit: 0 }));
    for (let round = 0; round < 40; round++) {
      const outcome = applyJudgeResult(goal, judgeTicketFor(goal, `judge-${round}`), {
        verdict: "incomplete",
        summary: "still going",
        continuation: "keep going",
      }, 9, `cont-${round}`);
      expect(outcome.action.kind).toBe("continue");
      goal = noteSettledWork(continuationDelivered(outcome.goal, `cont-${round}`));
    }
    expect(goal.state).toBe("active");
    expect(goal.incompleteCount).toBe(40);
  });

  test("a completed verdict resets the incomplete run", () => {
    const goal = noteSettledWork(active({ incompleteCount: 4 }));
    const outcome = applyJudgeResult(goal, judgeTicketFor(goal, "judge-1"), {
      verdict: "completed",
      summary: "done",
    });
    expect(outcome.goal.incompleteCount).toBe(0);
  });
});

describe("stale judge results", () => {
  const settled = noteSettledWork(active());
  const ticket = judgeTicketFor(settled, "judge-1");
  const verdict = { verdict: "incomplete", summary: "more work", continuation: "keep going" } as const;

  test("a stop before the verdict arrives wins the race", () => {
    const stopped = stopGoal(settled);
    expect(isJudgeResultCurrent(stopped, ticket)).toBe(false);
    const outcome = applyJudgeResult(stopped, ticket, verdict);
    expect(outcome.action.kind).toBe("ignored");
    expect(outcome.goal.state).toBe("stopped");
  });

  test("a replacement goal ignores the previous goal's verdict", () => {
    const replacement = createGoal("something else", 10, 2, "goal-2");
    expect(isJudgeResultCurrent(replacement, ticket)).toBe(false);
    expect(applyJudgeResult(replacement, ticket, verdict).action.kind).toBe("ignored");
  });

  test("a cleared goal ignores the verdict entirely", () => {
    expect(isJudgeResultCurrent(null, ticket)).toBe(false);
    expect(applyJudgeResult(null, ticket, verdict).action.kind).toBe("ignored");
  });

  test("a newer work generation ignores the older review", () => {
    expect(isJudgeResultCurrent(noteSettledWork(settled), ticket)).toBe(false);
  });

  test("the same verdict cannot be processed twice", () => {
    const first = applyJudgeResult(settled, ticket, verdict, 9, "cont-1");
    expect(first.action.kind).toBe("continue");
    const second = applyJudgeResult(first.goal, ticket, verdict, 9, "cont-2");
    expect(second.action.kind).toBe("ignored");
  });
});

describe("durable continuations", () => {
  test("delivery clears only the matching continuation", () => {
    const goal = active({ pendingContinuation: { id: "cont-1", text: "keep going" } });
    expect(continuationDelivered(goal, "cont-2")).toBe(goal);
    expect(continuationDelivered(goal, "cont-1").pendingContinuation).toBeUndefined();
  });
});

describe("goal persistence", () => {
  test("round-trips through the session companion file", () => {
    const sessionFile = tempSessionFile();
    const goal = active({ lastVerdict: { verdict: "incomplete", summary: "x", continuation: "y" } });
    saveGoal(sessionFile, goal);
    expect(existsSync(goalFileFor(sessionFile))).toBe(true);
    expect(loadGoal(sessionFile)).toEqual(goal);
  });

  test("a resumed goal keeps the judged work generation, so no review repeats", () => {
    const sessionFile = tempSessionFile();
    const judged = { ...noteSettledWork(active()), lastJudgedWorkGeneration: 1, judgeCount: 1 };
    saveGoal(sessionFile, judged);
    const resumed = loadGoal(sessionFile)!;
    expect(shouldScheduleGoalJudge({
      goal: resumed,
      mainSettled: true,
      activeWorkerCount: 0,
      judgeInFlight: false,
      pendingInsertions: 0,
    })).toBe(false);
  });

  test("clearing removes the companion file", () => {
    const sessionFile = tempSessionFile();
    saveGoal(sessionFile, active());
    saveGoal(sessionFile, null);
    expect(existsSync(goalFileFor(sessionFile))).toBe(false);
    expect(loadGoal(sessionFile)).toBeNull();
  });

  test("writes no file and leaves no temp file for a session without a goal", () => {
    const sessionFile = tempSessionFile();
    saveGoal(sessionFile, null);
    expect(existsSync(goalFileFor(sessionFile))).toBe(false);
  });

  test("a corrupt or half-written file loads as no goal", () => {
    const sessionFile = tempSessionFile();
    writeFileSync(goalFileFor(sessionFile), "{ not json");
    expect(loadGoal(sessionFile)).toBeNull();
    writeFileSync(goalFileFor(sessionFile), JSON.stringify({ id: "x", state: "active" }));
    expect(loadGoal(sessionFile)).toBeNull();
    writeFileSync(goalFileFor(sessionFile), JSON.stringify({ ...active(), state: "unknown" }));
    expect(loadGoal(sessionFile)).toBeNull();
  });

  test("a corrupt file is not destroyed by a later save of a new goal", () => {
    const sessionFile = tempSessionFile();
    writeFileSync(goalFileFor(sessionFile), "{ not json");
    const replacement = active({ id: "goal-2" });
    saveGoal(sessionFile, replacement);
    expect(JSON.parse(readFileSync(goalFileFor(sessionFile), "utf8"))).toEqual(replacement);
  });

  test("a missing session file is not an error", () => {
    expect(loadGoal(undefined)).toBeNull();
    expect(() => saveGoal(undefined, active())).not.toThrow();
  });

  test("the companion file sits beside the session JSONL", () => {
    expect(goalFileFor("/tmp/sessions/abc.jsonl")).toBe("/tmp/sessions/abc.goal.json");
  });
});

describe("goal status", () => {
  test("reports the untruncated goal, counts, and the latest verdict", () => {
    const goal = active({
      text: "x".repeat(300),
      judgeCount: 3,
      incompleteCount: 2,
      workGeneration: 4,
      lastJudgedWorkGeneration: 3,
      lastVerdict: { verdict: "incomplete", summary: "tests missing", continuation: "add them" },
    });
    const status = formatGoalStatus(goal);
    expect(status).toContain("x".repeat(300));
    expect(status).toContain("state: active");
    expect(status).toContain("judge reviews: 3");
    expect(status).toContain("consecutive incomplete: 2 (retry limit 10)");
    expect(status).toContain("settled turns: 4 (judged through 3)");
    expect(status).toContain("latest verdict: incomplete — tests missing");
  });

  test("reports an unlimited retry limit and a pending question", () => {
    const status = formatGoalStatus(active({
      retryLimit: 0,
      state: "blocked",
      pendingQuestion: "which registry?",
    }));
    expect(status).toContain("retry limit unlimited");
    expect(status).toContain("waiting on: which registry?");
  });

  test("says so when nothing is set", () => {
    expect(formatGoalStatus(null)).toContain("no goal is set");
  });
});

describe("proposed goals", () => {
  test("takes the last GOAL line of a formulation answer", () => {
    expect(parseProposedGoal("thinking...\nGOAL: first\nmore\nGOAL: final one")).toBe("final one");
  });

  test("refuses a missing or oversized proposal", () => {
    expect(parseProposedGoal("no marker here")).toBeUndefined();
    expect(parseProposedGoal(`GOAL: ${"x".repeat(MAX_GOAL_TEXT + 1)}`)).toBeUndefined();
  });
});

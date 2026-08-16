import { Type } from "typebox";
import type { GoalRecord } from "./goal";
import type { Line } from "./transcript";

/**
 * The goal judge.
 *
 * A fresh agent reviews the repository after every settled main turn and
 * returns exactly one structured verdict. It never writes files, never
 * delegates, and never talks to the main agent; the App owns every transition
 * that its verdict causes.
 */

export const GOAL_VERDICT_TOOL_NAME = "goal_verdict";

export const goalVerdictParameters = Type.Object({
  verdict: Type.String({
    description: 'Exactly one of "completed", "incomplete", or "blocked"',
  }),
  summary: Type.String({
    minLength: 1,
    maxLength: 8_000,
    description: "Evidence for completion, the work still missing, or the blocker",
  }),
  continuation: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 8_000,
    description: "Required for incomplete: the next instruction for the main agent",
  })),
  question: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 8_000,
    description: "Required for blocked: one clear question for the user",
  })),
}, { additionalProperties: false });

export const GOAL_JUDGE_INSTRUCTIONS = `## Goal review

You are the goal judge. You review work; you never do it.

- Inspect the repository yourself with read and bash. Read the diff, the tests, and the code.
- Judge only against the stated goal. Do not invent extra requirements.
- Evidence means something you looked at, named exactly: a file, a diff hunk, a test run.
- Call ${GOAL_VERDICT_TOOL_NAME} exactly once and then stop. It is your only output.
- "completed" needs evidence that the goal is actually met, not a claim that it is.
- "incomplete" needs the missing work and one continuation message written to the main agent.
- "blocked" needs one clear question for the user, and only when no agent can decide it.
- Never change a file, commit, delegate, spawn an agent, or start a background process.`;

export const MUTABLE_JUDGE_WARNING = "The OS sandbox is off, so your tools can write. "
  + "You must not. Do not create, modify, move, or delete any file, do not commit, "
  + "and do not run any command that changes the repository or the machine.";

/** Bound on each block of context the judge prompt carries. */
const MAX_DIFF_CHARS = 20_000;
const MAX_STATUS_CHARS = 4_000;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_TRANSCRIPT_LINES = 60;

function clipTail(text: string, max: number): string {
  const value = text.trimEnd();
  if (value.length <= max) return value;
  return `…(earlier output omitted)…\n${value.slice(value.length - max)}`;
}

/** Flatten the recent main transcript into reviewable plain text. */
export function judgeTranscript(lines: readonly Line[]): string {
  const recent = lines.slice(-MAX_TRANSCRIPT_LINES);
  const rendered: string[] = [];
  for (const line of recent) {
    if (line.kind === "text") {
      if (line.role === "thinking") continue;
      rendered.push(`${line.role}: ${line.text}`);
    } else if (line.kind === "tool") {
      const detail = line.call.args.length > 0 ? ` ${line.call.args.join(", ")}` : "";
      rendered.push(`tool ${line.call.name}${detail} [${line.call.state}]`);
    } else {
      rendered.push(`${line.sender} → ${line.recipient}: ${line.text}`);
    }
  }
  return clipTail(rendered.join("\n"), MAX_TRANSCRIPT_CHARS);
}

export type RepositoryState = {
  status: string;
  diff: string;
  log: string;
};

/** Runs one git invocation as explicit arguments. No shell, no model input. */
export type GitRunner = (args: string[]) => Promise<string>;

/** Collect the repository state the judge reviews. A failed command is reported, not thrown. */
export async function collectRepositoryState(run: GitRunner): Promise<RepositoryState> {
  const capture = async (args: string[], max: number) => {
    try {
      return clipTail(await run(args), max);
    } catch (error) {
      return `(git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)})`;
    }
  };
  const [status, stat, patch, log] = await Promise.all([
    capture(["status", "--porcelain=v1", "--untracked-files=all"], MAX_STATUS_CHARS),
    capture(["diff", "HEAD", "--stat"], MAX_STATUS_CHARS),
    capture(["diff", "HEAD"], MAX_DIFF_CHARS),
    capture(["log", "--oneline", "-20"], MAX_STATUS_CHARS),
  ]);
  return { status, diff: `${stat}\n\n${patch}`.trim(), log };
}

export type JudgeTaskInput = {
  goal: GoalRecord;
  transcript: string;
  repository: RepositoryState;
  /** Test output the session already produced, when there is any. */
  tests?: string;
  /** True when the judge runs without OS sandbox enforcement. */
  mutable: boolean;
};

function block(title: string, body: string): string {
  // Only trailing whitespace goes. A porcelain status line starts with a
  // significant space, and trimming it would change what the judge reads.
  const content = body.replace(/\s+$/, "");
  return `### ${title}\n\n${content.trim() ? content : "(none)"}\n`;
}

/** The complete review task handed to one fresh judge agent. */
export function buildJudgeTask(input: JudgeTaskInput): string {
  const attempt = input.goal.incompleteCount;
  const limit = input.goal.retryLimit === 0 ? "unlimited" : String(input.goal.retryLimit);
  const parts = [
    GOAL_JUDGE_INSTRUCTIONS,
    input.mutable ? `\n**${MUTABLE_JUDGE_WARNING}**` : "",
    `\n## The goal\n\n${input.goal.text}`,
    `\nConsecutive incomplete reviews so far: ${attempt} (retry limit ${limit}).`,
    `\n## Context\n`,
    block("Recent main-agent transcript", input.transcript),
    block("git status", input.repository.status),
    block("git log", input.repository.log),
    block("git diff against HEAD", input.repository.diff),
  ];
  if (input.tests) parts.push(block("Test results", input.tests));
  parts.push(
    `\nReview the work against the goal, then call ${GOAL_VERDICT_TOOL_NAME} exactly once.`,
  );
  return parts.filter(Boolean).join("\n");
}

/** Summary shown to the user when a goal ends. */
export function goalOutcomeMessage(
  kind: "completed" | "failed",
  goal: GoalRecord,
  summary: string,
): string {
  if (kind === "completed") {
    return `goal completed: ${goal.text}\n\n${summary}`;
  }
  return `goal failed after ${goal.incompleteCount} consecutive incomplete reviews: ${goal.text}\n\n`
    + `latest judge reason: ${summary}`;
}

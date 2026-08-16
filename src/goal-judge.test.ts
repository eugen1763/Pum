import { describe, expect, test } from "bun:test";
import {
  GOAL_VERDICT_TOOL_NAME,
  MUTABLE_JUDGE_WARNING,
  buildJudgeTask,
  collectRepositoryState,
  goalOutcomeMessage,
  goalVerdictParameters,
  judgeTranscript,
} from "./goal-judge";
import { createGoal, parseGoalVerdict } from "./goal";
import { judgeAllowedToolNames } from "./tool-groups";
import { readonlyToolBlockReason } from "./subagents/readonly";
import type { Line } from "./transcript";

const goal = createGoal("ship the parser", 10, 1, "goal-1");

describe("judge tool", () => {
  test("its schema carries every field the verdict validator needs", () => {
    const properties = goalVerdictParameters.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["continuation", "question", "summary", "verdict"]);
    expect([...goalVerdictParameters.required]).toEqual(["verdict", "summary"]);
  });

  test("a judge session holds only read, bash, and the verdict tool", () => {
    expect(judgeAllowedToolNames().sort()).toEqual(["bash", GOAL_VERDICT_TOOL_NAME, "read"].sort());
    for (const blocked of [
      "write", "edit", "apply_patch", "spawn_subagent", "message_agent",
      "finish_subagent", "worktree", "create_trigger", "start_shell",
    ]) {
      expect(judgeAllowedToolNames()).not.toContain(blocked);
    }
  });

  test("the readonly guard lets the verdict tool through and still blocks mutation", () => {
    expect(readonlyToolBlockReason(GOAL_VERDICT_TOOL_NAME)).toBeUndefined();
    expect(readonlyToolBlockReason("write")).toBeDefined();
    expect(readonlyToolBlockReason("spawn_subagent")).toBeDefined();
  });
});

describe("judge task", () => {
  const repository = { status: " M src/parse.ts", diff: "@@ -1 +1 @@", log: "abc parse" };

  test("carries the goal, the transcript, and the repository state", () => {
    const task = buildJudgeTask({
      goal,
      transcript: "assistant: wrote the parser",
      repository,
      mutable: false,
    });
    expect(task).toContain("ship the parser");
    expect(task).toContain("assistant: wrote the parser");
    expect(task).toContain(" M src/parse.ts");
    expect(task).toContain("@@ -1 +1 @@");
    expect(task).toContain("abc parse");
    expect(task).toContain(GOAL_VERDICT_TOOL_NAME);
  });

  test("names the retry position, so the judge knows the stakes", () => {
    const task = buildJudgeTask({
      goal: { ...goal, incompleteCount: 7 },
      transcript: "",
      repository,
      mutable: false,
    });
    expect(task).toContain("Consecutive incomplete reviews so far: 7 (retry limit 10)");
    const unlimited = buildJudgeTask({
      goal: { ...goal, retryLimit: 0 },
      transcript: "",
      repository,
      mutable: false,
    });
    expect(unlimited).toContain("retry limit unlimited");
  });

  test("adds the do-not-mutate warning only without an enforced sandbox", () => {
    expect(buildJudgeTask({ goal, transcript: "", repository, mutable: true }))
      .toContain(MUTABLE_JUDGE_WARNING);
    expect(buildJudgeTask({ goal, transcript: "", repository, mutable: false }))
      .not.toContain(MUTABLE_JUDGE_WARNING);
  });

  test("includes test output when the session produced any", () => {
    const task = buildJudgeTask({
      goal,
      transcript: "",
      repository,
      tests: "12 pass 0 fail",
      mutable: false,
    });
    expect(task).toContain("12 pass 0 fail");
  });

  test("forbids doing the work, delegating it, and reporting twice", () => {
    const task = buildJudgeTask({ goal, transcript: "", repository, mutable: false });
    expect(task).toContain("You review work; you never do it.");
    expect(task).toContain("delegate");
    expect(task).toContain("exactly once");
  });
});

describe("judge transcript", () => {
  test("renders text, tool, and inter-agent rows and drops reasoning", () => {
    const lines: Line[] = [
      { kind: "text", role: "user", text: "add a parser" },
      { kind: "text", role: "thinking", text: "secret reasoning" },
      { kind: "text", role: "assistant", text: "done" },
      { kind: "tool", call: { id: "1", name: "bash", args: ["bun test"], state: "ok" } },
      { kind: "agent-message", sender: "worker", recipient: "main", text: "blocked" },
    ];
    const rendered = judgeTranscript(lines);
    expect(rendered).toContain("user: add a parser");
    expect(rendered).toContain("assistant: done");
    expect(rendered).toContain("tool bash bun test [ok]");
    expect(rendered).toContain("worker → main: blocked");
    expect(rendered).not.toContain("secret reasoning");
  });

  test("keeps the newest rows and stays bounded", () => {
    const lines: Line[] = Array.from({ length: 400 }, (_, index) => ({
      kind: "text",
      role: "assistant",
      text: `line ${index} ${"x".repeat(200)}`,
    }));
    const rendered = judgeTranscript(lines);
    expect(rendered.length).toBeLessThanOrEqual(12_100);
    expect(rendered).toContain("line 399");
    expect(rendered).not.toContain("line 0 ");
  });
});

describe("repository state", () => {
  test("runs git with explicit arguments and no shell text", async () => {
    const seen: string[][] = [];
    const state = await collectRepositoryState(async (args) => {
      seen.push(args);
      return args[0]!;
    });
    expect(seen).toEqual([
      ["status", "--porcelain=v1", "--untracked-files=all"],
      ["diff", "HEAD", "--stat"],
      ["diff", "HEAD"],
      ["log", "--oneline", "-20"],
    ]);
    expect(state.status).toBe("status");
    expect(state.log).toBe("log");
    for (const args of seen) expect(args.join(" ")).not.toContain("&&");
  });

  test("a failed command is reported inside the prompt, never thrown", async () => {
    const state = await collectRepositoryState(async (args) => {
      if (args[0] === "diff") throw new Error("not a repository");
      return "";
    });
    expect(state.diff).toContain("not a repository");
    expect(state.status).toBe("");
  });

  test("a huge diff is clipped to its tail", async () => {
    const state = await collectRepositoryState(async (args) =>
      args[0] === "diff" && args.length === 2 ? "y".repeat(60_000) : "");
    expect(state.diff.length).toBeLessThan(21_000);
    expect(state.diff).toContain("earlier output omitted");
  });
});

describe("goal outcome messages", () => {
  test("completion shows the goal and the evidence", () => {
    expect(goalOutcomeMessage("completed", goal, "tests pass"))
      .toBe("goal completed: ship the parser\n\ntests pass");
  });

  test("failure names the attempts and the latest reason", () => {
    const message = goalOutcomeMessage("failed", { ...goal, incompleteCount: 10 }, "still no tests");
    expect(message).toContain("failed after 10 consecutive incomplete reviews");
    expect(message).toContain("latest judge reason: still no tests");
  });
});

describe("verdict round trip", () => {
  test("what the tool accepts is what the validator accepts", () => {
    expect(parseGoalVerdict({
      verdict: "incomplete",
      summary: "no tests",
      continuation: "add tests",
      question: undefined,
    })).toEqual({ verdict: "incomplete", summary: "no tests", continuation: "add tests" });
  });
});

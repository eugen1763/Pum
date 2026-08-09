import { describe, expect, test } from "bun:test";
import { buildStashBatchPrompt, selectedRange } from "./stash-batch";

describe("stash batch selection", () => {
  test("selects every row between the anchor and cursor", () => {
    expect([...selectedRange(4, 1)]).toEqual([1, 2, 3, 4]);
  });

  test("asks the main agent to group, run, and merge worktree tasks", () => {
    const prompt = buildStashBatchPrompt(["Fix parser", "Add parser tests"]);
    expect(prompt).toContain("Count only starting and running subagents as active");
    expect(prompt).toContain("while fewer than five subagents are active");
    expect(prompt).toContain("queue related work to an appropriate running subagent with message_agent");
    expect(prompt).toContain("durable recipient-side message and steering queue");
    expect(prompt).toContain("Keep it pending when no appropriate recipient is clear");
    expect(prompt).toContain("You may group related tasks into one subagent");
    expect(prompt).toContain("Run independent task groups in parallel");
    expect(prompt).toContain("Merge each successful subagent");
    expect(prompt).toContain("as soon as it settles");
    expect(prompt).toContain("concrete dependency");
    expect(prompt).toContain("<task 1>\nFix parser\n</task 1>");
    expect(prompt).toContain("<task 2>\nAdd parser tests\n</task 2>");
  });
});

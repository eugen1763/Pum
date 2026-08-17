import { describe, expect, test } from "bun:test";
import { isGoalCommand, parseGoalCommand } from "../src/goal-command";
import { MAX_GOAL_TEXT } from "../src/goal";
import { matchingCommands } from "../src/commands";

describe("goal command matching", () => {
  test("claims only the two goal commands", () => {
    expect(isGoalCommand("/goal fix the tests")).toBe(true);
    expect(isGoalCommand("  /goal  ")).toBe(true);
    expect(isGoalCommand("/goalf improve startup")).toBe(true);
    expect(isGoalCommand("/goals")).toBe(false);
    expect(isGoalCommand("/news")).toBe(false);
    expect(isGoalCommand("goal stop")).toBe(false);
  });

  test("both appear in the suggestion list", () => {
    expect(matchingCommands("/goal").map((command) => command.name))
      .toEqual(["/goal", "/goalf"]);
    expect(matchingCommands("/goalf").map((command) => command.name)).toEqual(["/goalf"]);
  });

  test("returns null for anything else, so other commands still run", () => {
    expect(parseGoalCommand("/news")).toBeNull();
    expect(parseGoalCommand("/goals list")).toBeNull();
    expect(parseGoalCommand("just a prompt")).toBeNull();
  });
});

describe("goal command parsing", () => {
  test("a lone word is a control action", () => {
    for (const control of ["stop", "continue", "status", "clear"] as const) {
      expect(parseGoalCommand(`/goal ${control}`)).toEqual({ kind: "control", control });
      expect(parseGoalCommand(`/goal ${control.toUpperCase()}`)).toEqual({ kind: "control", control });
    }
  });

  test("a longer argument is goal text, even when it starts with a control word", () => {
    expect(parseGoalCommand("/goal stop the flaky tests"))
      .toEqual({ kind: "set", text: "stop the flaky tests" });
    expect(parseGoalCommand("/goal fix the flaky tests"))
      .toEqual({ kind: "set", text: "fix the flaky tests" });
  });

  test("multiline goal text survives", () => {
    expect(parseGoalCommand("/goal first line\nsecond line"))
      .toEqual({ kind: "set", text: "first line\nsecond line" });
  });

  test("an unknown lone word is a useful error, not a goal", () => {
    const command = parseGoalCommand("/goal resume");
    expect(command?.kind).toBe("error");
    expect(command && "message" in command && command.message).toContain('unknown /goal action "resume"');
  });

  test("missing text is an error for both commands", () => {
    expect(parseGoalCommand("/goal")).toMatchObject({ kind: "error" });
    expect(parseGoalCommand("/goal   ")).toMatchObject({ kind: "error" });
    expect(parseGoalCommand("/goalf")).toMatchObject({ kind: "error" });
  });

  test("oversized text is refused rather than silently cut", () => {
    expect(parseGoalCommand(`/goal ${"x".repeat(MAX_GOAL_TEXT + 1)}`))
      .toMatchObject({ kind: "error" });
    expect(parseGoalCommand(`/goalf ${"x".repeat(MAX_GOAL_TEXT + 1)}`))
      .toMatchObject({ kind: "error" });
  });

  test("goalf takes the whole argument as a draft", () => {
    expect(parseGoalCommand("/goalf improve startup"))
      .toEqual({ kind: "formulate", draft: "improve startup" });
    // No control words: every /goalf argument is a draft.
    expect(parseGoalCommand("/goalf stop")).toEqual({ kind: "formulate", draft: "stop" });
  });
});

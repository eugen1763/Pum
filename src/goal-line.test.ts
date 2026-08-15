import { describe, expect, test } from "bun:test";
import { GOAL_LABEL_RIGHT_PADDING, goalLabel, goalLabelColor } from "./goal-line";
import { createGoal, type GoalRecord, type GoalState } from "./goal";
import { statusTextWidth } from "./status-metadata";
import { PRESET_NAMES, loadTheme } from "./theme";

function goal(text: string, state: GoalState = "active"): GoalRecord {
  return { ...createGoal(text, 10, 1, "goal-1"), state };
}

describe("goal label", () => {
  test("shows the prefix, the state, and the goal", () => {
    const label = goalLabel(goal("fix the flaky tests"), 120);
    expect(label?.text).toBe("GOAL · active · fix the flaky tests  ");
  });

  test("ends with exactly two columns of padding", () => {
    const label = goalLabel(goal("fix the flaky tests"), 120)!;
    expect(label.text.endsWith(" ".repeat(GOAL_LABEL_RIGHT_PADDING))).toBe(true);
    expect(label.text.at(-GOAL_LABEL_RIGHT_PADDING - 1)).not.toBe(" ");
  });

  test("reports its own rendered width", () => {
    const label = goalLabel(goal("fix the flaky tests"), 120)!;
    expect(label.width).toBe(statusTextWidth(label.text));
  });

  test("never takes more than half the rule", () => {
    for (const width of [24, 40, 80, 120, 200]) {
      const label = goalLabel(goal("x".repeat(500)), width);
      if (!label) continue;
      expect(label.width).toBeLessThanOrEqual(Math.floor(width / 2));
      expect(label.width).toBeLessThanOrEqual(width);
    }
  });

  test("truncates by terminal columns without splitting a grapheme", () => {
    const label = goalLabel(goal("模型模型模型模型模型模型模型模型"), 60)!;
    expect(statusTextWidth(label.text)).toBe(label.width);
    expect(label.text).toContain("…");
    const combining = goalLabel(goal("éclair éclair éclair"), 60)!;
    expect(combining.text).not.toContain("́…");
  });

  test("collapses a multi-line goal so the rule stays one row", () => {
    const label = goalLabel(goal("first line\n\nsecond line"), 120)!;
    expect(label.text).not.toContain("\n");
    expect(label.text).toContain("first line second line");
  });

  test("drops the label rather than overflowing a narrow terminal", () => {
    expect(goalLabel(goal("fix the flaky tests"), 0)).toBeNull();
    expect(goalLabel(goal("fix the flaky tests"), 8)).toBeNull();
    expect(goalLabel(null, 120)).toBeNull();
  });

  test("narrow-but-usable terminals keep the state and the padding", () => {
    const label = goalLabel(goal("fix the flaky tests"), 30)!;
    expect(label.text.startsWith("GOAL · active")).toBe(true);
    expect(label.text.endsWith("  ")).toBe(true);
    expect(label.width).toBeLessThanOrEqual(30);
  });

  test("every lifecycle state renders", () => {
    for (const state of ["active", "stopped", "blocked", "completed", "failed"] as const) {
      const label = goalLabel(goal("fix the flaky tests", state), 120)!;
      expect(label.state).toBe(state);
      expect(label.text).toContain(`· ${state} ·`);
    }
  });
});

describe("goal label colour", () => {
  test("uses a distinct semantic token per state in every preset", () => {
    for (const name of PRESET_NAMES) {
      const theme = loadTheme(name);
      expect(goalLabelColor(theme, "active")).toBe(theme.accent);
      expect(goalLabelColor(theme, "blocked")).toBe(theme.warn);
      expect(goalLabelColor(theme, "completed")).toBe(theme.success);
      expect(goalLabelColor(theme, "failed")).toBe(theme.error);
      expect(goalLabelColor(theme, "stopped")).toBe(theme.goalLabel);
    }
  });

  test("no preset paints the label in its own rule colour", () => {
    for (const name of PRESET_NAMES) {
      const theme = loadTheme(name);
      for (const state of ["active", "stopped", "blocked", "completed", "failed"] as const) {
        expect(goalLabelColor(theme, state)).not.toBe(theme.border);
      }
    }
  });
});

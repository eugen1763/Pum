import { describe, expect, test } from "bun:test";
import {
  coordinatedRuleState,
  markdownCaretContent,
  ruleText,
  workingRuleFrameState,
} from "./animation";
import { rgba } from "./theme";
import { goalLabel } from "./goal-line";
import { createGoal } from "./goal";

describe("coordinated working rules", () => {
  test("keeps both rules in the active pair synchronized", () => {
    const elapsedMs = 50;
    const inputTop = workingRuleFrameState("coordinated", "inputTop", 10, elapsedMs);
    const inputBottom = workingRuleFrameState("coordinated", "inputBottom", 10, elapsedMs);

    expect(inputTop).toEqual({ head: 4, direction: 1, pair: "input" });
    expect(inputBottom).toEqual(inputTop);
    expect(workingRuleFrameState("coordinated", "headerTop", 10, elapsedMs)).toBeNull();
    expect(workingRuleFrameState("coordinated", "headerBottom", 10, elapsedMs)).toBeNull();
  });

  test("starts at the input left edge and moves the input pair left-to-right", () => {
    expect(coordinatedRuleState(10, 0)).toEqual({ head: 0, direction: 1, pair: "input" });
    expect(coordinatedRuleState(10, 50)).toEqual({ head: 4, direction: 1, pair: "input" });
    expect(coordinatedRuleState(10, 100)).toEqual({ head: 8, direction: 1, pair: "input" });
  });

  test("jumps from the input right edge to the header right edge", () => {
    const headerStartMs = 112.5;

    expect(workingRuleFrameState("coordinated", "inputTop", 10, headerStartMs)).toBeNull();
    expect(workingRuleFrameState("coordinated", "headerTop", 10, headerStartMs)).toEqual({
      head: 9,
      direction: -1,
      pair: "header",
    });
    expect(workingRuleFrameState("coordinated", "headerBottom", 10, headerStartMs)).toEqual(
      workingRuleFrameState("coordinated", "headerTop", 10, headerStartMs),
    );
  });

  test("moves the header pair right-to-left while the input pair stays static", () => {
    const elapsedMs = 162.5;

    expect(workingRuleFrameState("coordinated", "headerTop", 10, elapsedMs)).toEqual({
      head: 5,
      direction: -1,
      pair: "header",
    });
    expect(workingRuleFrameState("coordinated", "headerBottom", 10, elapsedMs)).toEqual(
      workingRuleFrameState("coordinated", "headerTop", 10, elapsedMs),
    );
    expect(workingRuleFrameState("coordinated", "inputTop", 10, elapsedMs)).toBeNull();
    expect(workingRuleFrameState("coordinated", "inputBottom", 10, elapsedMs)).toBeNull();
  });

  test("resets to the input pair's left edge after the header reaches the left", () => {
    expect(coordinatedRuleState(10, 225)).toEqual({ head: 0, direction: 1, pair: "input" });
    expect(workingRuleFrameState("coordinated", "inputTop", 1, 25)).toEqual({
      head: 0,
      direction: 1,
      pair: "input",
    });
  });

  test("keeps the active half-cycle stable across narrow terminal resizes", () => {
    expect(coordinatedRuleState(100, 700, 100)).toMatchObject({ pair: "input", direction: 1 });
    expect(coordinatedRuleState(40, 700, 100)).toMatchObject({ pair: "input", direction: 1 });
    expect(coordinatedRuleState(40, 700, 100).head).toBeLessThan(39);
  });

  test("keeps input-only and off compatibility for all four roles", () => {
    expect(workingRuleFrameState("input-only", "headerTop", 10, 50)).toBeNull();
    expect(workingRuleFrameState("input-only", "headerBottom", 10, 50)).toBeNull();
    expect(workingRuleFrameState("input-only", "inputTop", 10, 50)).toEqual({
      head: 4,
      direction: 1,
      pair: "input",
    });
    expect(workingRuleFrameState("input-only", "inputBottom", 10, 50)).toEqual({
      head: 4,
      direction: 1,
      pair: "input",
    });
    for (const role of ["headerTop", "headerBottom", "inputTop", "inputBottom"] as const) {
      expect(workingRuleFrameState("off", role, 10, 50)).toBeNull();
    }
  });
});

describe("Markdown streaming caret", () => {
  test("appends one stable non-whitespace caret after a partial heading marker", () => {
    const content = markdownCaretContent("#");

    expect(content).toBe("#▊");
    expect(/\s/u.test(content.at(-1)!)).toBe(false);
  });
});

describe("goal label on the working rule", () => {
  const base = rgba("#292e42");
  const highlight = rgba("#ffffff");
  const label = { text: "GOAL · active · ship it  ", width: 25, color: "#7aa2f7" };
  const plainWidth = (text: import("@opentui/core").StyledText) =>
    text.chunks.reduce((width, chunk) => width + Bun.stringWidth(chunk.text ?? ""), 0);

  test("the row is exactly the rule width, label included", () => {
    for (const width of [30, 80, 120]) {
      const painted = ruleText(width, base, highlight, () => 0, label);
      expect(plainWidth(painted)).toBe(width);
    }
  });

  test("the label sits at the right end, after the rule glyphs", () => {
    const painted = ruleText(80, base, highlight, () => 0, label);
    const text = painted.chunks.map((chunk) => chunk.text ?? "").join("");
    expect(text.startsWith("─")).toBe(true);
    expect(text.endsWith("ship it  ")).toBe(true);
    expect(text).toBe(`${"─".repeat(80 - label.width)}${label.text}`);
  });

  test("the label carries the rule colour as its background", () => {
    const painted = ruleText(40, base, highlight, () => 0, label);
    const labelChunks = painted.chunks.filter((chunk) => (chunk.text ?? "") !== "─");
    expect(labelChunks.length).toBeGreaterThan(0);
    for (const chunk of labelChunks) expect(chunk.bg).toEqual(base);
  });

  test("the sweep reaches the label, so the whole row animates as one", () => {
    const width = 80;
    const overLabel = width - 1;
    const swept = ruleText(width, base, highlight, (column) => (column === overLabel ? 1 : 0), label);
    const last = swept.chunks.at(-1)!;
    expect(last.bg).not.toEqual(base);
    const still = ruleText(width, base, highlight, () => 0, label);
    expect(still.chunks.at(-1)!.bg).toEqual(base);
  });

  test("a static rule with no label is unchanged plain rule", () => {
    const painted = ruleText(12, base, highlight, () => 0, null);
    expect(painted.chunks.map((chunk) => chunk.text ?? "").join("")).toBe("─".repeat(12));
  });

  test("a wide-character label still fills exactly the rule width", () => {
    const wide = goalLabel(createGoal("模型模型模型模型", 10, 1, "g"), 60)!;
    const painted = ruleText(60, base, highlight, () => 0, { ...wide, color: "#7aa2f7" });
    expect(plainWidth(painted)).toBe(60);
  });
});

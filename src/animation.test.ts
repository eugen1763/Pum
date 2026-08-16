import { describe, expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";
import {
  coordinatedRuleState,
  markdownCaretContent,
  randomConstellationCenters,
  ruleText,
  workingRuleCell,
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

describe("additional working-rule animations", () => {
  test("sparkle trail adds three width-stable sparkles to the active pair", () => {
    const cells = Array.from({ length: 30 }, (_, column) =>
      workingRuleCell("sparkle-trail", "inputTop", 30, 200, column));
    expect(cells.map((cell) => cell.glyph).filter((glyph) => glyph !== "─")).toEqual([
      "·", "✧", "✦",
    ]);
    expect(workingRuleCell("sparkle-trail", "headerTop", 30, 200, 16)).toEqual({
      strength: 0,
      glyph: "─",
    });
  });

  test("comet pair mirrors two equally bright heads", () => {
    const left = workingRuleCell("comet-pair", "inputTop", 40, 200, 7);
    const right = workingRuleCell("comet-pair", "inputTop", 40, 200, 32);
    expect(left.strength).toBeCloseTo(1);
    expect(right.strength).toBeCloseTo(1);
    expect(left.glyph).toBe("─");
  });

  test("electric spark is deterministic and becomes quiet between flashes", () => {
    const first = Array.from({ length: 50 }, (_, column) =>
      workingRuleCell("electric-spark", "headerBottom", 50, 10, column));
    const again = Array.from({ length: 50 }, (_, column) =>
      workingRuleCell("electric-spark", "headerBottom", 50, 10, column));
    expect(first).toEqual(again);
    expect(first.some((cell) => cell.glyph === "╴")).toBe(true);
    expect(Array.from({ length: 50 }, (_, column) =>
      workingRuleCell("electric-spark", "headerBottom", 50, 120, column))
      .every((cell) => cell.strength === 0)).toBe(true);
  });

  test("constellation keeps fixed star positions while brightness changes", () => {
    const early = Array.from({ length: 60 }, (_, column) =>
      workingRuleCell("constellation", "inputBottom", 60, 0, column));
    const later = Array.from({ length: 60 }, (_, column) =>
      workingRuleCell("constellation", "inputBottom", 60, 700, column));
    const starPositions = (cells: typeof early) => cells
      .map((cell, column) => cell.glyph === "─" ? -1 : column)
      .filter((column) => column >= 0);
    expect(starPositions(early)).toEqual(starPositions(later));
    expect(early.map((cell) => cell.strength)).not.toEqual(later.map((cell) => cell.strength));
  });

  test("energy transfers from the input pair to the header pair", () => {
    const inputCharge = workingRuleCell("energy-transfer", "inputTop", 41, 700, 3);
    const quietHeader = workingRuleCell("energy-transfer", "headerTop", 41, 700, 3);
    const quietInput = workingRuleCell("energy-transfer", "inputTop", 41, 2500, 10);
    const headerWave = workingRuleCell("energy-transfer", "headerTop", 41, 2500, 10);
    expect(inputCharge.strength).toBeGreaterThan(0);
    expect(quietHeader.strength).toBe(0);
    expect(quietInput.strength).toBe(0);
    expect(headerWave.strength).toBeGreaterThan(0);
  });

  test("random constellation fades three-cell sparkles over two seconds", () => {
    const width = 80;
    const centers = randomConstellationCenters(width, 0, "inputTop");
    expect(centers).toEqual(randomConstellationCenters(width, 0, "inputTop"));
    expect(centers).not.toEqual(randomConstellationCenters(width, 1, "inputTop"));
    const center = centers[0]!;
    expect(workingRuleCell("random-constellation", "inputTop", width, 0, center))
      .toEqual({ strength: 0, glyph: "─" });
    expect(workingRuleCell("random-constellation", "inputTop", width, 1000, center))
      .toEqual({ strength: 1, glyph: "✦" });
    expect(workingRuleCell("random-constellation", "inputTop", width, 1000, center - 1))
      .toEqual({ strength: 0.62, glyph: "✧" });
    expect(workingRuleCell("random-constellation", "inputTop", width, 1000, center + 1))
      .toEqual({ strength: 0.62, glyph: "✧" });
    expect(workingRuleCell("random-constellation", "inputTop", width, 2000, center))
      .toEqual({ strength: 0, glyph: "─" });
  });

  test("sparkle glyphs keep the rendered rule exactly one row wide", () => {
    const width = 50;
    const cells = Array.from({ length: width }, (_, column) =>
      workingRuleCell("constellation", "inputTop", width, 300, column));
    const painted = ruleText(
      width,
      rgba("#292e42"),
      rgba("#ffffff"),
      (column) => cells[column]!.strength,
      null,
      0,
      (column) => cells[column]!.glyph,
    );
    expect(painted.chunks.reduce((total, chunk) => total + Bun.stringWidth(chunk.text ?? ""), 0))
      .toBe(width);
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
  const label = { text: " GOAL · active · ship it ", width: 25, color: "#7aa2f7" };
  const plainWidth = (text: import("@opentui/core").StyledText) =>
    text.chunks.reduce((width, chunk) => width + Bun.stringWidth(chunk.text ?? ""), 0);

  test("the row is exactly the rule width, label included", () => {
    for (const width of [30, 80, 120]) {
      const painted = ruleText(width, base, highlight, () => 0, label);
      expect(plainWidth(painted)).toBe(width);
    }
  });

  test("the label keeps two plain rule columns at the right edge", () => {
    const painted = ruleText(80, base, highlight, () => 0, label, 2);
    const text = painted.chunks.map((chunk) => chunk.text ?? "").join("");
    expect(text.startsWith("─")).toBe(true);
    expect(text.endsWith("ship it ──")).toBe(true);
    expect(text).toBe(`${"─".repeat(80 - label.width - 2)}${label.text}──`);
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

describe("several labels on one working rule", () => {
  const base = rgba("#292e42");
  const highlight = rgba("#ffffff");
  const afk = { text: " AFK · on ", width: 10, color: "#bb9af7" };
  const goal = { text: " GOAL · active · ship it ", width: 25, color: "#7aa2f7" };
  const plainWidth = (text: StyledText) =>
    text.chunks.reduce((width, chunk) => width + Bun.stringWidth(chunk.text ?? ""), 0);
  const painted = (text: StyledText) => text.chunks.map((chunk) => chunk.text ?? "").join("");

  test("the row is exactly the rule width at every terminal size", () => {
    for (const width of [30, 40, 80, 120]) {
      expect(plainWidth(ruleText(width, base, highlight, () => 0, [afk, goal]))).toBe(width);
    }
  });

  test("both labels share one row, in order, after the rule glyphs", () => {
    const row = painted(ruleText(80, base, highlight, () => 0, [afk, goal]));
    expect(row).toBe(`${"─".repeat(80 - afk.width - goal.width)}${afk.text}${goal.text}`);
  });

  test("each label keeps its own foreground on the shared rule background", () => {
    const row = ruleText(80, base, highlight, () => 0, [afk, goal]);
    const labelChunks = row.chunks.filter((chunk) => (chunk.text ?? "") !== "─");
    expect(labelChunks.length).toBeGreaterThan(0);
    for (const chunk of labelChunks) expect(chunk.bg).toEqual(base);
    const foregrounds = labelChunks.map((chunk) => chunk.fg);
    expect(foregrounds.at(0)).toEqual(rgba(afk.color));
    expect(foregrounds.at(-1)).toEqual(rgba(goal.color));
    expect(new Set(foregrounds.map((color) => String(color))).size).toBe(2);
  });

  test("a lone label still works, so the single-label call shape is unchanged", () => {
    const one = ruleText(80, base, highlight, () => 0, goal);
    expect(painted(one)).toBe(painted(ruleText(80, base, highlight, () => 0, [goal])));
  });

  test("the sweep reaches every label, so the whole row animates as one", () => {
    const width = 80;
    const overAfk = width - goal.width - afk.width;
    const swept = ruleText(width, base, highlight, (c) => (c === overAfk ? 1 : 0), [afk, goal]);
    const first = swept.chunks.find((chunk) => (chunk.text ?? "") !== "─")!;
    expect(first.bg).not.toEqual(base);
  });

  test("a grapheme that would overflow a later label is dropped, never split", () => {
    const narrow = [
      { text: "AB", width: 2, color: "#bb9af7" },
      { text: "模型", width: 4, color: "#7aa2f7" },
    ];
    const row = ruleText(5, base, highlight, () => 0, narrow);
    expect(plainWidth(row)).toBe(5);
    expect(painted(row)).toBe("AB模─");
  });

  test("animations off paints the same labels with no highlight anywhere", () => {
    const still = ruleText(60, base, base, () => 0, [afk, goal]);
    expect(plainWidth(still)).toBe(60);
    expect(painted(still)).toContain(`${afk.text}${goal.text}`);
    for (const chunk of still.chunks) expect(chunk.bg ?? base).toEqual(base);
  });
});

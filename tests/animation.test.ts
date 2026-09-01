import { describe, expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";
import {
  CARET_PERIOD_MS,
  GLOW_KNEE,
  PULSE_PERIOD_MS,
  TRAIL_HALF_LIFE_MS,
  bloomColor,
  caretAlpha,
  constellationStar,
  coordinatedRuleState,
  decayTrail,
  glowColor,
  glowFalloff,
  markdownCaretContent,
  pulseGlyph,
  randomConstellationCenters,
  randomConstellationStart,
  ruleText,
  shimmer,
  weightedGlyph,
  workingRuleCell,
  workingRuleFrameState,
  type WorkingRuleRole,
} from "../src/animation";
import { rgba } from "../src/theme";
import { goalLabel } from "../src/goal-line";
import { createGoal } from "../src/goal";

describe("coordinated working rules", () => {
  test("keeps both rules in the active pair synchronized", () => {
    const elapsedMs = 100;
    const inputTop = workingRuleFrameState("coordinated", "inputTop", 10, elapsedMs);
    const inputBottom = workingRuleFrameState("coordinated", "inputBottom", 10, elapsedMs);

    expect(inputTop).toEqual({ head: 4, direction: 1, pair: "input" });
    expect(inputBottom).toEqual(inputTop);
    expect(workingRuleFrameState("coordinated", "headerTop", 10, elapsedMs)).toBeNull();
    expect(workingRuleFrameState("coordinated", "headerBottom", 10, elapsedMs)).toBeNull();
  });

  test("starts at the input left edge and moves the input pair left-to-right", () => {
    expect(coordinatedRuleState(10, 0)).toEqual({ head: 0, direction: 1, pair: "input" });
    expect(coordinatedRuleState(10, 100)).toEqual({ head: 4, direction: 1, pair: "input" });
    expect(coordinatedRuleState(10, 200)).toEqual({ head: 8, direction: 1, pair: "input" });
  });

  test("jumps from the input right edge to the header right edge", () => {
    const headerStartMs = 225;

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
    const elapsedMs = 325;

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
    expect(coordinatedRuleState(10, 450)).toEqual({ head: 0, direction: 1, pair: "input" });
    expect(workingRuleFrameState("coordinated", "inputTop", 1, 50)).toEqual({
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
    expect(workingRuleFrameState("input-only", "headerTop", 10, 100)).toBeNull();
    expect(workingRuleFrameState("input-only", "headerBottom", 10, 100)).toBeNull();
    expect(workingRuleFrameState("input-only", "inputTop", 10, 100)).toEqual({
      head: 4,
      direction: 1,
      pair: "input",
    });
    expect(workingRuleFrameState("input-only", "inputBottom", 10, 100)).toEqual({
      head: 4,
      direction: 1,
      pair: "input",
    });
    for (const role of ["headerTop", "headerBottom", "inputTop", "inputBottom"] as const) {
      expect(workingRuleFrameState("off", role, 10, 100)).toBeNull();
    }
  });
});

describe("additional working-rule animations", () => {
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

  test("constellation moves its stars instead of holding a fixed grid", () => {
    const width = 120;
    const stars = (elapsedMs: number) => Array.from({ length: width }, (_, column) =>
      workingRuleCell("constellation", "inputBottom", width, elapsedMs, column))
      .map((cell, column) => cell.glyph === "─" ? -1 : column)
      .filter((column) => column >= 0);

    const frames = Array.from({ length: 24 }, (_, step) => stars(step * 400));
    const shapes = new Set(frames.map((frame) => frame.join(",")));
    expect(shapes.size).toBeGreaterThan(20);

    // No frame repeats the old thirteen-column grid: the gaps stay uneven.
    const gaps = frames.flatMap((frame) => frame
      .slice(1)
      .map((column, index) => column - frame[index]!)
      .filter((gap) => gap > 2));
    expect(new Set(gaps).size).toBeGreaterThan(3);
  });

  test("constellation fades one star up, down, and out on its own beat", () => {
    const slot = 4;
    const life = Array.from({ length: 200 }, (_, step) =>
      constellationStar(slot, step * 40, "inputTop"));
    const lit = life.filter((star) => star !== null);
    const dark = life.filter((star) => star === null);

    expect(lit.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);
    expect(Math.max(...lit.map((star) => star.strength))).toBeGreaterThan(0.45);
    expect(Math.min(...lit.map((star) => star.strength))).toBeLessThan(0.2);
    // The star is dark while it moves, so it never jumps in view.
    expect(new Set(lit.map((star) => star.column)).size).toBeGreaterThan(1);

    // Neighbouring slots keep their own beat rather than blinking together.
    const together = Array.from({ length: 200 }, (_, step) =>
      [slot, slot + 1, slot + 2].map((index) => constellationStar(index, step * 40, "inputTop")));
    expect(together.some((row) => row.some((star) => star && star.strength > 0.5) &&
      row.some((star) => star === null))).toBe(true);
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

  test("random constellation fades each sparkle up and down within one cycle", () => {
    const width = 80;
    const centers = randomConstellationCenters(width, 0, "inputTop");
    expect(centers).toEqual(randomConstellationCenters(width, 0, "inputTop"));
    expect(centers).not.toEqual(randomConstellationCenters(width, 1, "inputTop"));

    const center = centers[0]!;
    const peakMs = (randomConstellationStart(center, 0, "inputTop") + 0.25) * 2000;
    const at = (elapsedMs: number, column: number) =>
      workingRuleCell("random-constellation", "inputTop", width, elapsedMs, column);

    expect(at(peakMs, center).strength).toBeCloseTo(1, 10);
    expect(at(peakMs, center).glyph).toBe("✦");
    expect(at(peakMs, center - 1).strength).toBeCloseTo(0.62, 10);
    expect(at(peakMs, center + 1).glyph).toBe("✧");
    // Every sparkle is born and dies inside its own cycle, so both edges are dark.
    expect(at(0, center)).toEqual({ strength: 0, glyph: "─" });
    expect(at(1999, center)).toEqual({ strength: 0, glyph: "─" });
  });

  test("random constellation staggers its sparkles instead of flashing them together", () => {
    const width = 120;
    const centers = randomConstellationCenters(width, 3, "inputBottom");
    expect(centers.length).toBeGreaterThan(2);

    const starts = centers.map((center) => randomConstellationStart(center, 3, "inputBottom"));
    expect(new Set(starts).size).toBe(starts.length);
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan(0.1);
    for (const start of starts) {
      expect(start).toBeGreaterThanOrEqual(0);
      // A sparkle that started later than this would be cut off by the cycle.
      expect(start).toBeLessThanOrEqual(0.5);
    }

    // Somewhere in the cycle the constellation is part lit and part dark, which
    // is the whole point: they no longer share a beat.
    const strengths = (elapsedMs: number) => centers.map((center) =>
      workingRuleCell("random-constellation", "inputBottom", width, elapsedMs, center).strength);
    const mixed = Array.from({ length: 40 }, (_, step) => strengths(6000 + step * 50))
      .some((lit) => lit.some((one) => one > 0.5) && lit.some((one) => one === 0));
    expect(mixed).toBe(true);
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

/** Runs of plain rule, light or heavy, are coalesced into one chunk each. */
const isRuleRun = (text: string | undefined) => /^[─━]+$/.test(text ?? "");

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
    const labelChunks = painted.chunks.filter((chunk) => !isRuleRun(chunk.text));
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
    const labelChunks = row.chunks.filter((chunk) => !isRuleRun(chunk.text));
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

describe("glow rendering", () => {
  test("raised-cosine falloff peaks flat, reaches the edge flat, and never leaves the unit range", () => {
    expect(glowFalloff(0, 10)).toBe(1);
    expect(glowFalloff(10, 10)).toBe(0);
    expect(glowFalloff(11, 10)).toBe(0);
    expect(glowFalloff(-4, 10)).toBeCloseTo(glowFalloff(4, 10), 12);
    expect(glowFalloff(3, 0)).toBe(0);

    // A linear ramp has a constant slope; this one flattens at both ends,
    // which is what removes the visible kink at the head and the tail.
    const slope = (a: number, b: number) => Math.abs(glowFalloff(b, 10) - glowFalloff(a, 10));
    expect(slope(0, 1)).toBeLessThan(slope(4, 5));
    expect(slope(9, 10)).toBeLessThan(slope(4, 5));
    for (let distance = 0; distance <= 12; distance += 0.25) {
      const value = glowFalloff(distance, 10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("the glow ramp holds the base, passes through the highlight, and blooms above the knee", () => {
    const base = rgba("#292e42");
    const highlight = rgba("#7aa2f7");
    const bloom = bloomColor(highlight);
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) =>
      0.2126 * r + 0.7152 * g + 0.0722 * b;

    expect(glowColor(base, highlight, bloom, 0)).toEqual(base);
    expect(glowColor(base, highlight, bloom, -1)).toEqual(base);
    expect(glowColor(base, highlight, bloom, GLOW_KNEE)).toEqual(highlight);
    expect(glowColor(base, highlight, bloom, 1)).toEqual(bloom);
    expect(luminance(bloom)).toBeGreaterThan(luminance(highlight));

    let previous = -1;
    for (let step = 0; step <= 40; step++) {
      const value = luminance(glowColor(base, highlight, bloom, step / 40));
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  test("the motion trail halves every half-life and never dims a live cell", () => {
    expect(decayTrail(1, 0, 0)).toBe(1);
    expect(decayTrail(1, 0, TRAIL_HALF_LIFE_MS)).toBeCloseTo(0.5, 6);
    expect(decayTrail(1, 0, TRAIL_HALF_LIFE_MS * 2)).toBeCloseTo(0.25, 6);
    expect(decayTrail(0.2, 0.9, TRAIL_HALF_LIFE_MS)).toBe(0.9);
    // A negative step means the working clock restarted; keep the live value.
    expect(decayTrail(1, 0.1, -50)).toBe(0.1);
    // The tail is cut once it can no longer tint a cell, so no cell stays warm.
    expect(decayTrail(1, 0, TRAIL_HALF_LIFE_MS * 12)).toBe(0);
  });

  test("the hot core of a sweep renders a heavier rule glyph and leaves sparkles alone", () => {
    expect(weightedGlyph("─", 0)).toBe("─");
    expect(weightedGlyph("─", 1)).toBe("━");
    expect(weightedGlyph("✦", 1)).toBe("✦");
    expect(Bun.stringWidth(weightedGlyph("─", 1))).toBe(1);
  });

  test("the rule paints runs of one colour as single chunks", () => {
    const width = 120;
    const base = rgba("#292e42");
    const highlight = rgba("#7aa2f7");
    const painted = ruleText(width, base, highlight, (column) =>
      glowFalloff(column - 60, 10));

    expect(painted.chunks.length).toBeLessThan(40);
    expect(painted.chunks.reduce((total, chunk) => total + Bun.stringWidth(chunk.text ?? ""), 0))
      .toBe(width);
    // The quiet columns on both sides are one chunk each, not one per column.
    expect(Bun.stringWidth(painted.chunks[0]!.text ?? "")).toBe(51);
    expect(Bun.stringWidth(painted.chunks.at(-1)!.text ?? "")).toBe(50);
  });

  test("a rule with no highlight anywhere is a single chunk", () => {
    const painted = ruleText(200, rgba("#292e42"), rgba("#7aa2f7"), () => 0);

    expect(painted.chunks).toHaveLength(1);
    expect(painted.chunks[0]!.text).toBe("─".repeat(200));
  });

  test("labels keep their own colours and are never folded into the rule run", () => {
    const painted = ruleText(
      40,
      rgba("#292e42"),
      rgba("#7aa2f7"),
      () => 0,
      [{ text: "ab", width: 2, color: "#ff0000" }, { text: "cd", width: 2, color: "#00ff00" }],
      3,
    );

    expect(painted.chunks.map((chunk) => chunk.text).join("")).toBe(
      `${"─".repeat(33)}abcd${"─".repeat(3)}`,
    );
    expect(painted.chunks.reduce((total, chunk) => total + Bun.stringWidth(chunk.text ?? ""), 0))
      .toBe(40);
  });

  test("the caret ramps in and out instead of snapping", () => {
    expect(caretAlpha(0)).toBe(0);
    expect(caretAlpha(CARET_PERIOD_MS * 0.35)).toBe(1);
    expect(caretAlpha(CARET_PERIOD_MS * 0.95)).toBe(0);

    const rise = [0.02, 0.06, 0.1, 0.14].map((fraction) => caretAlpha(CARET_PERIOD_MS * fraction));
    for (let i = 1; i < rise.length; i++) expect(rise[i]!).toBeGreaterThan(rise[i - 1]!);
    const fall = [0.62, 0.66, 0.7, 0.74].map((fraction) => caretAlpha(CARET_PERIOD_MS * fraction));
    for (let i = 1; i < fall.length; i++) expect(fall[i]!).toBeLessThan(fall[i - 1]!);

    for (let elapsed = 0; elapsed < CARET_PERIOD_MS * 3; elapsed += 7) {
      expect(caretAlpha(elapsed)).toBeGreaterThanOrEqual(0);
      expect(caretAlpha(elapsed)).toBeLessThanOrEqual(1);
    }
  });

  test("the spinner eases at both extremes rather than stepping linearly", () => {
    expect(pulseGlyph(0)).toBe("▁");
    expect(pulseGlyph(PULSE_PERIOD_MS / 2)).toBe("█");
    expect(pulseGlyph(PULSE_PERIOD_MS)).toBe(pulseGlyph(0));
    expect(Bun.stringWidth(pulseGlyph(123))).toBe(1);

    // Near the extremes the level holds for longer than it does mid-swing.
    const glyphs = Array.from({ length: 120 }, (_, i) => pulseGlyph((i * PULSE_PERIOD_MS) / 120));
    const changes = glyphs.filter((glyph, i) => i > 0 && glyph !== glyphs[i - 1]).length;
    expect(changes).toBeLessThan(20);
    const runLength = (index: number) => glyphs.filter((glyph) => glyph === glyphs[index]).length;
    expect(runLength(0)).toBeGreaterThan(runLength(30));
  });
});

describe("smoother working-rule modes", () => {
  test("energy transfer crosses between its phases without a step", () => {
    const width = 61;
    const brightest = (elapsedMs: number) => Math.max(
      ...["inputTop", "headerTop"].flatMap((role) =>
        Array.from({ length: width }, (_, column) =>
          workingRuleCell("energy-transfer", role as WorkingRuleRole, width, elapsedMs, column)
            .strength)),
    );

    // Sample straight through the charge/flash and flash/discharge handovers.
    let previous = brightest(0);
    for (let elapsedMs = 20; elapsedMs <= 3600; elapsedMs += 20) {
      const next = brightest(elapsedMs);
      expect(Math.abs(next - previous)).toBeLessThan(0.34);
      previous = next;
    }
  });

  test("constellation stars carry a halo instead of ending at one cell", () => {
    const width = 60;
    const cells = Array.from({ length: width }, (_, column) =>
      workingRuleCell("constellation", "inputTop", width, 300, column));
    const star = cells.findIndex((cell) => cell.glyph === "✦" || cell.glyph === "✧");

    expect(star).toBeGreaterThan(0);
    expect(cells[star - 1]!.strength).toBeGreaterThan(0);
    expect(cells[star - 1]!.strength).toBeLessThan(cells[star]!.strength);
    expect(cells[star + 1]!.strength).toBeCloseTo(cells[star - 1]!.strength, 10);
  });

  test("random constellation keeps its centres bright and adds a faint outer ring", () => {
    const width = 80;
    const center = randomConstellationCenters(width, 0, "inputTop")[0]!;
    const peakMs = (randomConstellationStart(center, 0, "inputTop") + 0.25) * 2000;
    const at = (column: number) =>
      workingRuleCell("random-constellation", "inputTop", width, peakMs, column);

    expect(at(center).strength).toBeCloseTo(1, 10);
    expect(at(center).glyph).toBe("✦");
    expect(at(center - 1).strength).toBeCloseTo(0.62, 10);
    expect(at(center + 2).strength).toBeGreaterThan(0);
    expect(at(center + 2).strength).toBeLessThan(at(center + 1).strength);
    expect(at(center + 3)).toEqual({ strength: 0, glyph: "─" });
  });
});

describe("thinking-text shimmer", () => {
  const base = rgba("#565f89");
  const highlight = rgba("#ffffff");
  const text = "weighing two ways to slice the parser, neither of them cheap, both of them fine";

  test("paints every character exactly once, whatever the head is over", () => {
    for (let elapsedMs = 0; elapsedMs < 4000; elapsedMs += 37) {
      const painted = shimmer(text, base, highlight, elapsedMs);
      expect(painted.chunks.map((chunk) => chunk.text ?? "").join("")).toBe(text);
    }
  });

  test("merges the quiet text into runs instead of one chunk a character", () => {
    const painted = shimmer(text, base, highlight, 900);

    expect(painted.chunks.length).toBeLessThan(text.length / 3);
    expect(painted.chunks.length).toBeGreaterThan(1);
  });

  test("the head is the brightest point and the ends stay at the base colour", () => {
    const painted = shimmer(text, base, highlight, 900);
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) =>
      0.2126 * r + 0.7152 * g + 0.0722 * b;
    const brightest = painted.chunks.reduce((best, chunk) =>
      luminance(chunk.fg ?? base) > luminance(best.fg ?? base) ? chunk : best);

    expect(luminance(brightest.fg ?? base)).toBeGreaterThan(luminance(base));
    expect(painted.chunks.at(0)!.fg).toEqual(base);
    expect(painted.chunks.at(-1)!.fg).toEqual(base);
  });
});

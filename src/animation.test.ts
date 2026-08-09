import { describe, expect, test } from "bun:test";
import {
  CARET_PLACEHOLDER,
  coordinatedRuleState,
  markdownCaretContent,
  workingRuleFrameState,
} from "./animation";

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
  test("keeps both blink frames non-whitespace after a partial heading marker", () => {
    const visible = markdownCaretContent("#", true);
    const hidden = markdownCaretContent("#", false);

    expect(visible).toBe("#▊");
    expect(hidden).toBe(`#${CARET_PLACEHOLDER}`);
    expect(/\s/u.test(visible.at(-1)!)).toBe(false);
    expect(/\s/u.test(hidden.at(-1)!)).toBe(false);
    expect([...visible]).toHaveLength([...hidden].length);
  });
});

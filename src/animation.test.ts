import { describe, expect, test } from "bun:test";
import {
  CARET_PLACEHOLDER,
  coordinatedRuleState,
  markdownCaretContent,
  workingRuleFrameState,
} from "./animation";

describe("coordinated working rules", () => {
  test("gives every visible rule the same right-moving frame", () => {
    expect(coordinatedRuleState(10, 0)).toEqual({ head: 0, direction: 1 });

    const elapsedMs = 87.5;
    const header = workingRuleFrameState("coordinated", "header", 10, elapsedMs);
    const inputTop = workingRuleFrameState("coordinated", "inputTop", 10, elapsedMs);
    const inputBottom = workingRuleFrameState("coordinated", "inputBottom", 10, elapsedMs);

    expect(header).toEqual({ head: 7, direction: 1 });
    expect(inputTop).toEqual(header);
    expect(inputBottom).toEqual(header);
  });

  test("keeps input-only and off compatibility", () => {
    expect(workingRuleFrameState("input-only", "header", 10, 50)).toBeNull();
    expect(workingRuleFrameState("input-only", "inputTop", 10, 50)).toEqual({ head: 4, direction: 1 });
    expect(workingRuleFrameState("input-only", "inputBottom", 10, 50)).toEqual({ head: 4, direction: 1 });
    expect(workingRuleFrameState("off", "inputBottom", 10, 50)).toBeNull();
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

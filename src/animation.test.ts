import { describe, expect, test } from "bun:test";
import { CARET_PLACEHOLDER, coordinatedRuleState, markdownCaretContent } from "./animation";

describe("coordinated working rules", () => {
  test("moves right on the bottom rule, then left on the header rule", () => {
    expect(coordinatedRuleState(10, 0)).toEqual({
      activeRole: "inputBottom",
      head: 0,
      direction: 1,
    });
    expect(coordinatedRuleState(10, 100).activeRole).toBe("inputBottom");

    const headerStart = coordinatedRuleState(10, 125);
    expect(headerStart.activeRole).toBe("header");
    expect(headerStart.head).toBe(9);
    expect(headerStart.direction).toBe(-1);

    const nearHeaderEnd = coordinatedRuleState(10, 237.5);
    expect(nearHeaderEnd.activeRole).toBe("header");
    expect(nearHeaderEnd.head).toBeCloseTo(0);
    expect(coordinatedRuleState(10, 250).activeRole).toBe("inputBottom");
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

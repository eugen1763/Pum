import { describe, expect, test } from "bun:test";
import { CARET_PLACEHOLDER, markdownCaretContent } from "./animation";

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

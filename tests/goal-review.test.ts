import { describe, expect, test } from "bun:test";
import {
  goalReviewColor,
  goalReviewGlyph,
  goalReviewHeadline,
  retryDetail,
  type GoalReviewStatus,
} from "../src/goal-review";
import { loadTheme } from "../src/theme";

const theme = loadTheme("tokyonight");

const EVERY_STATUS: GoalReviewStatus[] = [
  "reviewing",
  "completed",
  "continuing",
  "blocked",
  "failed",
  "discarded",
  "cancelled",
  "error",
];

describe("goal review rows", () => {
  test("every status has a two-column glyph and a colour", () => {
    for (const status of EVERY_STATUS) {
      expect(goalReviewGlyph(status)).toHaveLength(2);
      expect(goalReviewColor(theme, status)).toMatch(/^#/);
    }
  });

  test("an outcome is coloured by what it means", () => {
    expect(goalReviewColor(theme, "completed")).toBe(theme.success);
    expect(goalReviewColor(theme, "blocked")).toBe(theme.warn);
    expect(goalReviewColor(theme, "failed")).toBe(theme.error);
    expect(goalReviewColor(theme, "error")).toBe(theme.error);
    // A review nobody acted on is not a result. It recedes.
    expect(goalReviewColor(theme, "discarded")).toBe(theme.dim);
    expect(goalReviewColor(theme, "cancelled")).toBe(theme.dim);
  });

  test("the headline names the status and carries an optional detail", () => {
    expect(goalReviewHeadline("reviewing")).toBe("Goal review · reviewing");
    expect(goalReviewHeadline("continuing", "(3/10)")).toBe("Goal review · continuing (3/10)");
    expect(goalReviewHeadline("failed", "after 10 incomplete reviews"))
      .toBe("Goal review · failed after 10 incomplete reviews");
  });

  test("a blank detail leaves the headline alone", () => {
    expect(goalReviewHeadline("completed", "   ")).toBe("Goal review · completed");
    expect(goalReviewHeadline("completed", "")).toBe("Goal review · completed");
  });

  test("the retry detail counts against the limit, or just counts", () => {
    expect(retryDetail(3, 10)).toBe("(3/10)");
    expect(retryDetail(1, 1)).toBe("(1/1)");
    expect(retryDetail(4, 0)).toBe("(attempt 4)");
  });
});

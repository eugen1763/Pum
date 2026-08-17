import { describe, expect, test } from "bun:test";
import { CANCEL_WINDOW_MS, confirmsCancellation } from "../src/cancel-confirmation";

describe("confirmsCancellation", () => {
  test("confirms a second press within the interval for the same agent", () => {
    expect(confirmsCancellation(1_000, "agent-a", "agent-a", 1_000 + CANCEL_WINDOW_MS - 1)).toBe(true);
  });

  test("rejects an expired press", () => {
    expect(confirmsCancellation(1_000, "agent-a", "agent-a", 1_000 + CANCEL_WINDOW_MS)).toBe(false);
  });

  test("rejects a press armed for another selected agent", () => {
    expect(confirmsCancellation(1_000, "agent-a", "agent-b", 1_001)).toBe(false);
  });

  test("rejects an unarmed press", () => {
    expect(confirmsCancellation(null, null, "main", 1_000)).toBe(false);
  });
});

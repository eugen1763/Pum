import { describe, expect, test } from "bun:test";
import { toolStateGlyph } from "./transcript";

describe("tool line state", () => {
  test("uses a warning marker for a rejected call", () => {
    expect(toolStateGlyph("rejected")).toBe("!");
    expect(toolStateGlyph("error")).toBe("✗");
    expect(toolStateGlyph("ok")).toBe("✓");
  });
});

import { describe, expect, test } from "bun:test";
import { matchingCommands, moveCommandSelection } from "./commands";

describe("command suggestions", () => {
  test("shows all five matching commands and wraps selection", () => {
    const matches = matchingCommands("/").slice(0, 5);
    expect(matches).toHaveLength(5);
    expect(moveCommandSelection(0, matches.length, 1)).toBe(1);
    expect(moveCommandSelection(0, matches.length, -1)).toBe(4);
    expect(moveCommandSelection(4, matches.length, 1)).toBe(0);
  });

  test("does not replace multiline input with command navigation", () => {
    expect(matchingCommands("/clear\nkeep this text")).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { matchingCommands, moveCommandSelection } from "./commands";

describe("command suggestions", () => {
  test("includes Check mode path management and wraps selection", () => {
    const matches = matchingCommands("/");
    expect(matches.some((command) => command.name === "/check-path")).toBe(true);
    expect(moveCommandSelection(0, matches.length, 1)).toBe(1);
    expect(moveCommandSelection(0, matches.length, -1)).toBe(matches.length - 1);
    expect(moveCommandSelection(matches.length - 1, matches.length, 1)).toBe(0);
  });

  test("does not replace multiline input with command navigation", () => {
    expect(matchingCommands("/clear\nkeep this text")).toEqual([]);
  });
});

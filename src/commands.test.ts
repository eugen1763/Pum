import { describe, expect, test } from "bun:test";
import { COMMANDS, matchingCommands, moveCommandSelection } from "./commands";

describe("command suggestions", () => {
  test("includes Check mode path management and wraps selection", () => {
    const matches = matchingCommands("/");
    expect(matches.some((command) => command.name === "/check-path")).toBe(true);
    expect(moveCommandSelection(0, matches.length, 1)).toBe(1);
    expect(moveCommandSelection(0, matches.length, -1)).toBe(matches.length - 1);
    expect(moveCommandSelection(matches.length - 1, matches.length, 1)).toBe(0);
  });

  test("includes /news and matches it for a prefix", () => {
    expect(COMMANDS.some((command) => command.name === "/news")).toBe(true);
    expect(COMMANDS.find((command) => command.name === "/news")?.description).toBe("Open recent answers (News)");
    expect(matchingCommands("/news").some((command) => command.name === "/news")).toBe(true);
  });

  test("includes /stats and matches it for a prefix", () => {
    expect(COMMANDS.find((command) => command.name === "/stats")?.description)
      .toBe("Show session statistics");
    expect(matchingCommands("/sta").map((command) => command.name)).toContain("/stats");
  });

  test("does not replace multiline input with command navigation", () => {
    expect(matchingCommands("/clear\nkeep this text")).toEqual([]);
  });
});

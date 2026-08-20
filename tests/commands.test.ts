import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  isCommandInput,
  matchingCommands,
  matchingCommandsForTarget,
  moveCommandSelection,
  SUGGESTION_ROWS,
  suggestionWindowStart,
} from "../src/commands";

describe("command suggestions", () => {
  test("only treats a slash in the first input column as a command trigger", () => {
    expect(isCommandInput("/goal")).toBe(true);
    expect(isCommandInput("open /goal")).toBe(false);
    expect(isCommandInput(" /goal")).toBe(false);
  });

  test("includes Check mode path management and wraps selection", () => {
    const matches = matchingCommands("/");
    expect(matches.some((command) => command.name === "/check-path")).toBe(true);
    expect(moveCommandSelection(0, matches.length, 1)).toBe(1);
    expect(moveCommandSelection(0, matches.length, -1)).toBe(matches.length - 1);
    expect(moveCommandSelection(matches.length - 1, matches.length, 1)).toBe(0);
  });

  test("keeps every match available and scrolls the visible window", () => {
    const matches = matchingCommands("/");
    expect(matches.length).toBeGreaterThan(SUGGESTION_ROWS);
    // A short list never scrolls.
    expect(suggestionWindowStart(0, 3)).toBe(0);
    expect(suggestionWindowStart(2, 3)).toBe(0);
    expect(suggestionWindowStart(4, SUGGESTION_ROWS)).toBe(0);
    // The window holds the selection near the middle.
    expect(suggestionWindowStart(0, 20)).toBe(0);
    expect(suggestionWindowStart(2, 20)).toBe(0);
    expect(suggestionWindowStart(3, 20)).toBe(1);
    expect(suggestionWindowStart(10, 20)).toBe(8);
    // The window stops at the end of the list.
    expect(suggestionWindowStart(19, 20)).toBe(15);
    expect(suggestionWindowStart(99, 20)).toBe(15);
    expect(suggestionWindowStart(-4, 20)).toBe(0);
  });

  test("shows the last rows when the selection wraps to the end", () => {
    const matches = matchingCommands("/");
    const last = moveCommandSelection(0, matches.length, -1);
    expect(suggestionWindowStart(last, matches.length))
      .toBe(matches.length - SUGGESTION_ROWS);
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

  test("keeps both Processes commands discoverable and explains the alias", () => {
    expect(COMMANDS.find((command) => command.name === "/processes")?.description)
      .toContain("triggers and shells");
    expect(COMMANDS.find((command) => command.name === "/triggers")?.description)
      .toBe("Open Processes on the Triggers tab");
  });

  test("includes /afk, which App routes before the model sees it", () => {
    expect(COMMANDS.find((command) => command.name === "/afk")?.description)
      .toBe("Toggle away mode, or start it with instructions");
    expect(matchingCommands("/af").map((command) => command.name)).toContain("/afk");
    expect(matchingCommands("/afk stop asking about tests"))
      .toEqual([]);
  });

  test("offers /background to main and selected subagents without exposing main-only commands", () => {
    expect(COMMANDS.find((command) => command.name === "/background")?.description)
      .toBe("Start a managed worktree agent for the selected transcript");
    expect(matchingCommandsForTarget("/back", "main").map((command) => command.name))
      .toEqual(["/background"]);
    expect(matchingCommandsForTarget("/back", "subagent").map((command) => command.name))
      .toEqual(["/background"]);
    expect(matchingCommandsForTarget("/", "subagent").map((command) => command.name))
      .toEqual(["/background"]);
    expect(matchingCommandsForTarget("/clear", "subagent")).toEqual([]);
  });

  test("does not replace multiline input with command navigation", () => {
    expect(matchingCommands("/clear\nkeep this text")).toEqual([]);
  });
});

describe("absolute paths are not commands", () => {
  test("a second separator ends command matching, so paths complete instead", () => {
    // /c still reaches /clear and /compress; /c/ is a path the user is typing.
    expect(matchingCommands("/c").length).toBeGreaterThan(0);
    expect(matchingCommands("/c/")).toEqual([]);
    expect(matchingCommands("/usr/l")).toEqual([]);
    expect(matchingCommands("/n/ew")).toEqual([]);
    expect(matchingCommands("/etc/hosts")).toEqual([]);
  });

  test("an argument closes command suggestions", () => {
    expect(matchingCommands("/goal write a detailed goal")).toEqual([]);
    expect(matchingCommands("/check-path /usr/lib"))
      .toEqual([]);
  });
});

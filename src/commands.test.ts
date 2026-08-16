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
    expect(matchingCommands("/afk stop asking about tests").map((command) => command.name))
      .toEqual(["/afk"]);
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

  test("a separator after the command name still matches the command", () => {
    // The rule looks at the first token only, so an argument may hold a path.
    expect(matchingCommands("/check-path /usr/lib").map((command) => command.name))
      .toEqual(["/check-path"]);
  });
});

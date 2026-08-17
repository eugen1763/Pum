import { describe, expect, test } from "bun:test";
import { isWorktreeCommand, parseWorktreeCommand } from "../src/worktree-command";

describe("worktree command matching", () => {
  test("claims only its own command", () => {
    expect(isWorktreeCommand("/worktree")).toBe(true);
    expect(isWorktreeCommand("/worktree start")).toBe(true);
    expect(isWorktreeCommand("  /worktree return  ")).toBe(true);
    expect(isWorktreeCommand("/worktrees")).toBe(false);
    expect(isWorktreeCommand("/goal")).toBe(false);
    expect(parseWorktreeCommand("/goal stop")).toBeNull();
  });
});

describe("worktree command parsing", () => {
  test("a bare command still creates a worktree", () => {
    expect(parseWorktreeCommand("/worktree")).toEqual({ kind: "create" });
  });

  test("a lone word is still a name", () => {
    expect(parseWorktreeCommand("/worktree feature-one"))
      .toEqual({ kind: "create", name: "feature-one" });
  });

  test("start and return are reserved, never names", () => {
    // Reading /worktree start as "create one called start" would quietly do
    // something else entirely.
    expect(parseWorktreeCommand("/worktree start")).toEqual({ kind: "start" });
    expect(parseWorktreeCommand("/worktree return")).toEqual({ kind: "return" });
  });

  test("start takes an optional directory, spaces and all", () => {
    expect(parseWorktreeCommand("/worktree start /work/repo"))
      .toEqual({ kind: "start", directory: "/work/repo" });
    expect(parseWorktreeCommand("/worktree start /work/my repo"))
      .toEqual({ kind: "start", directory: "/work/my repo" });
  });

  test("return takes nothing", () => {
    const parsed = parseWorktreeCommand("/worktree return now");
    expect(parsed).toMatchObject({ kind: "error" });
    expect((parsed as { message: string }).message).toContain("takes no argument");
  });

  test("an unknown multi-word form is an error, not a silent create", () => {
    const parsed = parseWorktreeCommand("/worktree feature one");
    expect(parsed).toMatchObject({ kind: "error" });
    expect((parsed as { message: string }).message).toContain("Unknown worktree command");
  });

  test("a name PUM would not generate is refused", () => {
    const parsed = parseWorktreeCommand("/worktree ../escape");
    expect(parsed).toMatchObject({ kind: "error" });
    expect((parsed as { message: string }).message).toContain("letters, digits");
  });
});

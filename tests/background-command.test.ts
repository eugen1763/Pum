import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_USAGE,
  isBackgroundCommand,
  parseBackgroundCommand,
} from "../src/background-command";

describe("background command matching", () => {
  test("claims only /background", () => {
    expect(isBackgroundCommand("/background task")).toBe(true);
    expect(isBackgroundCommand("  /background task  ")).toBe(true);
    expect(isBackgroundCommand("/background")).toBe(true);
    expect(isBackgroundCommand("/backgrounds task")).toBe(false);
    expect(isBackgroundCommand("/background/path")).toBe(false);
    expect(isBackgroundCommand("/bg task")).toBe(false);
    expect(parseBackgroundCommand("ordinary prompt")).toBeNull();
  });
});

describe("background command parsing", () => {
  test("keeps all task text after the command", () => {
    expect(parseBackgroundCommand("/background inspect the retry path"))
      .toEqual({ kind: "spawn", prompt: "inspect the retry path" });
    expect(parseBackgroundCommand("  /background  first line\nsecond line  "))
      .toEqual({ kind: "spawn", prompt: "first line\nsecond line" });
  });

  test("requires a prompt and reports the exact syntax", () => {
    for (const input of ["/background", "/background   ", "/background\n\t"]) {
      const parsed = parseBackgroundCommand(input);
      expect(parsed).toEqual({
        kind: "error",
        message: `/background needs a prompt. ${BACKGROUND_USAGE}`,
      });
    }
  });
});

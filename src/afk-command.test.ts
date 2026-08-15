import { describe, expect, test } from "bun:test";
import { isAfkCommand, parseAfkCommand } from "./afk-command";
import { MAX_AFK_INSTRUCTIONS } from "./afk";

const NUL = "\u0000";

describe("afk command matching", () => {
  test("claims only /afk", () => {
    expect(isAfkCommand("/afk")).toBe(true);
    expect(isAfkCommand("  /afk  ")).toBe(true);
    expect(isAfkCommand("/afk answer conservatively")).toBe(true);
    expect(isAfkCommand("/afkk")).toBe(false);
    expect(isAfkCommand("/afk-mode")).toBe(false);
    expect(isAfkCommand("afk")).toBe(false);
    expect(isAfkCommand("/goal stop")).toBe(false);
  });

  test("returns null for anything else, so other commands still run", () => {
    expect(parseAfkCommand("/goal stop")).toBeNull();
    expect(parseAfkCommand("/afkk")).toBeNull();
    expect(parseAfkCommand("just a prompt")).toBeNull();
    expect(parseAfkCommand("")).toBeNull();
  });
});

describe("afk command parsing", () => {
  test("a bare command is a toggle", () => {
    expect(parseAfkCommand("/afk")).toEqual({ kind: "toggle" });
    expect(parseAfkCommand("   /afk   ")).toEqual({ kind: "toggle" });
    expect(parseAfkCommand("/afk\t")).toEqual({ kind: "toggle" });
  });

  test("any argument is guidance, including words that read like actions", () => {
    expect(parseAfkCommand("/afk stop")).toEqual({ kind: "instructions", text: "stop" });
    expect(parseAfkCommand("/afk off")).toEqual({ kind: "instructions", text: "off" });
    expect(parseAfkCommand("/afk prefer the smallest change"))
      .toEqual({ kind: "instructions", text: "prefer the smallest change" });
  });

  test("multiline guidance survives, inner whitespace intact", () => {
    expect(parseAfkCommand("/afk  first line\nsecond line  "))
      .toEqual({ kind: "instructions", text: "first line\nsecond line" });
  });

  test("guidance at the limit passes and one character more is an error", () => {
    const limit = "a".repeat(MAX_AFK_INSTRUCTIONS);
    expect(parseAfkCommand(`/afk ${limit}`)).toEqual({ kind: "instructions", text: limit });

    const over = parseAfkCommand(`/afk ${"a".repeat(MAX_AFK_INSTRUCTIONS + 1)}`);
    expect(over?.kind).toBe("error");
    expect(over && "message" in over && over.message).toContain(String(MAX_AFK_INSTRUCTIONS));
  });

  test("a NUL byte in the guidance is an error, not instructions", () => {
    const command = parseAfkCommand(`/afk answer${NUL}now`);
    expect(command?.kind).toBe("error");
    expect(command && "message" in command && command.message).toContain("NUL");
  });

  test("a NUL right after the command is not an afk command at all", () => {
    expect(isAfkCommand(`/afk${NUL}x`)).toBe(false);
    expect(parseAfkCommand(`/afk${NUL}x`)).toBeNull();
  });

  test("never throws, whatever the input", () => {
    const inputs = ["/afk", "/afk ", `/afk ${NUL}`, "/afk\n\n", "/", "\\afk", "/afk ".repeat(5_000)];
    for (const input of inputs) expect(() => parseAfkCommand(input)).not.toThrow();
  });
});

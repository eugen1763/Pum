import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companionExists,
  companionFileFor,
  readCompanion,
  writeCompanion,
  writeCompanionOrThrow,
} from "./session-companion";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-companion-"));
  directories.push(directory);
  return join(directory, "session-1.jsonl");
}

const isRecord = (value: unknown): value is { a: number } =>
  Boolean(value) && typeof value === "object" && typeof (value as { a?: unknown }).a === "number";

describe("companion paths", () => {
  test("sit beside the session under its own name", () => {
    expect(companionFileFor(join("sessions", "abc.jsonl"), "goal.json"))
      .toBe(join("sessions", "abc.goal.json"));
    // Both spellings of the session suffix, and none at all.
    expect(companionFileFor(join("s", "abc.json"), "todo.json")).toBe(join("s", "abc.todo.json"));
    expect(companionFileFor(join("s", "abc"), "news.json")).toBe(join("s", "abc.news.json"));
  });
});

describe("reading", () => {
  test("a missing, unreadable, or rejected file is the fallback", () => {
    const file = sessionFile();
    expect(readCompanion(file, "goal.json", isRecord, null)).toBeNull();
    writeFileSync(companionFileFor(file, "goal.json"), "{ not json");
    expect(readCompanion(file, "goal.json", isRecord, null)).toBeNull();
    writeFileSync(companionFileFor(file, "goal.json"), JSON.stringify({ a: "no" }));
    expect(readCompanion(file, "goal.json", isRecord, null)).toBeNull();
    expect(readCompanion(undefined, "goal.json", isRecord, null)).toBeNull();
  });

  test("an accepted value comes back as it was written", () => {
    const file = sessionFile();
    writeCompanion(file, "goal.json", { a: 1 });
    expect(readCompanion(file, "goal.json", isRecord, null)).toEqual({ a: 1 });
  });
});

describe("writing", () => {
  test("null removes the file, and a session without a path writes nothing", () => {
    const file = sessionFile();
    writeCompanion(file, "goal.json", { a: 1 });
    expect(companionExists(file, "goal.json")).toBe(true);
    writeCompanion(file, "goal.json", null);
    expect(companionExists(file, "goal.json")).toBe(false);
    expect(() => writeCompanion(undefined, "goal.json", { a: 1 })).not.toThrow();
  });

  test("the temp name is unique per process and never left behind", () => {
    const file = sessionFile();
    writeCompanion(file, "goal.json", { a: 1 });
    const directory = join(companionFileFor(file, "goal.json"), "..");
    // Two processes on one session must not share a temp name, and a completed
    // write leaves only the real file.
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(companionFileFor(file, "goal.json"), "utf8"))).toEqual({ a: 1 });
  });

  test("the throwing variant reports a failure the best-effort one swallows", () => {
    // A directory where the file should be: the rename cannot succeed.
    const file = sessionFile();
    const target = companionFileFor(file, "goal.json");
    rmSync(target, { force: true });
    require("node:fs").mkdirSync(target, { recursive: true });
    expect(() => writeCompanionOrThrow(file, "goal.json", { a: 1 })).toThrow();
    expect(() => writeCompanion(file, "goal.json", { a: 1 })).not.toThrow();
    // And neither leaves litter behind.
    const directory = join(target, "..");
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });
});

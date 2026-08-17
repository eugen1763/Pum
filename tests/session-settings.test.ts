import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeSettings } from "../src/settings";
import {
  loadSessionSettings,
  mergeSessionSettings,
  pickSessionSettings,
  saveSessionSettings,
  sessionSettingsDiff,
  sessionSettingsFileFor,
} from "../src/session-settings";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-session-settings-"));
  directories.push(directory);
  return join(directory, "session.jsonl");
}

const GLOBAL = normalizeSettings({});

describe("the session settings companion file", () => {
  test("sits beside the session JSONL", () => {
    const file = join("sessions", "abc.jsonl");
    expect(sessionSettingsFileFor(file)).toBe(join("sessions", "abc.settings.json"));
  });

  test("round-trips overrides", () => {
    const file = sessionFile();
    saveSessionSettings(file, { theme: "gruvbox", animations: false });
    expect(loadSessionSettings(file)).toEqual({ theme: "gruvbox", animations: false });
  });

  test("writes nothing when a session owns no overrides", () => {
    const file = sessionFile();
    saveSessionSettings(file, {});
    expect(existsSync(sessionSettingsFileFor(file))).toBe(false);
  });

  test("removes the file once the last override goes", () => {
    const file = sessionFile();
    saveSessionSettings(file, { theme: "nord" });
    expect(existsSync(sessionSettingsFileFor(file))).toBe(true);
    saveSessionSettings(file, {});
    expect(existsSync(sessionSettingsFileFor(file))).toBe(false);
  });

  test("a corrupt or missing file reads as no overrides", () => {
    const file = sessionFile();
    expect(loadSessionSettings(file)).toEqual({});
    writeFileSync(sessionSettingsFileFor(file), "{ not json");
    expect(loadSessionSettings(file)).toEqual({});
    writeFileSync(sessionSettingsFileFor(file), "[1,2,3]");
    expect(loadSessionSettings(file)).toEqual({});
  });

  test("no session file means no overrides and no write", () => {
    expect(loadSessionSettings(undefined)).toEqual({});
    expect(() => saveSessionSettings(undefined, { theme: "nord" })).not.toThrow();
  });

  test("drops fields a session does not own", () => {
    // A hand-edited file must not become a back door into the app.
    const picked = pickSessionSettings({ theme: "nord", model: "evil", __proto__: "x" } as any);
    expect(picked).toEqual({ theme: "nord" });
  });

  test("the write leaves no temp file behind", () => {
    const file = sessionFile();
    saveSessionSettings(file, { theme: "dracula" });
    const target = sessionSettingsFileFor(file);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ theme: "dracula" });
    expect(readdirSync(dirname(target))).toEqual(["session.settings.json"]);
  });
});

describe("merging a session over the global settings", () => {
  test("overrides win, everything else falls through", () => {
    const merged = mergeSessionSettings(GLOBAL, { theme: "kanagawa" });
    expect(merged.theme).toBe("kanagawa");
    expect(merged.checkMode).toBe(GLOBAL.checkMode);
  });

  test("a hand-edited override is normalized, not trusted", () => {
    const merged = mergeSessionSettings(GLOBAL, { maxActiveSubagents: 9999 } as any);
    expect(merged.maxActiveSubagents).toBeLessThanOrEqual(GLOBAL.maxActiveSubagents * 100);
    expect(Number.isFinite(merged.maxActiveSubagents)).toBe(true);
  });

  test("no overrides is the global settings", () => {
    expect(mergeSessionSettings(GLOBAL, {})).toEqual(GLOBAL);
  });
});

describe("what `s` would promote", () => {
  test("reports only what differs from global", () => {
    const effective = { ...GLOBAL, theme: "nord", animations: !GLOBAL.animations };
    expect(sessionSettingsDiff(GLOBAL, effective)).toEqual({
      theme: "nord",
      animations: !GLOBAL.animations,
    });
  });

  test("an untouched session promotes nothing", () => {
    expect(sessionSettingsDiff(GLOBAL, { ...GLOBAL })).toEqual({});
  });

  test("compares nested values structurally, not by identity", () => {
    const withPaths = { ...GLOBAL, checkPaths: { "/a": ["/b"] } };
    expect(sessionSettingsDiff(withPaths, { ...GLOBAL, checkPaths: { "/a": ["/b"] } })).toEqual({});
    expect(sessionSettingsDiff(withPaths, { ...GLOBAL, checkPaths: { "/a": ["/c"] } }))
      .toEqual({ checkPaths: { "/a": ["/c"] } });
  });
});

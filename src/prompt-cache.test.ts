import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptCacheStore } from "./prompt-cache";

const directories: string[] = [];

function fixture(platform: NodeJS.Platform = "linux") {
  const directory = mkdtempSync(join(tmpdir(), "pum-prompt-cache-"));
  directories.push(directory);
  const historyPath = join(directory, "history.json");
  const stashPath = join(directory, "prompt-stash.json");
  return {
    historyPath,
    stashPath,
    store: new PromptCacheStore(historyPath, stashPath, platform),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("prompt history and cache cleanup", () => {
  test("retains 100 recent sent entries plus every cached occurrence", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/one";
    const sent = Array.from({ length: 130 }, (_, index) => `sent ${index}`);
    writeJson(historyPath, { [cwd]: ["cached one", "cached two", ...sent] });
    writeJson(stashPath, {
      [cwd]: [
        { text: "cached one", executed: false },
        { text: "cached two", executed: false },
      ],
    });

    const history = store.loadHistory(cwd);

    expect(history).toEqual(["cached one", "cached two", ...sent.slice(-100)]);
    expect((readJson(historyPath)[cwd] as string[]).length).toBe(102);
    expect(store.loadStash(cwd)).toHaveLength(2);
  });

  test("protects cached duplicate occurrences without protecting all sent duplicates", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/duplicates";
    writeJson(historyPath, { [cwd]: Array.from({ length: 140 }, () => "same prompt") });
    writeJson(stashPath, {
      [cwd]: [
        { text: "same prompt", executed: false },
        { text: "same prompt", executed: false },
      ],
    });

    expect(store.loadHistory(cwd)).toEqual(Array.from({ length: 102 }, () => "same prompt"));

    store.removeStash(cwd, 1);
    expect(store.loadHistory(cwd)).toEqual(Array.from({ length: 101 }, () => "same prompt"));
  });

  test("migrates legacy string stash rows with occurrence-aware executed state", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/legacy";
    writeJson(historyPath, { [cwd]: ["sent once"] });
    writeJson(stashPath, { [cwd]: ["sent once", "cached", "sent once"] });

    expect(store.loadStash(cwd)).toEqual([
      { text: "sent once", executed: true },
      { text: "cached", executed: false },
      { text: "sent once", executed: false },
    ]);
    expect(readJson(stashPath)[cwd]).toEqual([
      { text: "sent once", executed: true },
      { text: "cached", executed: false },
      { text: "sent once", executed: false },
    ]);
  });

  test("isolates cleanup by working directory", () => {
    const { historyPath, stashPath, store } = fixture();
    const first = "/work/first";
    const second = "/work/second";
    const firstHistory = Array.from({ length: 110 }, (_, index) => `first ${index}`);
    const secondHistory = Array.from({ length: 110 }, (_, index) => `second ${index}`);
    writeJson(historyPath, { [first]: firstHistory, [second]: secondHistory });
    writeJson(stashPath, { [first]: [], [second]: [] });

    expect(store.loadHistory(first)).toEqual(firstHistory.slice(-100));
    expect(readJson(historyPath)[second]).toEqual(secondHistory);
    expect(store.loadHistory(second)).toEqual(secondHistory.slice(-100));
  });

  test("reconciles legacy Windows key spelling into one normalized identity", () => {
    const { historyPath, stashPath, store } = fixture("win32");
    const legacyCwd = "C:\\Users\\Ada\\Project";
    const normalizedCwd = "c:\\users\\ada\\project";
    writeJson(historyPath, {
      [legacyCwd]: ["old prompt"],
      [normalizedCwd]: ["new prompt"],
    });
    writeJson(stashPath, {
      [legacyCwd]: [{ text: "legacy cached", executed: false }],
      [normalizedCwd]: [{ text: "normalized cached", executed: false }],
    });

    expect(store.loadHistory(normalizedCwd)).toEqual(["old prompt", "new prompt"]);
    expect(store.loadStash(normalizedCwd)).toEqual([
      { text: "legacy cached", executed: false },
      { text: "normalized cached", executed: false },
    ]);
    expect(Object.keys(readJson(historyPath))).toEqual([normalizedCwd]);
    expect(Object.keys(readJson(stashPath))).toEqual([normalizedCwd]);
  });

  test("cleans after history and stash mutations without deleting cached rows", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/mutations";
    const cached = Array.from({ length: 205 }, (_, index) => `cached ${index}`);
    const sent = Array.from({ length: 105 }, (_, index) => `sent ${index}`);
    writeJson(historyPath, { [cwd]: [...cached, ...sent] });
    writeJson(stashPath, {
      [cwd]: cached.map((text, index) => ({ text, executed: index % 2 === 0 })),
    });

    const stash = store.loadStash(cwd);
    expect(stash).toHaveLength(205);
    expect(store.loadHistory(cwd)).toEqual([...cached, ...sent.slice(-100)]);

    store.appendHistory(cwd, "new sent");
    expect(store.loadHistory(cwd)).toEqual([...cached, ...sent.slice(-99), "new sent"]);

    const removed = stash.findIndex((prompt) => prompt.text === "cached 0");
    store.removeStash(cwd, removed);
    expect(store.loadHistory(cwd)).toEqual([...cached.slice(1), ...sent.slice(-99), "new sent"]);
  });
});

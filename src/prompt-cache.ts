import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectStorageKey, type RuntimePlatform } from "./platform";

export type StashedPrompt = {
  text: string;
  executed: boolean;
};

type JsonFile = Record<string, unknown>;
type PromptCacheState = {
  history: string[];
  stash: StashedPrompt[];
};

const MAX_SENT_ENTRIES = 100;

function readJson(path: string): JsonFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonFile
      : {};
  } catch {
    return {};
  }
}

function validHistory(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function matchingValues(
  file: JsonFile,
  cwd: string,
  platform: RuntimePlatform,
): unknown[] {
  const canonical = projectStorageKey(cwd, platform);
  return Object.entries(file).flatMap(([candidate, value]) =>
    projectStorageKey(candidate, platform) === canonical ? [value] : []
  );
}

function migrateStash(value: unknown, history: readonly string[]): StashedPrompt[] {
  if (!Array.isArray(value)) return [];
  const remainingHistory = new Map<string, number>();
  for (const prompt of history) {
    remainingHistory.set(prompt, (remainingHistory.get(prompt) ?? 0) + 1);
  }

  return value.flatMap((entry): StashedPrompt[] => {
    if (typeof entry === "string") {
      const remaining = remainingHistory.get(entry) ?? 0;
      if (remaining > 0) remainingHistory.set(entry, remaining - 1);
      return [{ text: entry, executed: remaining > 0 }];
    }
    if (!entry || typeof entry !== "object") return [];
    const prompt = entry as { text?: unknown; executed?: unknown };
    return typeof prompt.text === "string"
      ? [{ text: prompt.text, executed: prompt.executed === true }]
      : [];
  });
}

function sortStash(stash: readonly StashedPrompt[]): StashedPrompt[] {
  return [...stash].sort((first, second) => Number(second.executed) - Number(first.executed));
}

function trimHistory(history: readonly string[], stash: readonly StashedPrompt[]): string[] {
  const cachedCounts = new Map<string, number>();
  for (const prompt of stash) {
    cachedCounts.set(prompt.text, (cachedCounts.get(prompt.text) ?? 0) + 1);
  }

  const cachedOccurrences = new Array<boolean>(history.length).fill(false);
  for (let index = history.length - 1; index >= 0; index--) {
    const prompt = history[index]!;
    const remaining = cachedCounts.get(prompt) ?? 0;
    if (remaining > 0) {
      cachedOccurrences[index] = true;
      cachedCounts.set(prompt, remaining - 1);
    }
  }

  let sentToKeep = MAX_SENT_ENTRIES;
  const kept = new Array<boolean>(history.length).fill(false);
  for (let index = history.length - 1; index >= 0; index--) {
    if (cachedOccurrences[index]) {
      kept[index] = true;
    } else if (sentToKeep > 0) {
      kept[index] = true;
      sentToKeep--;
    }
  }
  return history.filter((_, index) => kept[index]);
}

function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function atomicWrite(path: string, value: JsonFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class PromptCacheStore {
  constructor(
    private readonly historyPath: string,
    private readonly stashPath: string,
    private readonly platform: RuntimePlatform = process.platform,
  ) {}

  private update(
    cwd: string,
    mutate?: (state: PromptCacheState) => void,
  ): PromptCacheState {
    const historyFile = readJson(this.historyPath);
    const stashFile = readJson(this.stashPath);
    const key = projectStorageKey(cwd, this.platform);
    const history = matchingValues(historyFile, cwd, this.platform).flatMap(validHistory);
    const stashEntries = matchingValues(stashFile, cwd, this.platform).flatMap((value) =>
      Array.isArray(value) ? value : []
    );
    const migratedStash = migrateStash(stashEntries, history);
    const state: PromptCacheState = { history: [...history], stash: [...migratedStash] };
    mutate?.(state);
    state.stash = sortStash(state.stash);
    state.history = trimHistory(state.history, state.stash);

    const nextHistoryFile = { ...historyFile, [key]: state.history };
    const nextStashFile = { ...stashFile, [key]: state.stash };
    for (const candidate of Object.keys(nextHistoryFile)) {
      if (candidate !== key && projectStorageKey(candidate, this.platform) === key) {
        delete nextHistoryFile[candidate];
      }
    }
    for (const candidate of Object.keys(nextStashFile)) {
      if (candidate !== key && projectStorageKey(candidate, this.platform) === key) {
        delete nextStashFile[candidate];
      }
    }

    try {
      if (!sameJson(historyFile, nextHistoryFile)) atomicWrite(this.historyPath, nextHistoryFile);
      if (!sameJson(stashFile, nextStashFile)) atomicWrite(this.stashPath, nextStashFile);
    } catch {
      // Prompt persistence is a convenience. Never break input handling.
    }
    return state;
  }

  loadHistory(cwd: string): string[] {
    return this.update(cwd).history;
  }

  appendHistory(cwd: string, prompt: string): string[] {
    return this.update(cwd, ({ history }) => {
      if (history[history.length - 1] !== prompt) history.push(prompt);
    }).history;
  }

  removeHistory(cwd: string, prompt: string): string[] {
    return this.update(cwd, ({ history }) => {
      const index = history.lastIndexOf(prompt);
      if (index >= 0) history.splice(index, 1);
    }).history;
  }

  loadStash(cwd: string): StashedPrompt[] {
    return this.update(cwd).stash;
  }

  appendStash(cwd: string, prompt: string, executed = false): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      stash.push({ text: prompt, executed });
    }).stash;
  }

  replaceStash(cwd: string, index: number, prompt: string, executed: boolean): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      if (stash[index]) stash[index] = { text: prompt, executed };
    }).stash;
  }

  removeStash(cwd: string, index: number): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      if (index >= 0 && index < stash.length) stash.splice(index, 1);
    }).stash;
  }

  markStashExecutedMany(cwd: string, indices: Iterable<number>): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      const selected = new Set(indices);
      for (const [index, prompt] of stash.entries()) {
        if (selected.has(index)) stash[index] = { ...prompt, executed: true };
      }
    }).stash;
  }
}

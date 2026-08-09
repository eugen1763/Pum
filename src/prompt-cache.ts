import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { projectStorageKey, type RuntimePlatform } from "./platform";

export type PromptCacheOwner =
  | { type: "user" }
  | { type: "agent"; id: string; name: string };

export type StashedPrompt = {
  id: string;
  text: string;
  executed: boolean;
  owner: PromptCacheOwner;
};

export type PromptCacheState = {
  history: string[];
  stash: StashedPrompt[];
};

type JsonFile = Record<string, unknown>;

export type PromptCacheFileOps = {
  exists: typeof existsSync;
  mkdir: typeof mkdirSync;
  read: typeof readFileSync;
  write: typeof writeFileSync;
  rename: typeof renameSync;
  copy: typeof copyFileSync;
  remove: typeof rmSync;
};

const DEFAULT_FILE_OPS: PromptCacheFileOps = {
  exists: existsSync,
  mkdir: mkdirSync,
  read: readFileSync,
  write: writeFileSync,
  rename: renameSync,
  copy: copyFileSync,
  remove: rmSync,
};

const MAX_SENT_ENTRIES = 100;

function readJson(path: string, ops: PromptCacheFileOps): JsonFile {
  try {
    const parsed = JSON.parse(ops.read(path, "utf8") as string);
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

function matchingValues(file: JsonFile, cwd: string, platform: RuntimePlatform): unknown[] {
  const canonical = projectStorageKey(cwd, platform);
  return Object.entries(file).flatMap(([candidate, value]) =>
    projectStorageKey(candidate, platform) === canonical ? [value] : []
  );
}

function safeOwner(value: unknown): PromptCacheOwner {
  if (!value || typeof value !== "object") return { type: "user" };
  const owner = value as { type?: unknown; id?: unknown; name?: unknown };
  if (owner.type !== "agent" || typeof owner.id !== "string" || !owner.id || typeof owner.name !== "string") {
    return { type: "user" };
  }
  const name = owner.name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "agent";
  return { type: "agent", id: owner.id, name };
}

function legacyId(cwd: string, index: number, text: string): string {
  const digest = createHash("sha256").update(`${cwd}\0${index}\0${text}`).digest("hex").slice(0, 20);
  return `cache-${digest}`;
}

function migrateStash(value: unknown, history: readonly string[], cwd: string): StashedPrompt[] {
  if (!Array.isArray(value)) return [];
  const remainingHistory = new Map<string, number>();
  for (const prompt of history) remainingHistory.set(prompt, (remainingHistory.get(prompt) ?? 0) + 1);

  const migrated = value.flatMap((entry, index): StashedPrompt[] => {
    if (typeof entry === "string") {
      const remaining = remainingHistory.get(entry) ?? 0;
      if (remaining > 0) remainingHistory.set(entry, remaining - 1);
      return [{
        id: legacyId(cwd, index, entry),
        text: entry,
        executed: remaining > 0,
        owner: { type: "user" },
      }];
    }
    if (!entry || typeof entry !== "object") return [];
    const prompt = entry as { id?: unknown; text?: unknown; executed?: unknown; owner?: unknown };
    if (typeof prompt.text !== "string") return [];
    return [{
      id: typeof prompt.id === "string" && prompt.id ? prompt.id : legacyId(cwd, index, prompt.text),
      text: prompt.text,
      executed: prompt.executed === true,
      owner: safeOwner(prompt.owner),
    }];
  });
  const seen = new Set<string>();
  return migrated.map((entry, index) => {
    let id = entry.id;
    if (seen.has(id)) id = `${legacyId(cwd, index, entry.text)}-${index}`;
    seen.add(id);
    return id === entry.id ? entry : { ...entry, id };
  });
}

function sortStash(stash: readonly StashedPrompt[]): StashedPrompt[] {
  return [...stash].sort((first, second) => Number(second.executed) - Number(first.executed));
}

function trimHistory(history: readonly string[], stash: readonly StashedPrompt[]): string[] {
  const cachedCounts = new Map<string, number>();
  for (const prompt of stash) cachedCounts.set(prompt.text, (cachedCounts.get(prompt.text) ?? 0) + 1);

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
    if (cachedOccurrences[index]) kept[index] = true;
    else if (sentToKeep > 0) {
      kept[index] = true;
      sentToKeep--;
    }
  }
  return history.filter((_, index) => kept[index]);
}

function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function serialized(value: JsonFile): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Commit both cache files as one rollback-capable transaction. */
function atomicWriteMany(changes: Array<{ path: string; value: JsonFile }>, ops: PromptCacheFileOps): void {
  if (changes.length === 0) return;
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const staged = changes.map(({ path, value }) => ({
    path,
    temporary: `${path}.${token}.tmp`,
    backup: `${path}.${token}.bak`,
    existed: ops.exists(path),
    value,
  }));
  const committed: typeof staged = [];
  try {
    for (const item of staged) {
      ops.mkdir(dirname(item.path), { recursive: true });
      ops.write(item.temporary, serialized(item.value), { encoding: "utf8", mode: 0o600 });
      if (item.existed) ops.copy(item.path, item.backup);
    }
    for (const item of staged) {
      ops.rename(item.temporary, item.path);
      committed.push(item);
    }
  } catch (error) {
    for (const item of [...committed].reverse()) {
      ops.remove(item.path, { force: true });
      if (item.existed && ops.exists(item.backup)) ops.rename(item.backup, item.path);
    }
    throw error;
  } finally {
    for (const item of staged) {
      ops.remove(item.temporary, { force: true });
      ops.remove(item.backup, { force: true });
    }
  }
}

export class PromptCacheStore {
  constructor(
    private readonly historyPath: string,
    private readonly stashPath: string,
    private readonly platform: RuntimePlatform = process.platform,
    private readonly ops: PromptCacheFileOps = DEFAULT_FILE_OPS,
  ) {}

  private update(cwd: string, mutate?: (state: PromptCacheState) => void, strict = false): PromptCacheState {
    const historyFile = readJson(this.historyPath, this.ops);
    const stashFile = readJson(this.stashPath, this.ops);
    const key = projectStorageKey(cwd, this.platform);
    const history = matchingValues(historyFile, cwd, this.platform).flatMap(validHistory);
    const stashEntries = matchingValues(stashFile, cwd, this.platform).flatMap((value) =>
      Array.isArray(value) ? value : []
    );
    const state: PromptCacheState = {
      history: [...history],
      stash: migrateStash(stashEntries, history, key),
    };
    mutate?.(state);
    state.stash = sortStash(state.stash);
    state.history = trimHistory(state.history, state.stash);

    const nextHistoryFile = { ...historyFile, [key]: state.history };
    const nextStashFile = { ...stashFile, [key]: state.stash };
    for (const candidate of Object.keys(nextHistoryFile)) {
      if (candidate !== key && projectStorageKey(candidate, this.platform) === key) delete nextHistoryFile[candidate];
    }
    for (const candidate of Object.keys(nextStashFile)) {
      if (candidate !== key && projectStorageKey(candidate, this.platform) === key) delete nextStashFile[candidate];
    }

    const changes = [
      ...(!sameJson(historyFile, nextHistoryFile) ? [{ path: this.historyPath, value: nextHistoryFile }] : []),
      ...(!sameJson(stashFile, nextStashFile) ? [{ path: this.stashPath, value: nextStashFile }] : []),
    ];
    try {
      atomicWriteMany(changes, this.ops);
    } catch (error) {
      if (strict) throw new Error(`Prompt cache persistence failed: ${String(error)}`);
    }
    return state;
  }

  loadHistory(cwd: string): string[] { return this.update(cwd).history; }

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

  loadStash(cwd: string): StashedPrompt[] { return this.update(cwd).stash; }

  appendStash(
    cwd: string,
    prompt: string,
    executed = false,
    owner: PromptCacheOwner = { type: "user" },
    strict = false,
  ): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      stash.push({ id: `cache-${randomUUID()}`, text: prompt, executed, owner });
    }, strict).stash;
  }

  replaceStash(cwd: string, index: number, prompt: string, executed: boolean): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      if (stash[index]) stash[index] = { ...stash[index], text: prompt, executed };
    }).stash;
  }

  removeStash(cwd: string, index: number): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      if (index >= 0 && index < stash.length) stash.splice(index, 1);
    }).stash;
  }

  removeStashById(cwd: string, id: string, ownerId: string): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      const index = stash.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`Unknown cache entry: ${id}`);
      const owner = stash[index]!.owner;
      if (owner.type !== "agent" || owner.id !== ownerId) {
        throw new Error("An agent can delete only cache entries created by that exact agent");
      }
      stash.splice(index, 1);
    }, true).stash;
  }

  markStashExecutedMany(cwd: string, indices: Iterable<number>): StashedPrompt[] {
    return this.update(cwd, ({ stash }) => {
      const selected = new Set(indices);
      for (const [index, prompt] of stash.entries()) {
        if (selected.has(index)) stash[index] = { ...prompt, executed: true };
      }
    }).stash;
  }

  addAgentStash(cwd: string, text: string, owner: Extract<PromptCacheOwner, { type: "agent" }>): StashedPrompt {
    let createdId = "";
    const state = this.update(cwd, ({ stash }) => {
      createdId = `cache-${randomUUID()}`;
      stash.push({ id: createdId, text, executed: false, owner });
    }, true);
    return state.stash.find((entry) => entry.id === createdId)!;
  }

  executeStashByIds(cwd: string, ids: readonly string[]): { entries: StashedPrompt[]; state: PromptCacheState } {
    let selected: StashedPrompt[] = [];
    const state = this.update(cwd, ({ history, stash }) => {
      const byId = new Map(stash.map((entry) => [entry.id, entry]));
      selected = ids.map((id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error(`Unknown or stale cache entry: ${id}`);
        return entry;
      });
      for (const entry of selected) {
        if (history[history.length - 1] !== entry.text) history.push(entry.text);
      }
      const selectedIds = new Set(ids);
      for (const [index, entry] of stash.entries()) {
        if (selectedIds.has(entry.id)) stash[index] = { ...entry, executed: true };
      }
    }, true);
    return { entries: selected, state };
  }
}

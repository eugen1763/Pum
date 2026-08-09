import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { loadHistory } from "./history";
import { projectStorageKey } from "./platform";

export type StashedPrompt = {
  text: string;
  executed: boolean;
};

type StashFile = Record<string, (StashedPrompt | string)[]>;
const STASH_PATH = join(AGENT_DIR, "prompt-stash.json");
const MAX_ENTRIES = 200;

function sortStash(list: StashedPrompt[]): StashedPrompt[] {
  return list.sort((a, b) => Number(b.executed) - Number(a.executed));
}

function readFile(): StashFile {
  try {
    const parsed = JSON.parse(readFileSync(STASH_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPromptStash(cwd: string): StashedPrompt[] {
  const file = readFile();
  const entries = file[projectStorageKey(cwd)] ?? file[cwd];
  if (!Array.isArray(entries)) return [];
  const executedPrompts = new Set(loadHistory(cwd));
  return sortStash(
    entries.flatMap((entry) => {
      if (typeof entry === "string") {
        return [{ text: entry, executed: executedPrompts.has(entry) }];
      }
      return entry && typeof entry.text === "string"
        ? [{ text: entry.text, executed: entry.executed === true || executedPrompts.has(entry.text) }]
        : [];
    }),
  );
}

/** Add a prompt to the stash and return the bounded list. */
export function appendPromptStash(
  cwd: string,
  prompt: string,
  executed = false,
): StashedPrompt[] {
  const file = readFile();
  const key = projectStorageKey(cwd);
  const list = loadPromptStash(cwd);
  list.push({ text: prompt, executed });
  const trimmed = sortStash(list).slice(-MAX_ENTRIES);
  file[key] = trimmed;
  if (key !== cwd) delete file[cwd];
  try {
    writeFileSync(STASH_PATH, JSON.stringify(file, null, 2));
  } catch {
    // The stash is a convenience; never break a prompt over persistence.
  }
  return trimmed;
}

/** Replace one stashed prompt and return the newly sorted list. */
export function replacePromptStash(
  cwd: string,
  index: number,
  prompt: string,
  executed: boolean,
): StashedPrompt[] {
  const file = readFile();
  const key = projectStorageKey(cwd);
  const list = loadPromptStash(cwd);
  if (list[index]) list[index] = { text: prompt, executed };
  const sorted = sortStash(list);
  file[key] = sorted;
  if (key !== cwd) delete file[cwd];
  try {
    writeFileSync(STASH_PATH, JSON.stringify(file, null, 2));
  } catch {
    // The stash is a convenience; never break a turn over it.
  }
  return sorted;
}

/** Remove one prompt from the stash. */
export function removePromptStash(cwd: string, index: number): StashedPrompt[] {
  const file = readFile();
  const key = projectStorageKey(cwd);
  const list = loadPromptStash(cwd);
  if (index >= 0 && index < list.length) list.splice(index, 1);
  file[key] = list;
  if (key !== cwd) delete file[cwd];
  try {
    writeFileSync(STASH_PATH, JSON.stringify(file, null, 2));
  } catch {
    // The stash is a convenience; never break input handling over it.
  }
  return list;
}

/** Mark selected stashed prompts as executed with one persistence update. */
export function markPromptStashExecutedMany(
  cwd: string,
  indices: Iterable<number>,
): StashedPrompt[] {
  const file = readFile();
  const key = projectStorageKey(cwd);
  const selected = new Set(indices);
  const list = loadPromptStash(cwd).map((prompt, index) =>
    selected.has(index) ? { ...prompt, executed: true } : prompt,
  );
  const sorted = sortStash(list);
  file[key] = sorted;
  if (key !== cwd) delete file[cwd];
  try {
    writeFileSync(STASH_PATH, JSON.stringify(file, null, 2));
  } catch {
    // The stash is a convenience; never break a turn over persistence.
  }
  return sorted;
}

/** Mark a stashed prompt as executed without adding a duplicate row. */
export function markPromptStashExecuted(cwd: string, index: number): StashedPrompt[] {
  return markPromptStashExecutedMany(cwd, [index]);
}

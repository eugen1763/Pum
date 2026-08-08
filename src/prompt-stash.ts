import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";

type StashFile = Record<string, string[]>;
const STASH_PATH = join(AGENT_DIR, "prompt-stash.json");
const MAX_ENTRIES = 200;

function readFile(): StashFile {
  try {
    const parsed = JSON.parse(readFileSync(STASH_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPromptStash(cwd: string): string[] {
  const entries = readFile()[cwd];
  return Array.isArray(entries) ? entries.filter((entry) => typeof entry === "string") : [];
}

/** Add a prompt to the stash and return the bounded list. */
export function appendPromptStash(cwd: string, prompt: string): string[] {
  const file = readFile();
  const list = Array.isArray(file[cwd]) ? file[cwd]! : [];
  list.push(prompt);
  const trimmed = list.slice(-MAX_ENTRIES);
  file[cwd] = trimmed;
  try {
    writeFileSync(STASH_PATH, JSON.stringify(file, null, 2));
  } catch {
    // The stash is a convenience; never break a prompt over persistence.
  }
  return trimmed;
}

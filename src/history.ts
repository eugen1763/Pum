import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { projectStorageKey } from "./platform";

/** One history list per working directory, so projects do not bleed together. */
type HistoryFile = Record<string, string[]>;

const HISTORY_PATH = join(AGENT_DIR, "history.json");
const MAX_ENTRIES = 500;

function readFile(): HistoryFile {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadHistory(cwd: string): string[] {
  const file = readFile();
  const entries = file[projectStorageKey(cwd)] ?? file[cwd];
  return Array.isArray(entries) ? entries.filter((e) => typeof e === "string") : [];
}

/** Appends unless it repeats the previous entry, and returns the new list. */
export function appendHistory(cwd: string, prompt: string): string[] {
  const file = readFile();
  const key = projectStorageKey(cwd);
  const list = Array.isArray(file[key]) ? file[key]! : loadHistory(cwd);
  if (list[list.length - 1] !== prompt) list.push(prompt);
  const trimmed = list.slice(-MAX_ENTRIES);
  file[key] = trimmed;
  if (key !== cwd) delete file[cwd];
  try {
    writeFileSync(HISTORY_PATH, JSON.stringify(file, null, 2));
  } catch {
    // history is a convenience; never break a turn over it
  }
  return trimmed;
}

/** Remove every exact occurrence of a prompt from this directory's history. */
export function removeHistory(cwd: string, prompt: string): string[] {
  const file = readFile();
  const key = projectStorageKey(cwd);
  const next = loadHistory(cwd).filter((entry) => entry !== prompt);
  file[key] = next;
  if (key !== cwd) delete file[cwd];
  try {
    writeFileSync(HISTORY_PATH, JSON.stringify(file, null, 2));
  } catch {
    // history is a convenience; never break input handling over it
  }
  return next;
}

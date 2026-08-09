import { promptCacheStore } from "./prompt-stash";

export function loadHistory(cwd: string): string[] {
  return promptCacheStore.loadHistory(cwd);
}

/** Append a sent prompt unless it repeats the previous entry. */
export function appendHistory(cwd: string, prompt: string): string[] {
  return promptCacheStore.appendHistory(cwd, prompt);
}

/** Remove the most recent exact occurrence of a prompt. */
export function removeHistory(cwd: string, prompt: string): string[] {
  return promptCacheStore.removeHistory(cwd, prompt);
}

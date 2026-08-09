import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { PromptCacheStore } from "./prompt-cache";

const store = new PromptCacheStore(
  join(AGENT_DIR, "history.json"),
  join(AGENT_DIR, "prompt-stash.json"),
);

export function loadHistory(cwd: string): string[] {
  return store.loadHistory(cwd);
}

/** Append a sent prompt unless it repeats the previous entry. */
export function appendHistory(cwd: string, prompt: string): string[] {
  return store.appendHistory(cwd, prompt);
}

/** Remove the most recent exact occurrence of a prompt. */
export function removeHistory(cwd: string, prompt: string): string[] {
  return store.removeHistory(cwd, prompt);
}

import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { PromptCacheStore, type StashedPrompt } from "./prompt-cache";

export type { StashedPrompt } from "./prompt-cache";

export const promptCacheStore = new PromptCacheStore(
  join(AGENT_DIR, "history.json"),
  join(AGENT_DIR, "prompt-stash.json"),
);

export function loadPromptStash(cwd: string): StashedPrompt[] {
  return promptCacheStore.loadStash(cwd);
}

export function appendPromptStash(
  cwd: string,
  prompt: string,
  executed = false,
): StashedPrompt[] {
  return promptCacheStore.appendStash(cwd, prompt, executed);
}

export function replacePromptStash(
  cwd: string,
  index: number,
  prompt: string,
  executed: boolean,
): StashedPrompt[] {
  return promptCacheStore.replaceStash(cwd, index, prompt, executed);
}

export function removePromptStash(cwd: string, index: number): StashedPrompt[] {
  return promptCacheStore.removeStash(cwd, index);
}

export function markPromptStashExecutedMany(
  cwd: string,
  indices: Iterable<number>,
): StashedPrompt[] {
  return promptCacheStore.markStashExecutedMany(cwd, indices);
}

export function markPromptStashExecuted(cwd: string, index: number): StashedPrompt[] {
  return markPromptStashExecutedMany(cwd, [index]);
}

export type BackgroundCommand =
  | { kind: "spawn"; prompt: string }
  | { kind: "error"; message: string };

export const BACKGROUND_USAGE = "Usage: /background <prompt>";

/** True for any input `/background` owns, so App can route it before child prompts. */
export function isBackgroundCommand(text: string): boolean {
  return /^\/background(?:\s|$)/.test(text.trim());
}

/** Parse one fresh managed-agent task without interpreting aliases or control words. */
export function parseBackgroundCommand(text: string): BackgroundCommand | null {
  const trimmed = text.trim();
  if (!isBackgroundCommand(trimmed)) return null;
  const prompt = trimmed.slice("/background".length).trim();
  if (!prompt) {
    return {
      kind: "error",
      message: `/background needs a prompt. ${BACKGROUND_USAGE}`,
    };
  }
  return { kind: "spawn", prompt };
}

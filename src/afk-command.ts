import { afkInstructionProblem } from "./afk";

/**
 * `/afk` parsing.
 *
 * Unlike `/goal` there are no control words: `/afk` alone toggles the mode and
 * anything after it is guidance. So "/afk stop asking about tests" sets
 * guidance rather than stopping AFK, and nothing the user types can be read as
 * a hidden action.
 */

export type AfkCommand =
  | { kind: "toggle" }
  | { kind: "instructions"; text: string }
  | { kind: "error"; message: string };

const AFK_USAGE = "/afk toggles away mode. /afk <instructions> starts it, or re-steers a running one.";

/** True for any input `/afk` owns, so App can route before the model sees it. */
export function isAfkCommand(text: string): boolean {
  return /^\/afk(?:\s|$)/.test(text.trim());
}

/** Pure and total: every input yields a command or null, and nothing throws. */
export function parseAfkCommand(input: string): AfkCommand | null {
  const trimmed = input.trim();
  const match = /^\/afk(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;

  const argument = (match[1] ?? "").trim();
  if (!argument) return { kind: "toggle" };

  const problem = afkInstructionProblem(argument);
  if (problem) return { kind: "error", message: `${problem}. ${AFK_USAGE}` };
  return { kind: "instructions", text: argument };
}

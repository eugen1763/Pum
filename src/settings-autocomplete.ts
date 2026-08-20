/**
 * Argument completion for `/settings`.
 *
 * Command completion stops at the command name, because every other command
 * takes free text. `/settings` does not: its two arguments come from closed
 * sets, and a setting nobody can spell is a setting nobody uses. Completions
 * carry the same {start, end, replacement} shape as path completions, so
 * applyPathCompletion() inserts them without a second code path.
 */

import type { PathCompletion } from "./path-autocomplete";
import { pathCompletions } from "./path-autocomplete";
import {
  GLOBAL_FLAG,
  SETTING_SPECS,
  findSettingSpec,
  tokenizeSettingsInput,
  type SettingSpec,
} from "./settings-command";

export type SettingsCompletion = PathCompletion & {
  /** Trailing hint shown after the value in the suggestion row. */
  description?: string;
};

const CHECK_PATH_ACTIONS = ["list", "add", "remove", "clear"];

function valueCandidates(spec: SettingSpec): { value: string; description?: string }[] {
  if (spec.kind === "boolean") return [{ value: "on" }, { value: "off" }];
  if (spec.kind === "paths") return CHECK_PATH_ACTIONS.map((value) => ({ value }));
  if (spec.kind === "int") return [];
  return (spec.values ?? []).map((value) => ({ value }));
}

function matches(candidate: string, fragment: string): boolean {
  return candidate.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase());
}

/**
 * Completions for the token under the cursor, or [] when the input is not a
 * `/settings` command or the cursor sits on the command name itself.
 */
export function settingsCompletions(
  input: string,
  cursorOffset: number,
  cwd: string,
): SettingsCompletion[] {
  if (!/^\s*\/settings(?:\s|$)/.test(input)) return [];
  const cursor = Math.max(0, Math.min(cursorOffset, input.length));
  // Completing behind a trailing argument would rewrite text the cursor has
  // already passed, so only the run up to the cursor decides the token.
  const head = input.slice(0, cursor);
  const tokens = tokenizeSettingsInput(head);
  const last = tokens.at(-1);
  const inToken = last !== undefined && last.end >= cursor && !/\s$/.test(head);
  const fragment = inToken ? last!.value : "";
  const start = inToken ? last!.start : cursor;
  const end = inToken ? last!.end : cursor;
  // Token 0 is "/settings" itself; the name is token 1 once it is complete.
  const position = inToken ? tokens.length - 1 : tokens.length;
  if (position < 1) return [];

  if (position === 1) {
    const named = SETTING_SPECS
      .filter((spec) => matches(spec.key, fragment)
        || (spec.label !== "" && matches(spec.label, fragment)))
      .map((spec) => ({
        start,
        end,
        replacement: spec.key,
        description: spec.label || "advanced",
      }));
    return named;
  }

  const spec = findSettingSpec(tokens[1]!.value);
  if (!spec) return [];

  // `/settings checkPaths add <dir>` completes a real directory, so the paths
  // front end is as usable from here as /check-path is.
  if (spec.kind === "paths" && position >= 3) {
    const action = tokens[2]!.value;
    if (action !== "add" && action !== "remove") return [];
    return pathCompletions(input, cursor, cwd);
  }

  const flag = GLOBAL_FLAG.startsWith(fragment) && fragment.startsWith("-")
    ? [{ start, end, replacement: GLOBAL_FLAG, description: "write pum.json" }]
    : [];
  if (position > 2 && spec.kind !== "paths") return flag;

  return [
    ...valueCandidates(spec)
      .filter((candidate) => matches(candidate.value, fragment))
      .map((candidate) => ({
        start,
        end,
        replacement: candidate.value,
        ...(candidate.description ? { description: candidate.description } : {}),
      })),
    ...flag,
  ];
}

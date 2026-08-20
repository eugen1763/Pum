/**
 * Argument completion for /providers. The results carry path-completion
 * offsets, so the prompt inserts them through the same path as file
 * completions.
 */
import type { PathCompletion } from "./path-autocomplete";
import { PROVIDER_ACTIONS, type ProviderEntry } from "./providers-command";

const COMMAND = "/providers";

function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

/**
 * Complete the subcommand, then the provider name. Returns nothing while the
 * command name itself is still incomplete, because the command list covers it.
 */
export function providersCompletions(
  input: string,
  cursorOffset: number,
  entries: readonly ProviderEntry[],
): PathCompletion[] {
  const before = input.slice(0, cursorOffset);
  if (!before.startsWith(COMMAND)) return [];
  const rest = before.slice(COMMAND.length);
  if (!/^\s/.test(rest)) return [];

  const verbStart = COMMAND.length + leadingSpaces(rest);
  const afterSpaces = rest.trimStart();
  const boundary = afterSpaces.search(/\s/);

  if (boundary === -1) {
    const typed = afterSpaces.toLowerCase();
    return PROVIDER_ACTIONS.filter((action) => action.startsWith(typed)).map((action) => ({
      start: verbStart,
      end: cursorOffset,
      replacement: action,
    }));
  }

  const verb = afterSpaces.slice(0, boundary).toLowerCase();
  if (!(PROVIDER_ACTIONS as readonly string[]).includes(verb)) return [];

  const tail = afterSpaces.slice(boundary);
  const nameStart = verbStart + boundary + leadingSpaces(tail);
  const typed = before.slice(nameStart).toLowerCase();
  // Adding works for any provider. Editing and deleting need something that is
  // already there: a stored credential, or a custom definition in models.json.
  const pool = verb === "add"
    ? entries
    : entries.filter((entry) => entry.configured || entry.kind === "custom");
  return pool
    .filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(typed) || entry.id.toLowerCase().startsWith(typed),
    )
    .map((entry) => ({ start: nameStart, end: cursorOffset, replacement: entry.name }));
}

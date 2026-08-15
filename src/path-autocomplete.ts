import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isCredentialSensitivePath } from "./credential-path";

export type PathCompletion = {
  /** Inclusive input offset replaced by this completion. */
  start: number;
  /** Exclusive input offset replaced by this completion. */
  end: number;
  /** Prompt text inserted between start and end. */
  replacement: string;
};

type PathToken = {
  start: number;
  end: number;
  fragment: string;
  prefix: string;
};

function quotedToken(input: string, cursorOffset: number): PathToken | null {
  let quote: "\"" | "'" | null = null;
  let quoteStart = -1;
  for (let index = 0; index < cursorOffset; index++) {
    const character = input[index];
    if (character !== "\"" && character !== "'") continue;
    if (index > 0 && input[index - 1] === "\\") continue;
    if (quote === character) {
      quote = null;
      quoteStart = -1;
    } else if (
      quote === null
      && (index === 0 || /\s/u.test(input[index - 1]!) || input[index - 1] === "@")
    ) {
      quote = character;
      quoteStart = index;
    }
  }
  if (quote === null || quoteStart < 0) return null;

  const closingQuote = input.indexOf(quote, cursorOffset);
  const end = closingQuote < 0 ? cursorOffset : closingQuote;
  const start = quoteStart + 1;
  return {
    start,
    end,
    fragment: input.slice(start, cursorOffset),
    prefix: "",
  };
}

function pathToken(input: string, cursorOffset: number): PathToken | null {
  const cursor = Math.max(0, Math.min(cursorOffset, input.length));
  const quoted = quotedToken(input, cursor);
  if (quoted) return quoted.fragment ? quoted : null;

  let start = cursor;
  while (start > 0 && !/\s/u.test(input[start - 1]!)) start--;
  let end = cursor;
  while (end < input.length && !/\s/u.test(input[end]!)) end++;

  const replacementStart = start;
  let prefix = "";
  if (input[start] === "@") {
    prefix = "@";
    start++;
  }
  const fragment = input.slice(start, cursor);
  if (!fragment || /^[a-z][a-z0-9+.-]*:\/\//iu.test(fragment)) return null;
  return { start: replacementStart, end, fragment, prefix };
}

function insideOrSame(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  if (!difference) return false;
  let current = root;
  for (const component of difference.split(sep)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function pathParts(fragment: string): { directory: string; basename: string; separator: string } {
  const slash = fragment.lastIndexOf("/");
  const backslash = process.platform === "win32" ? fragment.lastIndexOf("\\") : -1;
  const boundary = Math.max(slash, backslash);
  return {
    directory: boundary < 0 ? "" : fragment.slice(0, boundary + 1),
    basename: fragment.slice(boundary + 1),
    separator: backslash > slash ? "\\" : "/",
  };
}

/**
 * List safe project-local path completions for the token under the cursor.
 * The function excludes credential paths, special files, and symbolic links.
 */
export function pathCompletions(
  input: string,
  cursorOffset: number,
  cwd: string,
): PathCompletion[] {
  const token = pathToken(input, cursorOffset);
  if (!token) return [];
  const parts = pathParts(token.fragment);

  try {
    const root = realpathSync(cwd);
    const requestedDirectory = parts.directory || ".";
    const absoluteDirectory = resolve(root, requestedDirectory);
    if (!insideOrSame(root, absoluteDirectory) || isCredentialSensitivePath(absoluteDirectory)) return [];
    const directory = realpathSync(absoluteDirectory);
    if (
      !insideOrSame(root, directory)
      || isCredentialSensitivePath(directory)
      || hasSymlinkComponent(root, absoluteDirectory)
    ) return [];

    const caseSensitive = process.platform !== "win32";
    const expected = caseSensitive ? parts.basename : parts.basename.toLowerCase();
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => {
        const name = caseSensitive ? entry.name : entry.name.toLowerCase();
        return name.startsWith(expected);
      })
      .filter((entry) => !isCredentialSensitivePath(join(directory, entry.name)))
      .sort((first, second) => first.name.localeCompare(second.name))
      .map((entry) => ({
        start: token.start,
        end: token.end,
        replacement: token.prefix
          + parts.directory
          + entry.name
          + (entry.isDirectory() ? parts.separator : ""),
      }));
  } catch {
    return [];
  }
}

export function applyPathCompletion(
  input: string,
  completion: PathCompletion,
): { value: string; cursorOffset: number } {
  const value = input.slice(0, completion.start)
    + completion.replacement
    + input.slice(completion.end);
  return {
    value,
    cursorOffset: completion.start + completion.replacement.length,
  };
}

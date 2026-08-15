import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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

/** Leading `~` or `~/`, the only home forms we expand. A `~user` names somebody else. */
const HOME_PREFIX = /^~(?:[/\\]|$)/u;

function isHomeFragment(fragment: string): boolean {
  const next = fragment[1];
  return fragment[0] === "~"
    && (next === undefined || next === "/" || (process.platform === "win32" && next === "\\"));
}

/**
 * Locate the directory a fragment lists, plus the root it may not leave.
 * Absolute and home fragments name their own place, so they answer to no root.
 */
function resolveTarget(
  fragment: string,
  directory: string,
  cwd: string,
): { target: string; root: string | null } {
  if (isHomeFragment(fragment)) {
    return { target: resolve(homedir(), directory.replace(HOME_PREFIX, "")), root: null };
  }
  if (isAbsolute(fragment)) return { target: resolve(directory), root: null };
  const root = realpathSync(cwd);
  return { target: resolve(root, directory || "."), root };
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
 * List safe path completions for the token under the cursor. A relative token
 * stays inside the project and may not reach it through a symbolic link; an
 * absolute or `~` token names its own place, so a linked directory it spells
 * out is followed. Either way the function offers no credential path, no
 * special file, and no symbolic link.
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
    const { target, root } = resolveTarget(token.fragment, parts.directory, cwd);
    if (isCredentialSensitivePath(target)) return [];
    if (root && !insideOrSame(root, target)) return [];
    const directory = realpathSync(target);
    if (isCredentialSensitivePath(directory)) return [];
    // Outside the project there is nothing to escape from, so the symlink walk
    // only guards the relative case; the credential checks above cover the rest.
    if (root && (!insideOrSame(root, directory) || hasSymlinkComponent(root, target))) return [];

    // A bare `~` is the home directory itself, not a name to match inside it.
    const bareHome = !parts.directory && isHomeFragment(token.fragment);
    const prefixDirectory = bareHome ? `~${parts.separator}` : parts.directory;
    const basename = bareHome ? "" : parts.basename;
    const caseSensitive = process.platform !== "win32";
    const expected = caseSensitive ? basename : basename.toLowerCase();
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
          + prefixDirectory
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

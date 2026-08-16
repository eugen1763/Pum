import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalPathIdentity, canonicalRealpath, isPathInside } from "./platform";
import { createWorktree, type WorktreeRecord } from "./worktree";

const execFileAsync = promisify(execFile);

export type WorktreeStart = {
  /** The generated worktree; this becomes the active project. */
  worktree: WorktreeRecord;
  /**
   * Canonical identity of the repository the worktree came from. The caller
   * grants it as an extra writable root, so it is the resolved path — links
   * followed, and on Windows case-folded — not the spelling the user typed.
   */
  sourceRoot: string;
};

/**
 * `git worktree add` checks out a commit, so anything still unstaged or
 * uncommitted stays in the source tree. Repeat this wherever the flow reports
 * success: someone who edits a file, runs `pum worktree`, and lands in a tree
 * without those edits reads it as lost work.
 */
export const UNCOMMITTED_CHANGES_NOTICE =
  "Uncommitted changes in the source repository are not copied; "
    + "the worktree starts from the current commit.";

async function git(cwd: string, args: string[]): Promise<string> {
  // execFile, never a shell: a repository path can hold quotes, spaces, and
  // shell metacharacters.
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  // Only the line ending goes: a directory name may end in a space, and
  // trimming it turns a valid repository root into a path that does not exist.
  return result.stdout.replace(/\r?\n$/, "");
}

async function assertDirectory(path: string): Promise<void> {
  let entry;
  try {
    // stat follows symlinks and junctions, so a linked project directory is
    // accepted and judged by what it points at.
    entry = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`Cannot start a worktree in ${path}: the directory does not exist`);
    }
    throw new Error(`Cannot start a worktree in ${path}: ${(error as Error).message}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`Cannot start a worktree in ${path}: it is a file, not a directory`);
  }
}

async function repositoryRoot(directory: string): Promise<string> {
  let top: string;
  try {
    top = await git(directory, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Cannot start a worktree: git is not installed or not on PATH");
    }
    throw new Error(`Cannot start a worktree in ${directory}: it is not inside a git repository`);
  }
  if (!top) {
    throw new Error(`Cannot start a worktree in ${directory}: it is not inside a git repository`);
  }
  try {
    // The real spelling, not an identity. This value is used as a directory -
    // the session runs there and writes there - and canonicalPathIdentity
    // lowercases on Windows, which is only for comparing two paths.
    return await canonicalRealpath(top);
  } catch (error) {
    throw new Error(`Cannot start a worktree: repository root ${top} does not resolve: `
      + (error as Error).message);
  }
}

/**
 * Create an auto-named worktree of the repository holding `directory` and
 * report both identities the caller needs: the new worktree to run in, and the
 * source repository to keep writable.
 *
 * The name is always generated. A caller- or model-supplied name never reaches
 * `createWorktree`, so a crafted name cannot steer the branch or the path.
 *
 * A dirty source tree is fine — see UNCOMMITTED_CHANGES_NOTICE for what that
 * costs.
 *
 * `cwd` resolves a relative `directory` and exists so tests need not chdir.
 */
export async function startWorktree(
  directory?: string,
  cwd: string = process.cwd(),
): Promise<WorktreeStart> {
  const requested = resolve(cwd, directory ?? ".");
  await assertDirectory(requested);
  const sourceRoot = await repositoryRoot(requested);

  // createWorktree rejects a detached HEAD too, but only after it has resolved
  // the root and read HEAD. Check first so the failure names this flow and this
  // directory instead of the generic creation error. A paused rebase or bisect
  // also leaves no current branch, and there the fix is to finish it, not to
  // check one out.
  const branch = await git(sourceRoot, ["branch", "--show-current"]);
  if (!branch) {
    throw new Error(
      `Cannot start a worktree in ${sourceRoot}: HEAD is not on a branch. `
        + "Check out a branch, or finish an in-progress rebase or bisect, first.",
    );
  }
  // A branch can exist before its first commit, and there is no commit to base
  // the worktree on. Say that, rather than letting git's raw "unknown revision
  // HEAD" out.
  const unborn = await git(sourceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"])
    .then(() => false)
    .catch(() => true);
  if (unborn) {
    throw new Error(
      `Cannot start a worktree in ${sourceRoot}: branch ${branch} has no commits yet`,
    );
  }

  let worktree: WorktreeRecord;
  try {
    worktree = await createWorktree(sourceRoot);
  } catch (error) {
    throw new Error(`Cannot start a worktree in ${sourceRoot}: ${(error as Error).message}`);
  }

  try {
    await assertManaged(sourceRoot, worktree);
  } catch (error) {
    // The worktree exists on disk but sits outside the managed directory, so
    // removeWorktree would refuse it anyway. Leave it and name it: deleting a
    // checkout we cannot vouch for risks taking work with it.
    throw new Error(
      `${(error as Error).message}. Worktree ${worktree.path} on branch ${worktree.branch} was kept; `
        + "remove it by hand once you have checked it.",
    );
  }

  return { worktree, sourceRoot };
}

/**
 * Confirm the new checkout really lives under this repository's managed
 * directory. createWorktree compares realpath spellings; identities fold the
 * case and short-path spellings Windows also answers with, so a valid root is
 * not rejected and a foreign one is not authorized.
 */
async function assertManaged(sourceRoot: string, worktree: WorktreeRecord): Promise<void> {
  const [managed, created] = await Promise.all([
    canonicalPathIdentity(resolve(sourceRoot, ".pum", "worktrees")),
    canonicalPathIdentity(worktree.path),
  ]);
  if (!isPathInside(managed, created)) {
    throw new Error(`Created worktree resolves outside ${managed}`);
  }
}

export function worktreeStartMessage(start: WorktreeStart): string {
  const { worktree, sourceRoot } = start;
  return [
    `Started worktree ${worktree.name} on branch ${worktree.branch}`,
    `  path:   ${worktree.path}`,
    `  source: ${sourceRoot} (${worktree.baseBranch} at ${worktree.baseCommit.slice(0, 7)})`,
    `  ${UNCOMMITTED_CHANGES_NOTICE}`,
  ].join("\n");
}

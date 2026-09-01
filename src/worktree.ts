import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { isPathInside, type RuntimePlatform } from "./platform";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const ADJECTIVES = [
  "amber", "brisk", "calm", "cedar", "cobalt", "coral", "crisp", "dawn",
  "ember", "frost", "golden", "jade", "lunar", "misty", "quiet", "silver",
];
const NOUNS = [
  "badger", "falcon", "fox", "heron", "lynx", "marten", "otter", "owl",
  "panda", "raven", "seal", "sparrow", "tiger", "wolf", "wren", "yak",
];

export type WorktreeRecord = {
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
};

async function git(
  cwd: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...(environment ? { env: { ...process.env, ...environment } } : {}),
  });
  return result.stdout.trim();
}

/**
 * Run git where the output is a path.
 *
 * `git()` trims, which most callers want - the porcelain and status readers
 * test the result for emptiness. A path is different: a directory name may end
 * in a space, and trimming it produces a path that does not exist.
 */
async function gitPath(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.replace(/\r?\n$/, "");
}

export function normalizeWorktreeName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  if (!normalized) throw new Error("Worktree name must contain a letter or number");
  return normalized.slice(0, 48);
}

export function randomWorktreeName(): string {
  const bytes = randomBytes(4);
  const adjective = ADJECTIVES[bytes[0]! % ADJECTIVES.length]!;
  const noun = NOUNS[bytes[1]! % NOUNS.length]!;
  // The suffix uses the two bytes the words did not consume. Reusing the word
  // bytes would repeat what the words already say and add no entropy.
  return `${adjective}-${noun}-${bytes.toString("hex").slice(4)}`;
}

async function repositoryRoot(cwd: string): Promise<string> {
  return realpath(await gitPath(cwd, ["rev-parse", "--show-toplevel"]));
}

async function managedRoot(root: string): Promise<string> {
  const directory = await realpath(resolve(root, ".pum", "worktrees"));
  if (!isPathInside(root, directory)) {
    throw new Error(`Managed worktree directory resolves outside the project: ${directory}`);
  }
  return directory;
}

async function managedWorktreePath(cwd: string, path: string): Promise<string> {
  const root = await repositoryRoot(cwd);
  const parent = await managedRoot(root);
  const canonical = await realpath(path);
  if (!isPathInside(parent, canonical)) {
    throw new Error(`Worktree path resolves outside the managed directory: ${path}`);
  }
  return canonical;
}

async function excludeManagedDirectory(root: string): Promise<void> {
  const rawExcludePath = await gitPath(root, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(root, rawExcludePath);
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    // Git creates this file lazily.
  }
  const rule = ".pum/";
  if (current.split(/\r?\n/).includes(rule)) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${current}${prefix}${rule}\n`, "utf8");
}

export async function createWorktree(cwd: string, requestedName?: string): Promise<WorktreeRecord> {
  const root = await repositoryRoot(cwd);
  const baseBranch = await git(root, ["branch", "--show-current"]);
  if (!baseBranch) throw new Error("Cannot create a PUM worktree from a detached HEAD");
  const baseCommit = await git(root, ["rev-parse", "HEAD"]);
  const name = normalizeWorktreeName(requestedName || randomWorktreeName());
  const branch = `pum/${name}`;
  const directory = resolve(root, ".pum", "worktrees", name);

  await mkdir(join(root, ".pum", "worktrees"), { recursive: true });
  const parent = await managedRoot(root);
  await excludeManagedDirectory(root);
  await git(root, ["worktree", "add", "-b", branch, directory, baseCommit]);

  const canonicalDirectory = await realpath(directory);
  if (!isPathInside(parent, canonicalDirectory)) {
    throw new Error(`Created worktree resolves outside the managed directory: ${canonicalDirectory}`);
  }
  return { name, path: canonicalDirectory, branch, baseBranch, baseCommit };
}

function parseWorktreeRecords(
  output: string,
  platform: RuntimePlatform,
): WorktreeRecord[] {
  const nulDelimited = output.includes("\0");
  const blocks = nulDelimited ? output.split(/\0\0+/) : output.split(/\r?\n\r?\n+/);
  const paths = platform === "win32" ? win32 : posix;
  const records: WorktreeRecord[] = [];

  for (const block of blocks) {
    const fields = new Map<string, string>();
    const lines = nulDelimited ? block.split("\0") : block.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      const space = line.indexOf(" ");
      if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
    }
    const path = fields.get("worktree");
    if (!path) continue;
    const branchRef = fields.get("branch") ?? "";
    records.push({
      name: paths.basename(path),
      path,
      branch: branchRef.replace(/^refs\/heads\//, ""),
      baseBranch: "",
      baseCommit: fields.get("HEAD") ?? "",
    });
  }
  return records;
}

export function parseWorktreePorcelain(
  output: string,
  managedRoot: string,
  platform: RuntimePlatform = process.platform,
): WorktreeRecord[] {
  return parseWorktreeRecords(output, platform)
    .filter((record) => isPathInside(managedRoot, record.path, platform));
}

export async function canonicalizeManagedWorktreeRecords(
  records: WorktreeRecord[],
  parent: string,
  platform: RuntimePlatform = process.platform,
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<WorktreeRecord[]> {
  const paths = platform === "win32" ? win32 : posix;
  const canonicalParent = await resolvePath(parent);
  const canonicalRecords: WorktreeRecord[] = [];
  for (const record of records) {
    let path: string;
    try {
      path = await resolvePath(record.path);
    } catch {
      continue;
    }
    if (!isPathInside(canonicalParent, path, platform)) continue;
    canonicalRecords.push({ ...record, name: paths.basename(path), path });
  }
  return canonicalRecords;
}

export async function listWorktrees(cwd: string): Promise<WorktreeRecord[]> {
  const root = await repositoryRoot(cwd);
  let parent: string;
  try {
    parent = await managedRoot(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const output = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const records = parseWorktreeRecords(output, process.platform);
  return canonicalizeManagedWorktreeRecords(records, parent);
}

export async function worktreeStatus(
  cwd: string,
  record: WorktreeRecord,
  readonly = false,
): Promise<string> {
  const path = await managedWorktreePath(cwd, record.path);
  const status = await git(
    path,
    ["status", "--short", "--branch"],
    readonly ? { GIT_OPTIONAL_LOCKS: "0" } : undefined,
  );
  return status || `## ${record.branch}`;
}

/**
 * Refuse a merge that would land on the wrong branch. A worktree records the
 * branch it was created from, and the merge runs in the repository root against
 * whatever is checked out there. Without this check a detached HEAD or an
 * unrelated branch silently absorbs the work, and the later branch removal makes
 * it look merged. Records from `git worktree list` carry no base branch, so an
 * empty value keeps the old unchecked behavior instead of failing.
 */
async function assertMergeTarget(root: string, record: WorktreeRecord): Promise<void> {
  if (!record.baseBranch) return;
  const current = await git(root, ["branch", "--show-current"]);
  if (!current) {
    throw new Error(
      `Cannot merge ${record.branch} onto a detached HEAD; check out ${record.baseBranch} first`,
    );
  }
  if (current !== record.baseBranch) {
    throw new Error(
      `Cannot merge ${record.branch} into ${current}; it was created from ${record.baseBranch}. `
        + `Check out ${record.baseBranch} and merge again.`,
    );
  }
}

export async function mergeWorktree(cwd: string, record: WorktreeRecord): Promise<string> {
  const root = await repositoryRoot(cwd);
  const path = await managedWorktreePath(root, record.path);
  await assertMergeTarget(root, record);
  const mainStatus = await git(root, ["status", "--porcelain"]);
  if (mainStatus) throw new Error(`The current worktree must be clean before merging:\n${mainStatus}`);
  const childStatus = await git(path, ["status", "--porcelain"]);
  if (childStatus) throw new Error(`Worktree ${record.name} has uncommitted changes`);
  try {
    return await git(root, ["merge", "--no-ff", record.branch]);
  } catch (error) {
    // A conflicted merge leaves the main worktree mid-merge (MERGE_HEAD, a
    // conflicted index, and conflict markers), which blocks every later merge.
    // Abort to restore a clean tree, then report the failure.
    await git(root, ["merge", "--abort"]).catch(() => {});
    throw new Error(
      `Merge of ${record.branch} failed and was aborted; resolve the conflict manually. `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  return git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
}

async function branchIsMerged(root: string, branch: string): Promise<boolean> {
  const merged = await git(root, ["branch", "--merged", "HEAD", "--format=%(refname:short)"]);
  return merged.split(/\r?\n/).includes(branch);
}

export async function removeWorktree(
  cwd: string,
  record: WorktreeRecord,
  force = false,
): Promise<void> {
  const root = await repositoryRoot(cwd);
  let path: string;
  try {
    path = await managedWorktreePath(root, record.path);
  } catch (error) {
    // The working tree directory may have been pruned or deleted out of band
    // (e.g. `git worktree prune` or a manual delete after a crash). Clean git's
    // stale admin records and the branch so the managed agent can still be
    // closed instead of blocking its parent forever.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      await git(root, ["worktree", "prune"]).catch(() => {});
      // A missing directory is not permission to discard commits. Apply the
      // same merged check as a normal removal so a non-force close cannot
      // delete an unmerged branch, and delete it safely when it is merged.
      if (!force
        && await branchExists(root, record.branch)
        && !await branchIsMerged(root, record.branch)) {
        throw new Error(
          `The worktree directory for ${record.name} is missing and branch ${record.branch} is not merged. `
            + `Its commits are kept. Merge ${record.branch} first and remove it again, or remove it with force.`,
        );
      }
      await git(root, ["branch", force ? "-D" : "-d", record.branch]).catch(() => {});
      return;
    }
    throw error;
  }
  if (!force && !await branchIsMerged(root, record.branch)) {
    throw new Error(`Branch ${record.branch} is not merged; use force to remove it`);
  }
  await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  await git(root, ["branch", force ? "-D" : "-d", record.branch]);
}

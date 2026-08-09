import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
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

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function safeName(value: string): string {
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
  return `${adjective}-${noun}-${bytes.toString("hex").slice(0, 4)}`;
}

async function repositoryRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

async function excludeManagedDirectory(root: string): Promise<void> {
  const rawExcludePath = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
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
  const name = safeName(requestedName || randomWorktreeName());
  const branch = `pum/${name}`;
  const directory = resolve(root, ".pum", "worktrees", name);

  await mkdir(join(root, ".pum", "worktrees"), { recursive: true });
  await excludeManagedDirectory(root);
  await git(root, ["worktree", "add", "-b", branch, directory, baseCommit]);

  return { name, path: directory, branch, baseBranch, baseCommit };
}

export async function listWorktrees(cwd: string): Promise<WorktreeRecord[]> {
  const root = await repositoryRoot(cwd);
  const managedRoot = resolve(root, ".pum", "worktrees");
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];

  for (const block of output.split(/\n\n+/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
    }
    const path = fields.get("worktree");
    if (!path || !resolve(path).startsWith(`${managedRoot}/`)) continue;
    const branchRef = fields.get("branch") ?? "";
    records.push({
      name: basename(path),
      path,
      branch: branchRef.replace(/^refs\/heads\//, ""),
      baseBranch: "",
      baseCommit: fields.get("HEAD") ?? "",
    });
  }
  return records;
}

export async function worktreeStatus(cwd: string, record: WorktreeRecord): Promise<string> {
  const status = await git(record.path, ["status", "--short", "--branch"]);
  return status || `## ${record.branch}`;
}

export async function mergeWorktree(cwd: string, record: WorktreeRecord): Promise<string> {
  const root = await repositoryRoot(cwd);
  const mainStatus = await git(root, ["status", "--porcelain"]);
  if (mainStatus) throw new Error(`The current worktree must be clean before merging:\n${mainStatus}`);
  const childStatus = await git(record.path, ["status", "--porcelain"]);
  if (childStatus) throw new Error(`Worktree ${record.name} has uncommitted changes`);
  return git(root, ["merge", "--no-ff", record.branch]);
}

export async function removeWorktree(
  cwd: string,
  record: WorktreeRecord,
  force = false,
): Promise<void> {
  const root = await repositoryRoot(cwd);
  if (!force) {
    const merged = await git(root, ["branch", "--merged", "HEAD", "--format=%(refname:short)"]);
    if (!merged.split("\n").includes(record.branch)) {
      throw new Error(`Branch ${record.branch} is not merged; use force to remove it`);
    }
  }
  await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), record.path]);
  await git(root, ["branch", force ? "-D" : "-d", record.branch]);
}

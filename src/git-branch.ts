import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * pi has a FooterDataProvider that does this, but only the read-only *type* is
 * exported from the package root and deep imports are blocked by its exports
 * map, so PUM reads HEAD itself.
 */
function findGitDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      // In a worktree, .git is a file holding "gitdir: <path>".
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      return match ? resolve(dir, match[1]!.trim()) : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readBranch(cwd: string): string | null {
  try {
    const gitDir = findGitDir(cwd);
    if (!gitDir) return null;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1]! : "detached";
  } catch {
    return null;
  }
}

/** Calls back when HEAD changes — a checkout, a commit on a new branch. */
export function watchBranch(cwd: string, onChange: () => void): () => void {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(join(gitDir, "HEAD"), () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 100);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => clearTimeout(timer);
  }
}

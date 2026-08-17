import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonicalPathIdentity, isPathInside, pathsHaveSameIdentity } from "../src/platform";
import {
  UNCOMMITTED_CHANGES_NOTICE,
  startWorktree,
  worktreeStartMessage,
} from "../src/worktree-start";

const root = mkdtempSync(join(tmpdir(), "pum-worktree-start-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterAll(() => rmSync(root, {
  recursive: true,
  force: true,
  maxRetries: process.platform === "win32" ? 10 : 0,
  retryDelay: 100,
}));

const setup = (name: string) => {
  const repo = mkdtempSync(join(root, `${name}-`));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "pum@example.test");
  git(repo, "config", "user.name", "PUM Test");
  writeFileSync(join(repo, "file.txt"), "main\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "initial");
  return repo;
};

const generatedName = /^[a-z]+-[a-z]+-[0-9a-f]{4}$/;

describe("starting a worktree", () => {
  test("creates an auto-named worktree inside the managed directory", async () => {
    const repo = setup("happy");
    const start = await startWorktree(repo);

    expect(start.worktree.name).toMatch(generatedName);
    expect(start.worktree.branch).toBe(`pum/${start.worktree.name}`);
    expect(start.worktree.baseBranch).toBe("main");
    expect(start.worktree.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(await pathsHaveSameIdentity(start.sourceRoot, repo)).toBe(true);
    expect(isPathInside(
      await canonicalPathIdentity(join(repo, ".pum", "worktrees")),
      await canonicalPathIdentity(start.worktree.path),
    )).toBe(true);
    expect(git(start.worktree.path, "rev-parse", "--abbrev-ref", "HEAD"))
      .toBe(start.worktree.branch);
  }, 30_000);

  test("names the worktree itself and never after the directory", async () => {
    const repo = setup("naming");
    const first = await startWorktree(repo);
    const second = await startWorktree(repo);

    expect(second.worktree.name).not.toBe(first.worktree.name);
    for (const start of [first, second]) {
      expect(start.worktree.name).toMatch(generatedName);
      expect(start.worktree.name).not.toContain(basename(repo));
    }
  }, 30_000);

  test("resolves a relative directory against the given working directory", async () => {
    const repo = setup("relative");
    const start = await startWorktree(basename(repo), root);
    expect(await pathsHaveSameIdentity(start.sourceRoot, repo)).toBe(true);
  }, 30_000);

  test("starts from a dirty source tree without copying the changes", async () => {
    const repo = setup("dirty");
    writeFileSync(join(repo, "file.txt"), "edited but not committed\n");
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");

    const start = await startWorktree(repo);

    expect(readFileSync(join(start.worktree.path, "file.txt"), "utf8"))
      .toContain("main");
    expect(() => readFileSync(join(start.worktree.path, "untracked.txt"), "utf8")).toThrow();
    // The source keeps its own changes.
    expect(git(repo, "status", "--porcelain")).toContain("file.txt");
  }, 30_000);
});

describe("rejected starts", () => {
  test("rejects a file", async () => {
    const repo = setup("a-file");
    await expect(startWorktree(join(repo, "file.txt")))
      .rejects.toThrow("it is a file, not a directory");
  }, 30_000);

  test("rejects a missing directory", async () => {
    const repo = setup("missing");
    await expect(startWorktree(join(repo, "absent")))
      .rejects.toThrow("the directory does not exist");
  }, 30_000);

  test("rejects a directory outside any repository", async () => {
    const plain = mkdtempSync(join(root, "not-a-repo-"));
    await expect(startWorktree(plain))
      .rejects.toThrow("it is not inside a git repository");
  }, 30_000);

  test("rejects a detached HEAD", async () => {
    const repo = setup("detached");
    git(repo, "checkout", "--detach", "HEAD");
    await expect(startWorktree(repo))
      .rejects.toThrow("HEAD is not on a branch");
  }, 30_000);

  test("rejects a repository without a first commit", async () => {
    const repo = mkdtempSync(join(root, "unborn-"));
    git(repo, "init", "-b", "main");
    await expect(startWorktree(repo)).rejects.toThrow("branch main has no commits yet");
  }, 30_000);
});

describe("start message", () => {
  test("names both identities and warns about uncommitted changes", () => {
    const message = worktreeStartMessage({
      sourceRoot: "/repo",
      worktree: {
        name: "amber-owl-1234",
        path: "/repo/.pum/worktrees/amber-owl-1234",
        branch: "pum/amber-owl-1234",
        baseBranch: "main",
        baseCommit: "0123456789abcdef",
      },
    });
    expect(message).toContain("pum/amber-owl-1234");
    expect(message).toContain("/repo/.pum/worktrees/amber-owl-1234");
    expect(message).toContain("/repo (main at 0123456)");
    expect(message).toContain(UNCOMMITTED_CHANGES_NOTICE);
  });
});

describe("the source root is a path, not an identity", () => {
  test("keeps the spelling the filesystem uses", async () => {
    // sourceRoot is a directory the session runs and writes in, so it must be
    // the real spelling. canonicalPathIdentity lowercases on Windows, which is
    // only ever right for comparing two paths.
    const repo = mkdtempSync(join(tmpdir(), "PumMixedCase-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "hi\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

      const started = await startWorktree(repo);
      expect(started.sourceRoot).toContain("PumMixedCase-");
      expect(existsSync(started.sourceRoot)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});


import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsHaveSameIdentity } from "../src/platform";
import {
  canonicalizeManagedWorktreeRecords,
  createWorktree,
  listWorktrees,
  mergeWorktree,
  parseWorktreePorcelain,
  randomWorktreeName,
  removeWorktree,
  worktreeStatus,
} from "../src/worktree";

const root = mkdtempSync(join(tmpdir(), "pum-worktree-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const normalizeGitCheckoutLineEndings = (content: string) => content.replaceAll("\r\n", "\n");

afterAll(() => rmSync(root, {
  recursive: true,
  force: true,
  maxRetries: process.platform === "win32" ? 10 : 0,
  retryDelay: 100,
}));

describe("worktree porcelain parsing", () => {
  test("accepts CRLF and Windows paths with spaces and case variants", () => {
    const output = [
      "worktree C:\\Repo With Space\\.pum\\worktrees\\Agent One",
      "HEAD abc123",
      "branch refs/heads/pum/agent-one",
      "",
      "worktree C:\\Repo With Space\\.pum\\worktrees-other\\Agent Two",
      "HEAD def456",
      "branch refs/heads/pum/agent-two",
      "",
    ].join("\r\n");
    const records = parseWorktreePorcelain(
      output,
      "c:\\repo with space\\.PUM\\WORKTREES",
      "win32",
    );
    expect(records).toEqual([{
      name: "Agent One",
      path: "C:\\Repo With Space\\.pum\\worktrees\\Agent One",
      branch: "pum/agent-one",
      baseBranch: "",
      baseCommit: "abc123",
    }]);
  });

  test("accepts NUL-delimited paths without quoting", () => {
    const output = "worktree /repo/.pum/worktrees/agent one\0HEAD abc123\0branch refs/heads/pum/agent-one\0\0";
    expect(parseWorktreePorcelain(output, "/repo/.pum/worktrees", "linux")[0]?.name)
      .toBe("agent one");
  });

  test("canonicalizes Windows short paths before managed containment", async () => {
    const records = [{
      name: "AGENT~1",
      path: "C:\\Users\\RUNNER~1\\repo\\.pum\\worktrees\\AGENT~1",
      branch: "pum/agent-one",
      baseBranch: "",
      baseCommit: "abc123",
    }, {
      name: "outside",
      path: "C:\\Users\\runneradmin\\outside",
      branch: "pum/outside",
      baseBranch: "",
      baseCommit: "def456",
    }];
    const resolvePath = async (path: string) => path
      .replace("RUNNER~1", "runneradmin")
      .replace("AGENT~1", "agent-one");
    expect(await canonicalizeManagedWorktreeRecords(
      records,
      "C:\\Users\\runneradmin\\repo\\.pum\\worktrees",
      "win32",
      resolvePath,
    )).toEqual([{ ...records[0], name: "agent-one", path: "C:\\Users\\runneradmin\\repo\\.pum\\worktrees\\agent-one" }]);
  });
});

describe("Git checkout line endings", () => {
  test("normalizes LF and CRLF without hiding other content changes", () => {
    expect([
      "agent\n",
      "agent\r\n",
      "changed\r\n",
      "agent\r",
      "agent\r\ncorrupt",
    ].map(normalizeGitCheckoutLineEndings)).toEqual([
      "agent\n",
      "agent\n",
      "changed\n",
      "agent\r",
      "agent\ncorrupt",
    ]);
  });
});

describe("PUM worktrees", () => {
  test("create, list, merge, and remove", async () => {
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "pum@example.test");
    git(root, "config", "user.name", "PUM Test");
    writeFileSync(join(root, "file.txt"), "main\n");
    git(root, "add", "file.txt");
    git(root, "commit", "-m", "initial");

    const record = await createWorktree(root, "test-agent");
    expect(record.branch).toBe("pum/test-agent");
    expect(await pathsHaveSameIdentity(
      record.path,
      join(root, ".pum", "worktrees", "test-agent"),
    )).toBe(true);

    const listed = await listWorktrees(root);
    expect(listed.some((item) => item.branch === record.branch)).toBe(true);
    expect(await worktreeStatus(root, record, true)).toContain(`## ${record.branch}`);
    await expect(worktreeStatus(root, { ...record, path: root }))
      .rejects.toThrow("outside the managed directory");

    git(record.path, "config", "user.email", "pum@example.test");
    git(record.path, "config", "user.name", "PUM Test");
    writeFileSync(join(record.path, "file.txt"), "agent\n");
    git(record.path, "add", "file.txt");
    git(record.path, "commit", "-m", "agent change");

    await mergeWorktree(root, record);
    expect(normalizeGitCheckoutLineEndings(
      readFileSync(join(root, "file.txt"), "utf8"),
    )).toBe("agent\n");

    await removeWorktree(root, record);
    expect((await listWorktrees(root)).some((item) => item.name === record.name)).toBe(false);
  }, 30_000);
});

describe("PUM worktree merge target", () => {
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

  test("refuses a merge onto another branch or a detached HEAD", async () => {
    const repo = setup("merge-target");
    const record = await createWorktree(repo, "target-agent");
    git(record.path, "config", "user.email", "pum@example.test");
    git(record.path, "config", "user.name", "PUM Test");
    writeFileSync(join(record.path, "file.txt"), "agent\n");
    git(record.path, "add", "file.txt");
    git(record.path, "commit", "-m", "agent change");

    git(repo, "checkout", "-b", "release");
    await expect(mergeWorktree(repo, record)).rejects.toThrow(
      "Cannot merge pum/target-agent into release; it was created from main",
    );
    expect(git(repo, "rev-parse", "release")).toBe(git(repo, "rev-parse", "main"));

    git(repo, "checkout", "--detach", "main");
    await expect(mergeWorktree(repo, record)).rejects.toThrow(
      "Cannot merge pum/target-agent onto a detached HEAD; check out main first",
    );

    git(repo, "checkout", "main");
    await mergeWorktree(repo, record);
    expect(normalizeGitCheckoutLineEndings(
      readFileSync(join(repo, "file.txt"), "utf8"),
    )).toBe("agent\n");
    await removeWorktree(repo, record);
  }, 30_000);

  test("merges a legacy record without a recorded base branch", async () => {
    const repo = setup("merge-legacy");
    const record = await createWorktree(repo, "legacy-agent");
    git(record.path, "config", "user.email", "pum@example.test");
    git(record.path, "config", "user.name", "PUM Test");
    writeFileSync(join(record.path, "file.txt"), "legacy\n");
    git(record.path, "add", "file.txt");
    git(record.path, "commit", "-m", "legacy change");

    git(repo, "checkout", "-b", "other");
    await mergeWorktree(repo, { ...record, baseBranch: "" });
    expect(normalizeGitCheckoutLineEndings(
      readFileSync(join(repo, "file.txt"), "utf8"),
    )).toBe("legacy\n");
  }, 30_000);

  test("keeps an unmerged branch when the worktree directory is missing", async () => {
    const repo = setup("missing-directory");
    const record = await createWorktree(repo, "stranded-agent");
    git(record.path, "config", "user.email", "pum@example.test");
    git(record.path, "config", "user.name", "PUM Test");
    writeFileSync(join(record.path, "file.txt"), "stranded\n");
    git(record.path, "add", "file.txt");
    git(record.path, "commit", "-m", "stranded change");
    const stranded = git(record.path, "rev-parse", "HEAD");
    rmSync(record.path, { recursive: true, force: true });

    await expect(removeWorktree(repo, record)).rejects.toThrow(
      "branch pum/stranded-agent is not merged",
    );
    expect(git(repo, "rev-parse", record.branch)).toBe(stranded);

    // The same missing directory with a merged branch still closes the agent.
    git(repo, "merge", "--no-ff", "-m", "merge stranded", record.branch);
    await removeWorktree(repo, record);
    expect(() => git(repo, "rev-parse", "--verify", record.branch)).toThrow();
  }, 30_000);
});

describe("random worktree names", () => {
  test("draws the suffix from bytes that do not pick the adjective or noun", () => {
    // The old suffix was the hex of the same two bytes the words came from, so
    // every adjective carried one fixed suffix digit and every noun another.
    const adjectiveDigits = new Map<string, Set<string>>();
    const nounDigits = new Map<string, Set<string>>();
    const record = (seen: Map<string, Set<string>>, word: string, digit: string) => {
      const digits = seen.get(word) ?? new Set<string>();
      digits.add(digit);
      seen.set(word, digits);
    };

    for (let attempt = 0; attempt < 200; attempt++) {
      const name = randomWorktreeName();
      const [adjective, noun, suffix] = name.split("-");
      expect(suffix).toMatch(/^[0-9a-f]{4}$/);
      record(adjectiveDigits, adjective!, suffix![1]!);
      record(nounDigits, noun!, suffix![3]!);
    }

    expect([...adjectiveDigits.values()].some((digits) => digits.size > 1)).toBe(true);
    expect([...nounDigits.values()].some((digits) => digits.size > 1)).toBe(true);
  });
});

// Windows strips a trailing space from a path component, so "repo dir " is
// created as "repo dir" and the case this guards cannot be built there.
describe.skipIf(process.platform === "win32")("a repository whose name ends in a space", () => {
  test("resolves rather than being trimmed into a path that does not exist", async () => {
    // git prints the toplevel followed by a newline. Trimming that output also
    // ate a trailing space in the directory name, and every later call landed
    // on a path that was never there.
    const spaced = join(root, "repo dir ");
    mkdirSync(spaced);
    git(spaced, "init", "-q", ".");
    git(spaced, "config", "user.email", "t@t");
    git(spaced, "config", "user.name", "t");
    writeFileSync(join(spaced, "a.txt"), "hi\n");
    git(spaced, "add", "-A");
    git(spaced, "commit", "-qm", "init");

    const record = await createWorktree(spaced);
    expect(record.path).toContain("repo dir ");
    expect(existsSync(record.path)).toBe(true);
  }, 30_000);
});

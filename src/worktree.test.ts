import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsHaveSameIdentity } from "./platform";
import {
  canonicalizeManagedWorktreeRecords,
  createWorktree,
  listWorktrees,
  mergeWorktree,
  parseWorktreePorcelain,
  removeWorktree,
  worktreeStatus,
} from "./worktree";

const root = mkdtempSync(join(tmpdir(), "pum-worktree-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const normalizeGitCheckoutLineEndings = (content: string) => content.replaceAll("\r\n", "\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

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
  });
});

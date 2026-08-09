import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
} from "./worktree";

const root = mkdtempSync(join(tmpdir(), "pum-worktree-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterAll(() => rmSync(root, { recursive: true, force: true }));

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
    expect(record.path).toBe(join(root, ".pum", "worktrees", "test-agent"));

    const listed = await listWorktrees(root);
    expect(listed.some((item) => item.branch === record.branch)).toBe(true);

    git(record.path, "config", "user.email", "pum@example.test");
    git(record.path, "config", "user.name", "PUM Test");
    writeFileSync(join(record.path, "file.txt"), "agent\n");
    git(record.path, "add", "file.txt");
    git(record.path, "commit", "-m", "agent change");

    await mergeWorktree(root, record);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("agent\n");

    await removeWorktree(root, record);
    expect((await listWorktrees(root)).some((item) => item.name === record.name)).toBe(false);
  });
});

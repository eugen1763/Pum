import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionDir } from "../src/config";
import { canonicalRealpathSync } from "../src/platform";
import { saveRelocation, type RelocationRecord } from "../src/relocation";
import {
  listProjectSessions,
  resolveSessionResumeAliases,
  resumeAliasFileFor,
  syncSessionResumeAliases,
} from "../src/session-resume-alias";
import { startWorktree } from "../src/worktree-start";
import { lockedProjectSession } from "../src/session-lock-runtime";
import { SessionLockedError, SessionLockOwner } from "../src/session-lock";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can briefly retain Git worktree handles after a test.
    }
  }
});

function repository(): string {
  const path = canonicalRealpathSync(mkdtempSync(join(tmpdir(), "pum-alias-repo-")));
  cleanup.push(path);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(path, "file.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return path;
}

function persistedSession(cwd: string): string {
  const id = randomUUID();
  const directory = sessionDir(cwd);
  const path = join(directory, `2026-08-18T00-00-00-000Z_${id}.jsonl`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-08-18T00:00:00.000Z",
    cwd,
  })}\n`, "utf8");
  cleanup.push(directory);
  return path;
}

async function activeRelocation(sourceRoot: string, sessionFile: string): Promise<RelocationRecord> {
  const started = await startWorktree(sourceRoot);
  const record: RelocationRecord = {
    id: `reloc-${randomUUID().slice(0, 8)}`,
    generation: 1,
    sourceRoot: started.sourceRoot,
    worktreePath: started.worktree.path,
    name: started.worktree.name,
    branch: started.worktree.branch,
    baseBranch: started.worktree.baseBranch,
    baseCommit: started.worktree.baseCommit,
    location: "worktree",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveRelocation(sessionFile, record);
  syncSessionResumeAliases(sessionFile, record);
  cleanup.push(sessionDir(record.worktreePath));
  return record;
}

describe("relocation resume aliases", () => {
  test("lists and resumes one canonical JSONL from the generated worktree", async () => {
    const source = repository();
    const sessionFile = persistedSession(source);
    const record = await activeRelocation(source, sessionFile);

    const aliases = resolveSessionResumeAliases(record.worktreePath);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.sessionFile).toBe(sessionFile);

    const sessions = await listProjectSessions(record.worktreePath);
    expect(sessions.map((session) => session.path)).toEqual([sessionFile]);

    const resumed = await lockedProjectSession(record.worktreePath, true, new SessionLockOwner());
    try { expect(resumed.sessionManager.getSessionFile()).toBe(sessionFile); }
    finally { resumed.release(); }
  }, 30_000);

  test("source and worktree startup contend for the same canonical owner", async () => {
    const source = repository();
    const sessionFile = persistedSession(source);
    const record = await activeRelocation(source, sessionFile);
    const startup = await lockedProjectSession(record.worktreePath, true, new SessionLockOwner());
    try {
      expect(startup.sessionManager.getSessionFile()).toBe(sessionFile);
      await expect(lockedProjectSession(source, true, new SessionLockOwner())).rejects.toBeInstanceOf(SessionLockedError);
      await expect(lockedProjectSession(record.worktreePath, true, new SessionLockOwner())).rejects.toBeInstanceOf(SessionLockedError);
    } finally { startup.release(); }
    const resumed = await lockedProjectSession(source, true, new SessionLockOwner());
    resumed.release();
  }, 30_000);

  test("removes the worktree alias on return and keeps source discovery", async () => {
    const source = repository();
    const sourceSubdirectory = join(source, "nested");
    mkdirSync(sourceSubdirectory);
    const sessionFile = persistedSession(sourceSubdirectory);
    const record = await activeRelocation(source, sessionFile);
    const worktreeAlias = resumeAliasFileFor(record.worktreePath, sessionFile, "worktree");
    const sourceAlias = resumeAliasFileFor(record.sourceRoot, sessionFile, "source");
    expect(existsSync(worktreeAlias)).toBe(true);
    expect(existsSync(sourceAlias)).toBe(true);

    syncSessionResumeAliases(sessionFile, { ...record, location: "source", generation: 2 });
    saveRelocation(sessionFile, null);

    expect(existsSync(worktreeAlias)).toBe(false);
    expect(existsSync(sourceAlias)).toBe(true);
    expect(await listProjectSessions(record.worktreePath)).toEqual([]);
    expect((await listProjectSessions(record.sourceRoot)).map((session) => session.path))
      .toEqual([sessionFile]);
  }, 30_000);

  test("rejects and removes an alias when the worktree branch changed", async () => {
    const source = repository();
    const sourceSubdirectory = join(source, "nested");
    mkdirSync(sourceSubdirectory);
    const sessionFile = persistedSession(sourceSubdirectory);
    const record = await activeRelocation(source, sessionFile);
    const aliasFile = resumeAliasFileFor(record.worktreePath, sessionFile, "worktree");

    execFileSync("git", ["switch", "-c", "replacement"], {
      cwd: record.worktreePath,
      encoding: "utf8",
    });

    expect(resolveSessionResumeAliases(record.worktreePath)).toEqual([]);
    expect(existsSync(aliasFile)).toBe(false);
    expect(await listProjectSessions(record.worktreePath)).toEqual([]);
    // Source lookup is safe: App will open the canonical session there, reject
    // the stale relocation, and never authorize the replaced worktree.
    expect((await listProjectSessions(record.sourceRoot)).map((session) => session.path))
      .toEqual([sessionFile]);
  }, 30_000);

  test("rejects an alias whose target session disappeared", async () => {
    const source = repository();
    const sessionFile = persistedSession(source);
    const record = await activeRelocation(source, sessionFile);
    const aliasFile = resumeAliasFileFor(record.worktreePath, sessionFile, "worktree");
    rmSync(sessionFile);

    expect(resolveSessionResumeAliases(record.worktreePath)).toEqual([]);
    expect(existsSync(aliasFile)).toBe(false);
    expect(dirname(aliasFile)).toBe(sessionDir(record.worktreePath));
  }, 30_000);
});

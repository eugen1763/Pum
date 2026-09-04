import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLockedAgentSessionRuntime } from "../src/session-lock-runtime";
import { SessionLockedError, SessionLockOwner } from "../src/session-lock";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pum-lock-runtime-test-"));
  roots.push(root);
  const manager = SessionManager.create(root, root);
  const persist = (manager: SessionManager) => {
    writeFileSync(manager.getSessionFile()!, `${JSON.stringify({ type: "session", version: 3, id: manager.getSessionId(), timestamp: new Date().toISOString(), cwd: root })}\n`);
  };
  persist(manager);
  return { root, manager, persist };
}
function factory(options: { fail?: boolean; cancel?: boolean; shutdownError?: boolean } = {}) {
  const sessions: any[] = [];
  const build = async ({ cwd, sessionManager }: any): Promise<any> => {
    if (options.fail) throw new Error("factory failed");
    const session = {
      sessionManager,
      sessionFile: sessionManager.getSessionFile(),
      disposed: false,
      aborts: 0,
      abort: async () => { session.aborts++; },
      dispose: () => { session.disposed = true; },
      extensionRunner: {
        hasHandlers: () => true,
        emit: async (event: any) => {
          if (event.type === "session_shutdown" && options.shutdownError) throw new Error("shutdown failed");
          return { cancel: options.cancel === true };
        },
      },
    };
    sessions.push(session);
    return { session, services: { cwd, agentDir: cwd }, diagnostics: [] };
  };
  return { build, sessions };
}

describe("locked session lifecycle", () => {
  test("failed startup releases its ownership", async () => {
    const { root, manager } = fixture();
    await expect(createLockedAgentSessionRuntime(factory({ fail: true }).build, {
      cwd: root, agentDir: root, sessionManager: manager,
    }, new SessionLockOwner())).rejects.toThrow("factory failed");
    new SessionLockOwner().acquire(manager.getSessionFile())();
  });

  test("history contention does not open, migrate, or dispose either session", async () => {
    const { root, manager } = fixture();
    const target = join(root, "target.jsonl");
    writeFileSync(target, ""); // pi would rewrite an empty file when opening it.
    const release = new SessionLockOwner().acquire(target);
    const { build, sessions } = factory();
    const runtime = await createLockedAgentSessionRuntime(build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    try {
      await expect(runtime.switchSession(target)).rejects.toBeInstanceOf(SessionLockedError);
      expect(runtime.session).toBe(sessions[0]);
      expect(sessions[0].disposed).toBe(false);
      expect(sessions[0].aborts).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("");
    } finally { release(); await runtime.dispose(); }
  });

  test("switch releases the outgoing session and keeps the target owned", async () => {
    const { root, manager, persist } = fixture();
    const target = SessionManager.create(root, root);
    persist(target);
    const runtime = await createLockedAgentSessionRuntime(factory().build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    try {
      await runtime.switchSession(target.getSessionFile()!);
      new SessionLockOwner().acquire(manager.getSessionFile())();
      expect(() => new SessionLockOwner().acquire(target.getSessionFile())).toThrow(SessionLockedError);
    } finally { await runtime.dispose(); }
    new SessionLockOwner().acquire(target.getSessionFile())();
  });

  test("same-file relocation keeps ownership throughout teardown and rebuild", async () => {
    const { root, manager } = fixture();
    const base = factory();
    let builds = 0;
    const build = async (context: any) => {
      expect(() => new SessionLockOwner().acquire(manager.getSessionFile())).toThrow(SessionLockedError);
      builds++;
      return base.build(context);
    };
    const runtime = await createLockedAgentSessionRuntime(build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    try {
      await runtime.switchSession(manager.getSessionFile()!, { cwdOverride: root });
      expect(builds).toBe(2);
      expect(() => new SessionLockOwner().acquire(manager.getSessionFile())).toThrow(SessionLockedError);
    } finally { await runtime.dispose(); }
  });

  test("cancelled switches release only the target reservation", async () => {
    const { root, manager, persist } = fixture();
    const target = SessionManager.create(root, root);
    persist(target);
    const runtime = await createLockedAgentSessionRuntime(factory({ cancel: true }).build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    try {
      expect((await runtime.switchSession(target.getSessionFile()!)).cancelled).toBe(true);
      new SessionLockOwner().acquire(target.getSessionFile())();
      expect(() => new SessionLockOwner().acquire(manager.getSessionFile())).toThrow(SessionLockedError);
    } finally { await runtime.dispose(); }
  });

  test("new session releases the old file and owns the new file", async () => {
    const { root, manager } = fixture();
    const runtime = await createLockedAgentSessionRuntime(factory().build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    try {
      await runtime.newSession();
      expect(runtime.session.sessionFile).not.toBe(manager.getSessionFile());
      new SessionLockOwner().acquire(manager.getSessionFile())();
      expect(() => new SessionLockOwner().acquire(runtime.session.sessionFile)).toThrow(SessionLockedError);
    } finally { await runtime.dispose(); }
  });

  test("invalid target open releases the reservation and preserves the current session", async () => {
    const { root, manager } = fixture();
    const target = join(root, "invalid.jsonl");
    writeFileSync(target, "invalid session\n");
    const runtime = await createLockedAgentSessionRuntime(factory().build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    try {
      await expect(runtime.switchSession(target)).rejects.toThrow();
      new SessionLockOwner().acquire(target)();
      expect(() => new SessionLockOwner().acquire(manager.getSessionFile())).toThrow(SessionLockedError);
    } finally { await runtime.dispose(); }
  });

  test("overlapping switches cannot share a reentrant owner, and shutdown waits for replacement", async () => {
    const { root, manager, persist } = fixture();
    const target = SessionManager.create(root, root);
    persist(target);
    const base = factory();
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let count = 0;
    const runtime = await createLockedAgentSessionRuntime(async (context) => {
      if (count++ > 0) { started(); await gate; }
      return base.build(context);
    }, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    const switching = runtime.switchSession(target.getSessionFile()!);
    await entered;
    await expect(runtime.newSession()).rejects.toThrow("already in progress");
    const closing = runtime.dispose();
    expect(() => new SessionLockOwner().acquire(target.getSessionFile())).toThrow(SessionLockedError);
    resume();
    await switching;
    await closing;
    new SessionLockOwner().acquire(target.getSessionFile())();
    await expect(runtime.newSession()).rejects.toThrow("closing");
  });

  test("shutdown failures still dispose and release, with idempotent runtime disposal", async () => {
    const { root, manager } = fixture();
    const { build, sessions } = factory({ shutdownError: true });
    const runtime = await createLockedAgentSessionRuntime(build, { cwd: root, agentDir: root, sessionManager: manager }, new SessionLockOwner());
    await expect(runtime.dispose()).rejects.toThrow("shutdown failed");
    await expect(runtime.dispose()).rejects.toThrow("shutdown failed");
    expect(sessions[0].disposed).toBe(true);
    expect(sessions[0].aborts).toBe(1);
    new SessionLockOwner().acquire(manager.getSessionFile())();
  });
});

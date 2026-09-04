import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalSessionPath, SessionLockedError, SessionLockOwner, releaseSessionLockOnDispose } from "../src/session-lock";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pum-session-lock-test-"));
  roots.push(root);
  return { root, path: join(root, "session.jsonl") };
}
const modulePath = resolve(import.meta.dir, "../src/session-lock.ts");
function child(path: string) {
  return Bun.spawn([process.execPath, "-e", `
    import { SessionLockOwner } from ${JSON.stringify(modulePath)};
    try {
      const release = new SessionLockOwner().acquire(process.argv[1]);
      console.log("owned");
      process.stdin.once("data", () => { release(); process.exit(0); });
      process.stdin.resume();
    } catch (error) { console.log(error.message); process.exit(2); }
  `, path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function firstLine(process: ReturnType<typeof child>) {
  const reader = process.stdout.getReader();
  try { return new TextDecoder().decode((await reader.read()).value).trim(); }
  finally { reader.releaseLock(); }
}

describe("session ownership", () => {
  test("separate same-process owners conflict; one owner can reserve a relocation", () => {
    const { path, root } = fixture();
    const owner = new SessionLockOwner();
    const release = owner.acquire(path);
    const reservation = owner.acquire(path);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    release();
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    reservation();
    reservation();
    new SessionLockOwner().acquire(path)();
    expect(readdirSync(root)).toEqual([]);
  });

  test("the lock identity is stable before and after JSONL creation", () => {
    const { path } = fixture();
    const before = canonicalSessionPath(path);
    const release = new SessionLockOwner().acquire(path);
    writeFileSync(path, "session");
    expect(canonicalSessionPath(path)).toBe(before);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    release();
  });

  test.skipIf(process.platform === "win32")("directory and file aliases use one canonical lock", () => {
    const { path, root } = fixture();
    writeFileSync(path, "session");
    const alias = join(root, "alias.jsonl");
    const directory = join(root, "directory");
    symlinkSync(path, alias);
    symlinkSync(root, directory);
    const release = new SessionLockOwner().acquire(path);
    expect(canonicalSessionPath(alias)).toBe(canonicalSessionPath(path));
    expect(() => new SessionLockOwner().acquire(alias)).toThrow(SessionLockedError);
    expect(() => new SessionLockOwner().acquire(join(directory, "session.jsonl"))).toThrow(SessionLockedError);
    release();
  });

  test("a child process cannot enter a live session", async () => {
    const { path } = fixture();
    const release = new SessionLockOwner().acquire(path);
    const contender = child(path);
    try {
      expect(await firstLine(contender)).toContain("Session is locked");
      expect(await contender.exited).toBe(2);
    } finally { contender.kill(); release(); }
  });

  test("normal cross-process release permits the next owner", async () => {
    const { path } = fixture();
    const holder = child(path);
    try {
      expect(await firstLine(holder)).toBe("owned");
      expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
      holder.stdin.write("release\n");
      holder.stdin.end();
      expect(await holder.exited).toBe(0);
      new SessionLockOwner().acquire(path)();
    } finally { holder.kill(); }
  });

  test("a killed owner is recovered without an age timeout", async () => {
    const { path } = fixture();
    const holder = child(path);
    try {
      expect(await firstLine(holder)).toBe("owned");
      holder.kill("SIGKILL");
      await holder.exited;
      const release = new SessionLockOwner().acquire(path);
      expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
      release();
    } finally { holder.kill(); }
  });

  test("simultaneous stale recovery admits exactly one process", async () => {
    const { path } = fixture();
    const holder = child(path);
    expect(await firstLine(holder)).toBe("owned");
    holder.kill("SIGKILL");
    await holder.exited;
    const contenders = Array.from({ length: 6 }, () => child(path));
    try {
      const outcomes = await Promise.all(contenders.map(firstLine));
      expect(outcomes.filter((outcome) => outcome === "owned")).toHaveLength(1);
      for (const [index, contender] of contenders.entries()) {
        if (outcomes[index] === "owned") {
          contender.stdin.write("release\n");
          contender.stdin.end();
        }
      }
      await Promise.all(contenders.map((contender) => contender.exited));
      new SessionLockOwner().acquire(path)();
    } finally { for (const contender of contenders) contender.kill(); }
  });

  test("unknown and corrupt owners fail closed", () => {
    const { path } = fixture();
    mkdirSync(`${path}.pum-lock`);
    writeFileSync(join(`${path}.pum-lock`, "owner-abcdef.json"), "not json");
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    expect(readFileSync(join(`${path}.pum-lock`, "owner-abcdef.json"), "utf8")).toBe("not json");
  });

  test("foreign hosts and PID namespaces are never reclaimed", () => {
    const { path } = fixture();
    const directory = `${path}.pum-lock`;
    mkdirSync(directory);
    const ownerPath = join(directory, "owner-abcdef.json");
    writeFileSync(ownerPath, JSON.stringify({ pid: 2147483647, host: "a-different-host", namespace: null }));
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    writeFileSync(ownerPath, JSON.stringify({ pid: 2147483647, host: hostname(), namespace: "foreign-namespace" }));
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
  });

  test("disposal releases ownership even if the underlying dispose throws", () => {
    const { path } = fixture();
    const session = { dispose() { throw new Error("dispose failed"); } };
    releaseSessionLockOnDispose(session, new SessionLockOwner().acquire(path));
    expect(() => session.dispose()).toThrow("dispose failed");
    new SessionLockOwner().acquire(path)();
  });
});

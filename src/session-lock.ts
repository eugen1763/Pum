import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { canonicalRealpathSync, pathIdentity } from "./platform";

export class SessionLockedError extends Error {
  constructor(path: string, detail = "another PUM instance") {
    super(`Session is locked by ${detail}: ${path}. Close the other session before resuming it.`);
    this.name = "SessionLockedError";
  }
}

/** Resolve the directory too: a new session's JSONL might not exist yet. */
export function canonicalSessionPath(path: string): string {
  const absolute = resolve(path);
  try { return pathIdentity(canonicalRealpathSync(absolute)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return pathIdentity(join(canonicalRealpathSync(dirname(absolute)), basename(absolute)));
  }
}

function pidNamespace(): string | null {
  if (process.platform !== "linux") return null;
  try { return readlinkSync("/proc/self/ns/pid"); } catch { return "unknown"; }
}

const releases = new Set<() => void>();
process.once("exit", () => { for (const release of releases) { try { release(); } catch {} } });

function removeOwner(directory: string, name: string): void {
  // Never remove recursively. A competing recovery can publish a new owner
  // between these operations. Its unique file makes rmdir fail safely.
  try { unlinkSync(join(directory, name)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try { rmdirSync(directory); } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function recoverDeadOwner(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const names = readdirSync(directory);
    // Empty directories only occur while a released/dead owner is removed.
    if (!names.length) {
      try { rmdirSync(directory); } catch {}
      return true;
    }
    if (names.length !== 1 || !/^owner-[0-9a-f-]+\.json$/.test(names[0]!)) return false;
    const ownerPath = join(directory, names[0]!);
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) return false;
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (owner.host !== hostname() || owner.namespace !== pidNamespace()
      || owner.namespace === "unknown" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) {
      // EPERM, an unknown host, and reused live PIDs all fail closed.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    removeOwner(directory, names[0]!);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function claim(path: string): () => void {
  const directory = `${path}.pum-lock`;
  const token = randomUUID();
  const name = `owner-${token}.json`;
  const candidate = `${directory}.${token}.tmp`;
  // Publish a fully populated directory with one atomic rename. Never publish
  // an empty lock: stale recovery must not race owner-file initialization.
  mkdirSync(candidate, { mode: 0o700 });
  let published = false;
  try {
    writeFileSync(join(candidate, name), JSON.stringify({ pid: process.pid, host: hostname(), namespace: pidNamespace() }), { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 8; attempt++) {
      try { renameSync(candidate, directory); published = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        if (!recoverDeadOwner(directory)) throw new SessionLockedError(path);
      }
    }
    if (!published) throw new SessionLockedError(path, "a competing session owner");
  } finally {
    if (!published) removeOwner(candidate, name);
  }
  let released = false;
  const release = () => {
    if (released) return;
    removeOwner(directory, name);
    released = true;
    releases.delete(release);
  };
  releases.add(release);
  return release;
}

/** One logical runtime owner. Separate owners conflict even in one process.
 * Reservations let a relocation reopen the same canonical file without gaps.
 */
export class SessionLockOwner {
  private held = new Map<string, { count: number; release: () => void }>();

  acquire(path: string | undefined): () => void {
    if (!path) return () => {};
    const key = canonicalSessionPath(path);
    let entry = this.held.get(key);
    if (!entry) {
      entry = { count: 0, release: claim(key) };
      this.held.set(key, entry);
    }
    entry.count++;
    let released = false;
    return () => {
      if (released) return;
      if (entry!.count === 1) {
        entry!.release();
        this.held.delete(key);
      }
      entry!.count--;
      released = true;
    };
  }
}

/** Bind ownership to the actual mutable session, not its visible transcript. */
export function releaseSessionLockOnDispose(session: { dispose(): void }, release: () => void): void {
  const dispose = session.dispose.bind(session);
  session.dispose = () => { try { dispose(); } finally { release(); } };
}

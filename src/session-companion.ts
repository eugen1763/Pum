import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Companion files: the small JSON files PUM keeps beside a session's JSONL.
 *
 * A goal, a todo list, the enabled tool groups, session settings, news, stats
 * and a relocation all live this way — same path shape, same defensive read,
 * same atomic write. They were seven copies of these three rules, which is how
 * one of them ended up writing through a temp name two processes could collide
 * on while the other six had already fixed that.
 */

/** `<session dir>/<session name>.<suffix>` */
export function companionFileFor(sessionFile: string, suffix: string): string {
  const base = basename(sessionFile).replace(/\.jsonl?$/, "");
  return join(dirname(sessionFile), `${base}.${suffix}`);
}

/**
 * Read a companion file, or the fallback.
 *
 * Never throws. A missing file, unreadable bytes, invalid JSON and a value the
 * caller rejects are all the same answer: there is no state here. Companion
 * state is a convenience, and losing it must never stop a session opening.
 */
export function readCompanion<T>(
  sessionFile: string | undefined,
  suffix: string,
  accept: (value: unknown) => value is T,
  fallback: T,
): T {
  if (!sessionFile) return fallback;
  try {
    const file = companionFileFor(sessionFile, suffix);
    if (!existsSync(file)) return fallback;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return accept(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Replace a companion file atomically, or remove it when there is no value.
 *
 * Throws on failure, so a caller in the middle of a transaction can react. The
 * temp name carries the pid and the clock, so two PUM processes on one session
 * cannot interleave a write and a rename and lose an update, and a half-written
 * temp file is removed rather than left beside the session.
 */
export function writeCompanionOrThrow(
  sessionFile: string,
  suffix: string,
  value: unknown | null,
): void {
  const file = companionFileFor(sessionFile, suffix);
  if (value === null) {
    rmSync(file, { force: true });
    return;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The same write, best effort.
 *
 * Companion state is a convenience: a session that cannot write its goal still
 * runs, so nothing here is worth a crash.
 */
export function writeCompanion(
  sessionFile: string | undefined,
  suffix: string,
  value: unknown | null,
): void {
  if (!sessionFile) return;
  try {
    writeCompanionOrThrow(sessionFile, suffix, value);
  } catch {
    // Reported nowhere on purpose: the session matters, the companion does not.
  }
}

/** True when a companion file is already on disk. */
export function companionExists(sessionFile: string, suffix: string): boolean {
  return existsSync(companionFileFor(sessionFile, suffix));
}

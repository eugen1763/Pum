import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SessionStatsSnapshot } from "./session-stats";

export type HeadlessStatsEnvelope = {
  schemaVersion: 1;
  pumVersion: string;
  run: {
    prompt: string;
    cwd: string;
    resume: boolean;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    exitCode: number;
  };
  stats: SessionStatsSnapshot;
};

export type HeadlessStatsOutput = {
  path: string;
  write(envelope: HeadlessStatsEnvelope): void;
};

/**
 * Why the reservation could not claim the path.
 *
 * A zero-byte file is almost always the reservation of a run that died before
 * it wrote, so name that case and say how to clear it. The reservation itself
 * stays strict: reclaiming an empty file automatically would let two runs
 * started at the same moment both claim the same output.
 */
export function statsFileExistsMessage(path: string): string {
  let empty = false;
  try {
    empty = statSync(path).size === 0;
  } catch {
    // Unreadable or already gone: report the plain case.
  }
  return empty
    ? `stats file already exists and is empty: ${path}. An earlier run reserved it and did not finish. Delete the file or pass --override.`
    : `stats file already exists: ${path}. Use --override to replace it.`;
}

/**
 * Validate and reserve the benchmark output before the agent starts.
 * Reservation makes the default no-overwrite behavior race-safe.
 */
export function prepareHeadlessStatsOutput(path: string, override: boolean): HeadlessStatsOutput {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  if (!override) {
    try {
      closeSync(openSync(outputPath, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw Object.assign(new Error(statsFileExistsMessage(outputPath)), { code: "EEXIST" });
    }
  }

  return {
    path: outputPath,
    write(envelope) {
      const temp = resolve(
        dirname(outputPath),
        `.${basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      try {
        writeFileSync(temp, `${JSON.stringify(envelope, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        renameSync(temp, outputPath);
      } catch (error) {
        try {
          rmSync(temp, { force: true });
        } catch {
          // Preserve the original write error.
        }
        throw error;
      }
    },
  };
}

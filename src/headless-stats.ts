import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * Validate and reserve the benchmark output before the agent starts.
 * Reservation makes the default no-overwrite behavior race-safe.
 */
export function prepareHeadlessStatsOutput(path: string, override: boolean): HeadlessStatsOutput {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  if (!override) closeSync(openSync(outputPath, "wx", 0o600));

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

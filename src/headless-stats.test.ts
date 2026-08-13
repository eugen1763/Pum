import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHeadlessStatsOutput, type HeadlessStatsEnvelope } from "./headless-stats";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function envelope(exitCode = 0): HeadlessStatsEnvelope {
  return {
    schemaVersion: 1,
    pumVersion: "1.2.3",
    run: {
      prompt: "benchmark task",
      cwd: "C:\\project",
      resume: false,
      startedAt: "2026-08-13T10:00:00.000Z",
      finishedAt: "2026-08-13T10:00:01.000Z",
      durationMs: 1000,
      exitCode,
    },
    stats: {
      models: [],
      tools: [],
      outcomes: { successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 0 },
    },
  };
}

describe("headless statistics output", () => {
  test("creates parents, reserves a new path, and writes the envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "pum-headless-stats-"));
    roots.push(root);
    const path = join(root, "nested", "stats.json");

    const output = prepareHeadlessStatsOutput(path, false);
    expect(existsSync(path)).toBe(true);
    output.write(envelope());

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(envelope());
  });

  test("rejects an existing path unless override is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "pum-headless-stats-"));
    roots.push(root);
    const path = join(root, "stats.json");
    writeFileSync(path, "original");

    expect(() => prepareHeadlessStatsOutput(path, false)).toThrow();
    const output = prepareHeadlessStatsOutput(path, true);
    output.write(envelope(1));
    expect(JSON.parse(readFileSync(path, "utf8")).run.exitCode).toBe(1);
  });
});

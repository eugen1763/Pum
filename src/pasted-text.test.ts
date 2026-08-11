import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPendingPastedTexts,
  MAX_PASTED_TEXT_BYTES,
  pastedTextReadBlock,
  removePendingPastedText,
  stagePastedText,
} from "./pasted-text";

afterEach(() => cleanupPendingPastedTexts());

function pastedTextDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("pum-pasted-text-"));
}

describe("stagePastedText", () => {
  test("writes the text to a private temp file under the system temp dir", () => {
    const dirsBefore = pastedTextDirs();
    const text = "x".repeat(17 * 1024);
    const staged = stagePastedText(text);

    expect(staged.bytes).toBe(text.length);
    expect(staged.path).toContain("pum-pasted-text-");
    expect(staged.path.endsWith(".txt")).toBe(true);
    expect(existsSync(staged.path)).toBe(true);
    expect(readFileSync(staged.path, "utf8")).toBe(text);

    const dirsAfter = pastedTextDirs();
    expect(dirsAfter.length).toBe(dirsBefore.length + 1);
  });
});

describe("removePendingPastedText", () => {
  test("deletes only the staged temp file", () => {
    const first = stagePastedText("a".repeat(20_000));
    const second = stagePastedText("b".repeat(20_000));
    const item: Parameters<typeof removePendingPastedText>[0] = {
      id: 1,
      marker: "[Pasted text #1]",
      path: first.path,
      bytes: first.bytes,
      start: 0,
      end: "[Pasted text #1]".length,
    };

    removePendingPastedText(item);

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);
  });

  test("tolerates a file that is already gone", () => {
    const staged = stagePastedText("c".repeat(20_000));
    rmSync(join(tmpdir(), staged.path.split(/[\\/]/).slice(-2).join("/")), { force: true });
    removePendingPastedText({
      id: 1,
      marker: "[Pasted text #1]",
      path: staged.path,
      bytes: staged.bytes,
      start: 0,
      end: 1,
    });
  });
});

describe("cleanupPendingPastedTexts", () => {
  test("removes the whole dedicated temp directory", () => {
    stagePastedText("d".repeat(20_000));
    expect(pastedTextDirs().length).toBeGreaterThan(0);

    cleanupPendingPastedTexts();

    expect(pastedTextDirs().length).toBe(0);
  });
});

describe("pastedTextReadBlock", () => {
  test("keeps the marker and puts the absolute path on its own line", () => {
    const block = pastedTextReadBlock({
      id: 3,
      marker: "[Pasted text #3]",
      path: "/tmp/pum-pasted-text-abc/pasted-1.txt",
      bytes: 32 * 1024,
      start: 0,
      end: 0,
    });

    expect(block).toContain("[Pasted text #3]");
    expect(block).toContain("/tmp/pum-pasted-text-abc/pasted-1.txt");
    expect(block).toContain("read tool");
    const lines = block.split("\n");
    expect(lines.at(-1)).toBe("/tmp/pum-pasted-text-abc/pasted-1.txt");
  });
});

describe("threshold", () => {
  test("is exactly 16 KiB", () => {
    expect(MAX_PASTED_TEXT_BYTES).toBe(16 * 1024);
  });
});

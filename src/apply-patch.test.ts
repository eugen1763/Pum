import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  applyPatchExtension,
  normalizePatchPath,
  parseApplyPatch,
  type ApplyPatchFileSystem,
} from "./apply-patch";

const directories: string[] = [];

function project(): string {
  const path = mkdtempSync(join(tmpdir(), "pum-apply-patch-"));
  directories.push(path);
  return path;
}

function text(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Codex apply_patch parser", () => {
  test("parses add, update, delete, move, and multiple hunks", () => {
    const operations = parseApplyPatch(`*** Begin Patch
*** Add File: added.txt
+added
*** Update File: old.txt
*** Move to: moved.txt
@@ first
-old
+new
@@ second
-before
+after
*** Delete File: gone.txt
*** End Patch`);

    expect(operations).toEqual([
      { type: "add", path: "added.txt", lines: ["added"] },
      {
        type: "update",
        path: "old.txt",
        moveTo: "moved.txt",
        hunks: [
          { header: "first", oldLines: ["old"], newLines: ["new"], endOfFile: false, line: 6 },
          { header: "second", oldLines: ["before"], newLines: ["after"], endOfFile: false, line: 9 },
        ],
      },
      { type: "delete", path: "gone.txt" },
    ]);
  });

  test("rejects malformed envelopes and malformed operation bodies", () => {
    const invalid = [
      "*** Add File: a.txt\n+x\n*** End Patch",
      "*** Begin Patch\n*** Add File: a.txt\n+x",
      "*** Begin Patch\n*** End Patch",
      "*** Begin Patch\n*** Add File: a.txt\nx\n*** End Patch",
      "*** Begin Patch\n*** Update File: a.txt\n-old\n+new\n*** End Patch",
      "*** Begin Patch\n*** Delete Thing: a.txt\n*** End Patch",
    ];
    for (const patch of invalid) expect(() => parseApplyPatch(patch)).toThrow("Invalid patch");
  });

  test("normalizes Windows separators and rejects absolute or traversal paths", () => {
    expect(normalizePatchPath("src\\nested\\file.ts")).toBe("src/nested/file.ts");
    for (const path of ["../outside", "src/../../outside", "/tmp/file", "C:\\temp\\file", "\\\\server\\share\\file"]) {
      expect(() => normalizePatchPath(path)).toThrow("Invalid patch");
    }
  });
});

describe("apply_patch mutations", () => {
  test("applies add, update, delete, and move operations", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "update.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(cwd, "move.txt"), "head\nold\ntail\n");
    writeFileSync(join(cwd, "delete.txt"), "remove me\n");

    const result = await applyPatch(cwd, `*** Begin Patch
*** Add File: nested/added.txt
+hello
+world
*** Update File: update.txt
@@
 one
-two
+TWO
 three
*** Update File: move.txt
*** Move to: moved.txt
@@ head
-old
+new
*** Delete File: delete.txt
*** End Patch`);

    expect(text(join(cwd, "nested", "added.txt"))).toBe("hello\nworld\n");
    expect(text(join(cwd, "update.txt"))).toBe("one\nTWO\nthree\n");
    expect(existsSync(join(cwd, "move.txt"))).toBe(false);
    expect(text(join(cwd, "moved.txt"))).toBe("head\nnew\ntail\n");
    expect(existsSync(join(cwd, "delete.txt"))).toBe(false);
    expect(result.details.files).toEqual(["nested/added.txt", "update.txt", "moved.txt", "delete.txt"]);
    expect(result.details.patch).toContain("+++ update.txt");
  });

  test("applies multiple hunks against one original file", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "file.txt"), "first\na\nmiddle\nb\nlast\n");

    await applyPatch(cwd, `*** Begin Patch
*** Update File: file.txt
@@ first
-a
+A
@@ middle
-b
+B
*** End Patch`);

    expect(text(join(cwd, "file.txt"))).toBe("first\nA\nmiddle\nB\nlast\n");
  });

  test("fails on missing and ambiguous context without writing", async () => {
    const cwd = project();
    const path = join(cwd, "file.txt");
    writeFileSync(path, "same\nsame\nend\n");

    await expect(applyPatch(cwd, `*** Begin Patch
*** Update File: file.txt
@@
-same
+changed
*** End Patch`)).rejects.toThrow("Ambiguous expected hunk lines");
    expect(text(path)).toBe("same\nsame\nend\n");

    await expect(applyPatch(cwd, `*** Begin Patch
*** Update File: file.txt
@@
-missing
+changed
*** End Patch`)).rejects.toThrow("Failed to find expected hunk lines");
    expect(text(path)).toBe("same\nsame\nend\n");
  });

  test("validates every file before any mutation", async () => {
    const cwd = project();
    const first = join(cwd, "first.txt");
    writeFileSync(first, "old\n");

    await expect(applyPatch(cwd, `*** Begin Patch
*** Update File: first.txt
@@
-old
+new
*** Update File: missing.txt
@@
-old
+new
*** End Patch`)).rejects.toThrow("Patch source does not exist");
    expect(text(first)).toBe("old\n");
  });

  test("rejects traversal and symlinks that escape the project", async () => {
    const cwd = project();
    const outside = project();
    writeFileSync(join(outside, "outside.txt"), "safe\n");
    await Bun.$`ln -s ${outside} ${join(cwd, "link")}`;

    await expect(applyPatch(cwd, `*** Begin Patch
*** Add File: ../outside.txt
+bad
*** End Patch`)).rejects.toThrow("parent traversal");
    await expect(applyPatch(cwd, `*** Begin Patch
*** Update File: link/outside.txt
@@
-safe
+bad
*** End Patch`)).rejects.toThrow("resolves outside the project");
    expect(text(join(outside, "outside.txt"))).toBe("safe\n");
  });

  test("rolls back all files when the commit phase fails", async () => {
    const cwd = project();
    const first = join(cwd, "first.txt");
    const second = join(cwd, "second.txt");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");

    const base = await import("node:fs/promises");
    let renameCalls = 0;
    const fs: ApplyPatchFileSystem = {
      ...base,
      rename: async (from, to) => {
        renameCalls++;
        if (renameCalls === 3) throw new Error("injected commit failure");
        await base.rename(from, to);
      },
    };

    await expect(applyPatch(cwd, `*** Begin Patch
*** Update File: first.txt
@@
-one
+ONE
*** Update File: second.txt
@@
-two
+TWO
*** End Patch`, { fs })).rejects.toThrow("Could not apply patch atomically");
    expect(text(first)).toBe("one\n");
    expect(text(second)).toBe("two\n");
    expect(readdirSync(cwd).filter((name) => name.startsWith(".pum-apply-patch-"))).toEqual([]);
  });

  test("preserves CRLF and supports Windows patch paths", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "src"));
    const path = join(cwd, "src", "file.txt");
    writeFileSync(path, "one\r\ntwo\r\n");

    await applyPatch(cwd, `*** Begin Patch\r
*** Update File: src\\file.txt\r
@@\r
 one\r
-two\r
+TWO\r
*** End Patch\r
`);

    expect(readFileSync(path)).toEqual(Buffer.from("one\r\nTWO\r\n"));
  });

  test("registers a model-callable pi tool", async () => {
    const cwd = project();
    const tools = new Map<string, any>();
    (applyPatchExtension as { factory: (pi: any) => void }).factory({
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });

    const tool = tools.get("apply_patch");
    expect(tool).toBeDefined();
    expect(tool.promptSnippet).toContain("atomic");
    await tool.execute("call-1", {
      patch: "*** Begin Patch\n*** Add File: registered.txt\n+yes\n*** End Patch",
    }, undefined, undefined, { cwd });
    expect(text(join(cwd, "registered.txt"))).toBe("yes\n");
  });
});

import { describe, expect, test } from "bun:test";
import {
  clipDiffPreview,
  diffPreview,
  inlineDiffLines,
  previewLanguage,
  previewWindow,
  toolPreviewFromResult,
  toolPreviewFromStart,
} from "../src/tool-preview";

describe("detailed tool result previews", () => {
  test("keeps the final five Bash logical lines and reports omissions", () => {
    expect(toolPreviewFromResult("bash", {
      content: [{ type: "text", text: "one\r\ntwo\nthree\rfour\nfive\nsix\n" }],
    })).toEqual({
      kind: "bash",
      window: { hidden: 1, lines: ["two", "three", "four", "five", "six"] },
    });
  });

  test("renders a written file as a diff of nothing but additions", () => {
    const content = Array.from({ length: 3 }, (_, index) => `line ${index + 1}`).join("\n");
    const preview = toolPreviewFromStart("write", { path: "src/file.ts", content });

    expect(preview).toEqual({
      kind: "diff",
      lines: [
        { kind: "add", text: "+line 1", source: "line 1", language: "typescript" },
        { kind: "add", text: "+line 2", source: "line 2", language: "typescript" },
        { kind: "add", text: "+line 3", source: "line 3", language: "typescript" },
      ],
    });
    expect(toolPreviewFromResult("write", {}, preview)).toBe(preview);
  });

  test("a written file with no known language still renders as additions", () => {
    expect(toolPreviewFromStart("write", { path: "notes.rst", content: "hello\n" })).toEqual({
      kind: "diff",
      lines: [{ kind: "add", text: "+hello", source: "hello" }],
    });
  });

  test("preserves complete multi-file patches and tracks source languages", () => {
    const patch = [
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      " context();",
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const preview = diffPreview(patch);
    expect(preview.kind).toBe("diff");
    if (preview.kind !== "diff") throw new Error("expected diff preview");
    expect(preview.lines).toHaveLength(13);
    expect(preview.lines[4]).toEqual({
      kind: "remove",
      text: "-const oldValue = 1;",
      source: "const oldValue = 1;",
      language: "typescript",
    });
    expect(preview.lines[12]?.language).toBe("markdown");
    expect(toolPreviewFromResult("edit", { details: { patch } })).toEqual(preview);
  });

  test("uses only parsers PUM can load and handles empty windows", () => {
    expect(previewLanguage("file.tsx")).toBe("typescript");
    expect(previewLanguage("file.py")).toBe("python");
    // No grammar is vendored for these, so their diffs render as plain text.
    expect(previewLanguage("file.rb")).toBeUndefined();
    expect(previewLanguage("file.java")).toBeUndefined();
    expect(previewWindow("", 5, "end")).toEqual({ lines: [], hidden: 0 });
  });

  test("clips a long diff to a budget of changed lines, keeping their context", () => {
    const lines = diffPreview([
      "@@ -1,4 +1,4 @@",
      " context",
      "-old one",
      "+new one",
      " between",
      "-old two",
      "+new two",
      " tail",
    ].join("\n"));
    if (lines.kind !== "diff") throw new Error("Expected a diff preview");

    // Everything up to the change that broke the budget stays, trailing
    // context included, so the last hunk shown is not cut off mid-air.
    const tight = clipDiffPreview(lines.lines, 2);
    expect(tight.lines.map((line) => line.text)).toEqual([
      "@@ -1,4 +1,4 @@",
      " context",
      "-old one",
      "+new one",
      " between",
    ]);
    expect(tight.hidden).toBe(3);

    // Context never eats the budget, so a wide diff still shows two changes.
    expect(clipDiffPreview(lines.lines, 4).hidden).toBe(0);
    expect(clipDiffPreview(lines.lines, 99).lines).toHaveLength(lines.lines.length);
    expect(clipDiffPreview(lines.lines, 0)).toEqual({ lines: [], hidden: lines.lines.length });
  });
});

describe("inline diff trimming", () => {
  const codex = [
    "*** Begin Patch",
    "*** Update File: src/one.ts",
    "@@",
    "-const a = 1;",
    "+const a = 2;",
    "*** End Patch",
  ].join("\n");

  test("drops patch ceremony from a single-file diff", () => {
    const preview = diffPreview(codex);
    if (preview.kind !== "diff") throw new Error("Expected a diff preview");

    expect(inlineDiffLines(preview.lines).map((line) => line.text)).toEqual([
      "-const a = 1;",
      "+const a = 2;",
    ]);
  });

  test("keeps one heading per file when a patch touches several", () => {
    const preview = diffPreview([
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/src/two.ts b/src/two.ts",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
    ].join("\n"));
    if (preview.kind !== "diff") throw new Error("Expected a diff preview");

    expect(inlineDiffLines(preview.lines).map((line) => line.text)).toEqual([
      "src/one.ts",
      "-const a = 1;",
      "+const a = 2;",
      "src/two.ts",
      "-const b = 1;",
      "+const b = 2;",
    ]);
  });

  test("leaves the added and removed lines exactly as they were", () => {
    const preview = diffPreview(codex);
    if (preview.kind !== "diff") throw new Error("Expected a diff preview");
    const trimmed = inlineDiffLines(preview.lines);

    expect(trimmed.map((line) => line.kind)).toEqual(["remove", "add"]);
    expect(trimmed.map((line) => line.source)).toEqual(["const a = 1;", "const a = 2;"]);
    expect(trimmed.every((line) => line.language === "typescript")).toBe(true);
  });
});

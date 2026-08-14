import { describe, expect, test } from "bun:test";
import {
  diffPreview,
  previewLanguage,
  previewWindow,
  toolPreviewFromResult,
  toolPreviewFromStart,
} from "./tool-preview";

describe("detailed tool result previews", () => {
  test("keeps the final five Bash logical lines and reports omissions", () => {
    expect(toolPreviewFromResult("bash", {
      content: [{ type: "text", text: "one\r\ntwo\nthree\rfour\nfive\nsix\n" }],
    })).toEqual({
      kind: "bash",
      window: { hidden: 1, lines: ["two", "three", "four", "five", "six"] },
    });
  });

  test("keeps the first thirty written lines and reports omissions", () => {
    const content = Array.from({ length: 32 }, (_, index) => `line ${index + 1}`).join("\n");
    const preview = toolPreviewFromStart("write", { path: "src/file.ts", content });
    expect(preview).toEqual({
      kind: "write",
      path: "src/file.ts",
      language: "typescript",
      window: {
        hidden: 2,
        lines: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`),
      },
    });
    expect(toolPreviewFromResult("write", {}, preview)).toBe(preview);
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
  });

  test("uses only parsers bundled by OpenTUI and handles empty windows", () => {
    expect(previewLanguage("file.tsx")).toBe("typescript");
    expect(previewLanguage("file.py")).toBeUndefined();
    expect(previewWindow("", 5, "end")).toEqual({ lines: [], hidden: 0 });
  });
});

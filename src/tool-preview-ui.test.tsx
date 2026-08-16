import { afterEach, describe, expect, test } from "bun:test";
import { CodeRenderable, parseColor, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { buildSyntaxStyle } from "./syntax";
import { ToolLine } from "./transcript";
import { loadTheme } from "./theme";
import { diffPreview, toolPreviewFromStart } from "./tool-preview";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function descendants<T extends BaseRenderable>(
  root: BaseRenderable,
  type: abstract new (...args: any[]) => T,
): T[] {
  const found: T[] = [];
  const visit = (node: BaseRenderable) => {
    if (node instanceof type) found.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.renderOnce();
  await setup.flush();
  await Promise.all(descendants(setup.renderer.root, CodeRenderable).map((code) => code.highlightingDone));
  await setup.flush();
}

describe("detailed tool previews", () => {
  test("shows the final five lines for failed Bash only in detailed mode", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const preview = {
      kind: "bash" as const,
      window: { hidden: 2, lines: ["three", "four", "five", "six", "seven"] },
    };
    const root = createRoot(setup.renderer);

    root.render(
      <ToolLine
        theme={theme}
        call={{ id: "bash", name: "bash", arg: "fail", state: "error", exitCode: 1, preview }}
      />,
    );
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("seven");

    root.render(
      <ToolLine
        theme={theme}
        outputMode="verbose"
        call={{ id: "bash", name: "bash", arg: "fail", state: "error", exitCode: 1, preview }}
      />,
    );
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("... 2 more lines");
    expect(frame).toContain("three");
    expect(frame).toContain("seven");
  });

  test("renders the first thirty write lines with bundled source highlighting", async () => {
    const setup = await createTestRenderer({ width: 70, height: 40 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const content = Array.from({ length: 32 }, (_, index) => `const value${index + 1} = ${index + 1};`).join("\n");
    const preview = toolPreviewFromStart("write", { path: "src/generated.ts", content })!;

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        syntaxStyle={syntaxStyle}
        outputMode="verbose"
        call={{ id: "write", name: "write", arg: "src/generated.ts", state: "ok", preview }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("const value1 = 1;");
    expect(frame).toContain("const value30 = 30;");
    expect(frame).not.toContain("value31");
    expect(frame).toContain("... 2 more lines");
    expect(descendants(setup.renderer.root, CodeRenderable)).toHaveLength(1);
  });

  test("renders complete multi-file diffs with semantic markers and source fallback", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const preview = diffPreview([
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1 +1 @@",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      "diff --git a/data/example.txt b/data/example.txt",
      "--- a/data/example.txt",
      "+++ b/data/example.txt",
      "@@ -1 +1 @@",
      "-old text",
      "+new text",
    ].join("\n"));

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        syntaxStyle={syntaxStyle}
        outputMode="verbose"
        call={{ id: "patch", name: "apply_patch", arg: "2 files", state: "ok", preview }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("const oldValue = 1;");
    expect(frame).toContain("const newValue = 2;");
    expect(frame).toContain("old text");
    expect(frame).toContain("new text");
    // The two TypeScript source rows use tree-sitter. The .txt rows use the
    // plain-text fallback and therefore do not create extra CodeRenderables.
    expect(descendants(setup.renderer.root, CodeRenderable)).toHaveLength(2);

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const additions = spans.filter((span) => span.text === "+");
    const removals = spans.filter((span) => span.text === "-");
    expect(additions.length).toBeGreaterThan(0);
    expect(removals.length).toBeGreaterThan(0);
    expect(additions.every((span) => span.fg.equals(parseColor(theme.success)))).toBe(true);
    expect(removals.every((span) => span.fg.equals(parseColor(theme.error)))).toBe(true);

    const captured = setup.captureSpans().lines;
    const addedRows = captured.filter((line) => line.spans.map((span) => span.text).join("").includes("newValue"));
    const removedRows = captured.filter((line) => line.spans.map((span) => span.text).join("").includes("oldValue"));
    expect(addedRows).toHaveLength(1);
    expect(removedRows).toHaveLength(1);
    // The two-column transcript gutter stays transparent. The diff marker,
    // syntax-highlighted source, and remaining visible row use the diff token.
    expect(addedRows[0]!.spans.slice(1).filter((span) => span.text).every(
      (span) => span.bg.equals(parseColor(theme.diffAddedBg)),
    )).toBe(true);
    expect(removedRows[0]!.spans.slice(1).filter((span) => span.text).every(
      (span) => span.bg.equals(parseColor(theme.diffRemovedBg)),
    )).toBe(true);
  });

  test("uses the highlighted diff instead of raw JSON for a regular expanded patch", async () => {
    const setup = await createTestRenderer({ width: 72, height: 16 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/value.ts",
      "@@",
      "-const value = 1;",
      "+const value = 2;",
      "*** End Patch",
    ].join("\n");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        syntaxStyle={buildSyntaxStyle(theme)}
        expanded
        outputMode="normal"
        call={{
          id: "regular-patch",
          name: "apply_patch",
          arg: "src/value.ts",
          state: "ok",
          input: { patch },
          result: { content: [{ type: "text", text: "Applied patch" }], details: { patch } },
          preview: diffPreview(patch),
        }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("const value = 1;");
    expect(frame).toContain("const value = 2;");
    expect(frame).not.toContain('\"patch\"');
    expect(descendants(setup.renderer.root, CodeRenderable)).toHaveLength(2);

    const captured = setup.captureSpans().lines;
    const added = captured.find((line) => line.spans.map((span) => span.text).join("").includes("value = 2"));
    const removed = captured.find((line) => line.spans.map((span) => span.text).join("").includes("value = 1"));
    expect(added?.spans.some((span) => span.bg.equals(parseColor(theme.diffAddedBg)))).toBe(true);
    expect(removed?.spans.some((span) => span.bg.equals(parseColor(theme.diffRemovedBg)))).toBe(true);
  });
});

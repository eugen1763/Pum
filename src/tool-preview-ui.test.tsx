import { afterEach, describe, expect, test } from "bun:test";
import { CodeRenderable, parseColor, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { buildSyntaxStyle } from "./syntax";
import { ToolLine } from "./transcript";
import { loadTheme } from "./theme";
import { diffPreview, toolPreviewFromStart } from "./tool-preview";
import type { ToolCall } from "./tool-line";

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
  test("shows the final five Bash lines when a failed row is opened", async () => {
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
        call={{ id: "bash", name: "bash", args: ["fail"], state: "error", exitCode: 1, preview }}
      />,
    );
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("seven");

    root.render(
      <ToolLine
        theme={theme}
        expanded
        call={{ id: "bash", name: "bash", args: ["fail"], state: "error", exitCode: 1, preview }}
      />,
    );
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("... 2 more lines");
    expect(frame).toContain("three");
    expect(frame).toContain("seven");
  });

  test("shows a written file inline as additions, capped until it is expanded", async () => {
    const setup = await createTestRenderer({ width: 70, height: 60 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const content = Array.from({ length: 32 }, (_, index) => `const value${index + 1} = ${index + 1};`).join("\n");
    const preview = toolPreviewFromStart("write", { path: "src/generated.ts", content })!;
    const call: ToolCall = {
      id: "write", name: "write", args: ["src/generated.ts"], state: "ok", preview,
    };

    createRoot(setup.renderer).render(
      <ToolLine theme={theme} syntaxStyle={syntaxStyle} call={call} />,
    );
    await settle(setup);

    // Normal shows the change without being asked, but only the first twenty
    // added lines of it.
    const capped = setup.captureCharFrame();
    expect(capped).toContain("+const value1 = 1;");
    expect(capped).toContain("+const value20 = 20;");
    expect(capped).not.toContain("value21");
    expect(capped).toContain("... 12 more lines");

    createRoot(setup.renderer).render(
      <ToolLine theme={theme} syntaxStyle={syntaxStyle} call={call} expanded />,
    );
    await settle(setup);

    const whole = setup.captureCharFrame();
    expect(whole).toContain("+const value32 = 32;");
    expect(whole).not.toContain("more lines");
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
        call={{ id: "patch", name: "apply_patch", args: ["2 files"], state: "ok", preview }}
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

  test("Verbose shows the raw data and renders no diff at all", async () => {
    const setup = await createTestRenderer({ width: 72, height: 20 });
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
        outputMode="verbose"
        call={{
          id: "verbose-patch",
          name: "apply_patch",
          args: ["src/value.ts"],
          state: "ok",
          input: { patch },
          result: { content: [{ type: "text", text: "Applied patch" }], details: { patch } },
          preview: diffPreview(patch),
        }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("input:");
    expect(frame).toContain('\"patch\"');
    // Verbose is the debugging view: no rendered diff, so no diff backgrounds.
    expect(setup.captureSpans().lines.some((line) =>
      line.spans.some((span) => span.bg.equals(parseColor(theme.diffAddedBg))))).toBe(false);
  });

  test("an expanded patch shows its highlighted diff above the raw data", async () => {
    // Tall enough for the diff and the retained input and result beneath it.
    const setup = await createTestRenderer({ width: 72, height: 30 });
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
          args: ["src/value.ts"],
          state: "ok",
          input: { patch },
          result: { content: [{ type: "text", text: "Applied patch" }], details: { patch } },
          preview: diffPreview(patch),
        }}
      />,
    );
    await settle(setup);

    // Expanding keeps the diff and adds the complete retained input and result
    // beneath it, so nothing you were reading disappears when you open a row.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("const value = 1;");
    expect(frame).toContain("const value = 2;");
    expect(frame).toContain('\"patch\"');
    expect(descendants(setup.renderer.root, CodeRenderable)).toHaveLength(2);

    const captured = setup.captureSpans().lines;
    const added = captured.find((line) => line.spans.map((span) => span.text).join("").includes("value = 2"));
    const removed = captured.find((line) => line.spans.map((span) => span.text).join("").includes("value = 1"));
    expect(added?.spans.some((span) => span.bg.equals(parseColor(theme.diffAddedBg)))).toBe(true);
    expect(removed?.spans.some((span) => span.bg.equals(parseColor(theme.diffRemovedBg)))).toBe(true);
  });

  test("expanding a read shows its complete retained input and result", async () => {
    const setup = await createTestRenderer({ width: 72, height: 18 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        syntaxStyle={buildSyntaxStyle(theme)}
        expanded
        outputMode="normal"
        call={{
          id: "regular-read",
          name: "read",
          args: ["src/value.ts", "offset=2", "limit=8"],
          state: "ok",
          input: { path: "src/value.ts", offset: 2, limit: 8 },
          result: {
            content: [{ type: "text", text: "const value = 2;\nexport { value };" }],
            details: { lines: 2 },
          },
        }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("read(src/value.ts, offset=2, limit=8)");
    expect(frame).toContain("input:");
    expect(frame).toContain('\"path\": \"src/value.ts\"');
    expect(frame).toContain("result:");
    expect(frame).toContain("const value = 2;");
  });

  test("expanding any other tool shows its complete retained input and result", async () => {
    const setup = await createTestRenderer({ width: 72, height: 18 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        expanded
        outputMode="normal"
        call={{
          id: "regular-worktree",
          name: "worktree",
          args: ["merge", "worker"],
          state: "ok",
          input: { action: "merge", target: "worker" },
          result: {
            content: [{ type: "text", text: "Merged worker into main." }],
            details: { commit: "abc123" },
          },
        }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("worktree(merge, worker)");
    expect(frame).toContain('\"action\": \"merge\"');
    expect(frame).toContain('\"target\": \"worker\"');
    expect(frame).toContain("Merged worker into main.");
  });
});

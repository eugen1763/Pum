import { afterEach, describe, expect, test } from "bun:test";
import { MarkdownRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { buildSyntaxStyle } from "../src/syntax";
import { PendingMessageLine } from "../src/transcript";
import { loadTheme } from "../src/theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function markdownRows(root: BaseRenderable): MarkdownRenderable[] {
  const rows: MarkdownRenderable[] = [];
  const visit = (node: BaseRenderable) => {
    if (node instanceof MarkdownRenderable) rows.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return rows;
}

describe("pending transcript messages", () => {
  test("renders queued steering at the transcript bottom style", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    createRoot(setup.renderer).render(
      <PendingMessageLine
        theme={theme}
        syntaxStyle={buildSyntaxStyle(theme)}
        pending={{
          id: "pending-1",
          deliveryText: "steer after tools",
          line: { kind: "text", role: "user", text: "steer after tools" },
        }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("○");
    expect(markdownRows(setup.renderer.root).map((row) => row.content)).toEqual(["steer after tools"]);
  });

  test("labels queued inter-agent messages", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    createRoot(setup.renderer).render(
      <PendingMessageLine
        theme={theme}
        syntaxStyle={buildSyntaxStyle(theme)}
        pending={{
          id: "pending-2",
          line: {
            kind: "agent-message",
            sender: "alpha",
            recipient: "beta",
            text: "review this change",
          },
        }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("alpha → beta · queued");
    expect(markdownRows(setup.renderer.root).map((row) => row.content)).toEqual(["review this change"]);
  });
});

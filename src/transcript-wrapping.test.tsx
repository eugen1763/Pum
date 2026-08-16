import { afterEach, describe, expect, test } from "bun:test";
import { destroyTreeSitterClient, MarkdownRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { buildSyntaxStyle, settleSyntaxHighlighting } from "./syntax";
import { loadTheme } from "./theme";
import {
  AgentMessageLine,
  PendingMessageLine,
  TextLine,
  ToolLine,
} from "./transcript";

let destroy: (() => void | Promise<void>) | undefined;
afterEach(async () => { await destroy?.(); });

const long = "alpha beta gamma delta epsilon zeta eta theta omega END";
const markdownLong = "alpha beta gamma delta epsilon zeta eta theta omega TAIL";

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

describe("transcript wrapping", () => {
  test("wraps every transcript column within a narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 28, height: 48 });
    const root = createRoot(setup.renderer);
    destroy = async () => {
      await settleSyntaxHighlighting(setup.renderer.root);
      root.unmount();
      await setup.flush();
      await setup.renderer.idle();
      setup.renderer.destroy();
      await destroyTreeSitterClient();
    };
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    root.render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="assistant" text={markdownLong} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="thinking" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="system" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="error" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="user" text={markdownLong} />
        <AgentMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          line={{ kind: "agent-message", sender: "long-sender-name", recipient: "long-recipient-name", text: markdownLong }}
        />
        <PendingMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          pending={{ id: "queued", line: { kind: "agent-message", sender: "long-sender-name", recipient: "long-recipient-name", text: markdownLong } }}
        />
        <ToolLine
          theme={theme}
          call={{ id: "tool", name: "bash", args: [long], detail: "+100 −100", state: "ok" }}
        />
      </box>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await setup.renderOnce();
    await setup.flush();
    const frame = setup.captureCharFrame();

    const markdownRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(markdownRows).toHaveLength(4);
    expect(markdownRows.every((row) => row.content === markdownLong)).toBe(true);
    expect(markdownRows.every((row) => row.width === 26)).toBe(true);
    expect(markdownRows.every((row) => row.height > 1)).toBe(true);

    // Keep the frame marker independent from platform-specific Markdown painting.
    expect(frame.match(/END/g)?.length).toBe(4);
    expect(frame.split("\n").every((line) => line.length <= 28)).toBe(true);
    expect(frame).toContain("recipient-name");
    expect(frame).toContain("+100");
    expect(frame).toContain("−100");
    expect(frame).toContain("✓");
  });
});

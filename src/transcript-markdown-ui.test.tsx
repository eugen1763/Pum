import { afterEach, describe, expect, test } from "bun:test";
import {
  BoxRenderable,
  MarkdownRenderable,
  TextRenderable,
  parseColor,
  type BaseRenderable,
  type SyntaxStyle,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { replayEntries } from "./replay";
import { buildSyntaxStyle } from "./syntax";
import {
  AgentMessageLine,
  PendingMessageLine,
  TextLine,
  type Line,
} from "./transcript";
import { loadTheme, type Theme } from "./theme";
import {
  AGENT_MESSAGE_DISPLAY_TYPE,
} from "./subagents/types";

let destroy: (() => void) | undefined;
afterEach(async () => {
  // Fenced-code highlighting finishes asynchronously after the first frame.
  await new Promise((resolve) => setTimeout(resolve, 50));
  destroy?.();
});

const markdownText = [
  "# Heading",
  "",
  "- first",
  "- second with `inline code` and [a link](https://example.com)",
  "",
  "```typescript",
  "const answer = 42;",
  "```",
  "",
  "Final paragraph.",
].join("\n");

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

function TranscriptRows({
  theme,
  syntaxStyle,
  lines,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  lines: Line[];
}) {
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {lines.map((line, index) => line.kind === "agent-message" ? (
        <AgentMessageLine
          key={index}
          theme={theme}
          syntaxStyle={syntaxStyle}
          line={line}
        />
      ) : line.kind === "text" ? (
        <TextLine
          key={index}
          theme={theme}
          syntaxStyle={syntaxStyle}
          role={line.role}
          text={line.text}
        />
      ) : null)}
    </box>
  );
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.renderOnce();
  await setup.flush();
}

describe("transcript Markdown rows", () => {
  test("uses static Markdown for user, agent, and pending message bodies", async () => {
    const setup = await createTestRenderer({ width: 48, height: 40 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);

    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <TextLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          role="user"
          text={markdownText}
          workingCaret
        />
        <AgentMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          line={{ kind: "agent-message", sender: "alpha", recipient: "beta", text: markdownText }}
        />
        <PendingMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          pending={{ id: "user", line: { kind: "text", role: "user", text: markdownText } }}
        />
        <PendingMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          pending={{
            id: "agent",
            line: { kind: "agent-message", sender: "beta", recipient: "alpha", text: markdownText },
          }}
        />
      </box>,
    );
    await settle(setup);

    const markdownRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(markdownRows).toHaveLength(4);
    expect(markdownRows.every((row) => row.content === markdownText)).toBe(true);
    expect(markdownRows.every((row) => row.streaming === false)).toBe(true);
    expect(markdownRows.every((row) => row.syntaxStyle === syntaxStyle)).toBe(true);
    expect(markdownRows.every((row) => row.width <= 46)).toBe(true);

    const parsed = JSON.stringify(markdownRows[0]!._parseState?.tokens ?? []);
    expect(parsed).toContain('"type":"heading"');
    expect(parsed).toContain('"type":"list"');
    expect(parsed).toContain('"type":"codespan"');
    expect(parsed).toContain('"type":"link"');
    expect(parsed).toContain('"type":"code"');

    const frame = setup.captureCharFrame();
    expect(frame).toContain("alpha → beta");
    expect(frame).toContain("beta → alpha · queued");

    const boxes = descendants(setup.renderer.root, BoxRenderable);
    expect(boxes.some((box) => box.backgroundColor.equals(parseColor(theme.userBg)))).toBe(true);
    expect(boxes.some((box) => box.backgroundColor.equals(parseColor(theme.agentMessageBg)))).toBe(true);
  });

  test("updates syntax and semantic colors after a theme change", async () => {
    const setup = await createTestRenderer({ width: 48, height: 20 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const firstTheme = loadTheme("tokyonight");
    const firstStyle = buildSyntaxStyle(firstTheme);

    root.render(
      <TranscriptRows
        theme={firstTheme}
        syntaxStyle={firstStyle}
        lines={[
          { kind: "text", role: "user", text: markdownText },
          { kind: "agent-message", sender: "alpha", recipient: "beta", text: markdownText },
        ]}
      />,
    );
    await settle(setup);
    expect(descendants(setup.renderer.root, MarkdownRenderable).every((row) => row.syntaxStyle === firstStyle))
      .toBe(true);

    const nextTheme = loadTheme("gruvbox");
    const nextStyle = buildSyntaxStyle(nextTheme);
    root.render(
      <TranscriptRows
        theme={nextTheme}
        syntaxStyle={nextStyle}
        lines={[
          { kind: "text", role: "user", text: markdownText },
          { kind: "agent-message", sender: "alpha", recipient: "beta", text: markdownText },
        ]}
      />,
    );
    await settle(setup);

    const markdownRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(markdownRows.every((row) => row.syntaxStyle === nextStyle)).toBe(true);
    expect(markdownRows[0]!.fg?.equals(parseColor(nextTheme.user))).toBe(true);
    expect(markdownRows[1]!.fg?.equals(parseColor(nextTheme.agentMessage))).toBe(true);
  });

  test("renders replayed user and agent messages through the same Markdown rows", async () => {
    const entries = [
      {
        type: "message",
        message: { role: "user", content: markdownText },
      },
      {
        type: "custom",
        id: "agent-message",
        customType: AGENT_MESSAGE_DISPLAY_TYPE,
        data: {
          id: "message-1",
          sender: "main",
          recipient: "worker",
          text: markdownText,
          at: 1,
        },
      },
    ];
    const lines = replayEntries(entries, process.cwd(), false);
    const setup = await createTestRenderer({ width: 42, height: 30 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);

    createRoot(setup.renderer).render(
      <TranscriptRows theme={theme} syntaxStyle={syntaxStyle} lines={lines} />,
    );
    await settle(setup);

    expect(lines).toEqual([
      { kind: "text", role: "user", text: markdownText },
      { kind: "agent-message", sender: "main", recipient: "worker", text: markdownText },
    ]);
    const markdownRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(markdownRows.map((row) => row.content)).toEqual([markdownText, markdownText]);
    expect(markdownRows.every((row) => row.syntaxStyle === syntaxStyle)).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  TextRenderable,
  parseColor,
  type BaseRenderable,
  type SyntaxStyle,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
  act,
  useLayoutEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AnimationProvider, useMarkdownCaret } from "../src/animation";
import { replayEntries } from "../src/replay";
import { buildSyntaxStyle } from "../src/syntax";
import {
  AgentMessageLine,
  PendingMessageLine,
  StreamLine,
  TextLine,
  type Line,
} from "../src/transcript";
import { loadTheme, type Theme } from "../src/theme";
import {
  AGENT_MESSAGE_DISPLAY_TYPE,
} from "../src/subagents/types";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let destroy: (() => void) | undefined;
afterEach(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  destroy?.();
  destroy = undefined;
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
  await act(async () => {});
  await setup.renderOnce();
  await setup.flush();
  await Promise.all(
    descendants(setup.renderer.root, CodeRenderable).map((row) => row.highlightingDone),
  );
  await setup.flush();
}

describe("transcript Markdown rows", () => {
  test("keeps one streaming Markdown renderable while unstable constructs arrive", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const setup = await createTestRenderer({ width: 32, height: 40 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const content = [
      "# Heading",
      "",
      "- item with `code`, **strong**, *emphasis*, and [link](https://example.com)",
      "",
      "> quote",
      "",
      "| A | B |",
      "| - | - |",
      "| one | two |",
      "",
      "```typescript",
      "const answer = 42;",
      "```",
      "",
      "Partial [link]( and `code and **strong",
    ].join("\n");

    let setText: Dispatch<SetStateAction<string>> = () => {};
    function StreamingHarness() {
      const [text, updateText] = useState(content.slice(0, 1));
      setText = updateText;
      return (
        <box style={{ flexDirection: "column", width: "100%" }}>
          <StreamLine
            theme={theme}
            syntaxStyle={syntaxStyle}
            role="assistant"
            text={text}
          />
        </box>
      );
    }

    await act(async () => {
      root.render(<StreamingHarness />);
      await setup.flush();
    });

    const frameCheckpoints = new Set([
      1,
      content.indexOf("- item") + "- ".length,
      content.indexOf("`code`") + 1,
      content.indexOf("`code`") + "`code`".length,
      content.indexOf("**strong**") + 2,
      content.indexOf("**strong**") + "**strong**".length,
      content.indexOf("*emphasis*") + 1,
      content.indexOf("*emphasis*") + "*emphasis*".length,
      content.indexOf("[link](https://example.com)") + "[link](".length,
      content.indexOf("[link](https://example.com)") + "[link](https://example.com)".length,
      content.indexOf("> quote") + "> quote".length,
      content.indexOf("| one | two |") + "| one | two |".length,
      content.indexOf("```typescript") + 1,
      content.indexOf("```typescript") + 2,
      content.indexOf("```typescript") + "```typescript".length,
      content.lastIndexOf("```") + 3,
      content.indexOf("Partial [link](") + "Partial [link](".length,
      content.indexOf("and `code") + "and `code".length,
      content.length,
    ]);

    let markdown: MarkdownRenderable | undefined;
    for (let length = 1; length <= content.length; length += 1) {
      if (length > 1) {
        await act(async () => {
          setText(content.slice(0, length));
          await setup.flush();
        });
      }

      const current = descendants(setup.renderer.root, MarkdownRenderable)[0];
      expect(current).toBeDefined();
      if (markdown) expect(current).toBe(markdown);
      markdown = current;
      expect(current!.content).toBe(`${content.slice(0, length)}▊`);
      expect(current!.streaming).toBe(true);
      expect(current!.width).toBe(30);
      expect(current!.height).toBeGreaterThan(0);
      if (frameCheckpoints.has(length)) {
        const frame = setup.captureCharFrame();
        expect(frame.trim().length).toBeGreaterThan(0);
        expect(frame.split("\n").every((line) => line.length <= 32)).toBe(true);
      }
    }

    await Promise.all(
      descendants(setup.renderer.root, CodeRenderable).map((row) => row.highlightingDone),
    );
  }, 20_000);

  test("commits every Markdown delta before passive caret effects", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const setup = await createTestRenderer({ width: 24, height: 12 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const commits: string[] = [];
    let setText: Dispatch<SetStateAction<string>> = () => {};

    function CaretHarness() {
      const [text, updateText] = useState("#");
      const markdown = useMarkdownCaret(text, true);
      setText = updateText;
      useLayoutEffect(() => {
        commits.push(markdown.ref.current?.content ?? "<missing>");
      }, [markdown.content]);
      return (
        <markdown
          ref={markdown.ref}
          content={markdown.content}
          streaming
          syntaxStyle={syntaxStyle}
          fg={theme.assistant}
          style={{ width: "100%" }}
        />
      );
    }

    await act(async () => root.render(<CaretHarness />));
    expect(commits.at(-1)).toBe("#▊");

    for (const text of ["##", "```", "```typescript\n", "[link](", "**strong"] as const) {
      await act(async () => setText(text));
      expect(commits.at(-1)).toBe(`${text}▊`);
    }
  });

  test("does not schedule caret-only Markdown source updates", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const setup = await createTestRenderer({ width: 32, height: 12 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const originalRequestLive = setup.renderer.requestLive.bind(setup.renderer);
    let liveRequests = 0;
    setup.renderer.requestLive = () => {
      liveRequests += 1;
      originalRequestLive();
    };

    await act(async () => root.render(
      <AnimationProvider enabled>
        <StreamLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          role="assistant"
          text="### Heading"
        />
      </AnimationProvider>,
    ));

    const markdown = descendants(setup.renderer.root, MarkdownRenderable)[0]!;
    expect(markdown.content).toBe("### Heading▊");
    expect(markdown._parseState?.tokens[0]?.type).toBe("heading");
    expect(liveRequests).toBe(0);
  });

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
    expect(boxes.some((box) => box.backgroundColor.equals(parseColor(theme.agentMessageBg)))).toBe(false);
    expect(markdownRows[1]!.fg?.equals(parseColor(theme.agentMessage))).toBe(true);
    expect(markdownRows[3]!.fg?.equals(parseColor(theme.dim))).toBe(true);
  });

  test("updates syntax and semantic colors in place after a theme change", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const setup = await createTestRenderer({ width: 48, height: 20 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const firstTheme = loadTheme("tokyonight");
    const firstStyle = buildSyntaxStyle(firstTheme);
    const nextTheme = loadTheme("gruvbox");
    const nextStyle = buildSyntaxStyle(nextTheme);
    let switchTheme = () => {};

    function ThemeHarness() {
      const [current, setCurrent] = useState({ theme: firstTheme, style: firstStyle });
      switchTheme = () => setCurrent({ theme: nextTheme, style: nextStyle });
      return (
        <TranscriptRows
          theme={current.theme}
          syntaxStyle={current.style}
          lines={[
            { kind: "text", role: "user", text: markdownText },
            { kind: "agent-message", sender: "alpha", recipient: "beta", text: markdownText },
          ]}
        />
      );
    }

    await act(async () => root.render(<ThemeHarness />));
    await settle(setup);
    const firstRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(firstRows.every((row) => row.syntaxStyle === firstStyle)).toBe(true);

    await act(async () => switchTheme());
    await settle(setup);

    const markdownRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(markdownRows[0]).toBe(firstRows[0]);
    expect(markdownRows[1]).toBe(firstRows[1]);
    expect(markdownRows.every((row) => row.syntaxStyle === nextStyle)).toBe(true);
    expect(markdownRows[0]!.fg?.equals(parseColor(nextTheme.user))).toBe(true);
    expect(markdownRows[1]!.fg?.equals(parseColor(nextTheme.agentMessage))).toBe(true);
    const boxes = descendants(setup.renderer.root, BoxRenderable);
    expect(boxes.some((box) => box.backgroundColor.equals(parseColor(firstTheme.agentMessageBg)))).toBe(false);
    expect(boxes.some((box) => box.backgroundColor.equals(parseColor(nextTheme.agentMessageBg)))).toBe(false);
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
      {
        kind: "agent-message",
        sender: "main",
        recipient: "worker",
        text: markdownText,
        messageId: "message-1",
      },
    ]);
    const markdownRows = descendants(setup.renderer.root, MarkdownRenderable);
    expect(markdownRows.map((row) => row.content)).toEqual([markdownText, markdownText]);
    expect(markdownRows.every((row) => row.syntaxStyle === syntaxStyle)).toBe(true);
  });

  test("never draws heading markers between streamed chunks", async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const setup = await createTestRenderer({ width: 40, height: 24 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    const content = [
      "## Heading",
      "",
      "Body text follows here.",
      "",
      "### Another",
      "",
      "- a list item",
      "",
      "Tail.",
    ].join("\n");

    let setText: Dispatch<SetStateAction<string>> = () => {};
    function StreamingHarness() {
      const [text, updateText] = useState(content.slice(0, 1));
      setText = updateText;
      return (
        <box style={{ flexDirection: "column", width: "100%" }}>
          <StreamLine
            theme={theme}
            syntaxStyle={syntaxStyle}
            role="assistant"
            text={text}
          />
        </box>
      );
    }

    await act(async () => {
      root.render(<StreamingHarness />);
      await setup.flush();
    });

    // A marker is only excusable while the heading is still bare: "##" before
    // any title text has streamed in has nothing to conceal it against.
    const bare = /(^|\n)#{1,6} ?$/;
    const leaked: number[] = [];

    for (let length = 1; length <= content.length; length += 1) {
      if (length > 1) await act(async () => setText(content.slice(0, length)));

      // The next frame the terminal draws, before the asynchronous highlight
      // lands. That is the frame the flicker used to live in.
      await setup.renderOnce();
      if (setup.captureCharFrame().includes("#") && !bare.test(content.slice(0, length))) {
        leaked.push(length);
      }

      await Promise.all(
        descendants(setup.renderer.root, CodeRenderable).map((row) => row.highlightingDone),
      );
      await setup.renderOnce();
    }

    expect(leaked).toEqual([]);
  }, 20_000);
});

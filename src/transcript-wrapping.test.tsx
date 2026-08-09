import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { buildSyntaxStyle } from "./syntax";
import { loadTheme } from "./theme";
import {
  AgentMessageLine,
  PendingMessageLine,
  TextLine,
  ToolLine,
} from "./transcript";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const long = "alpha beta gamma delta epsilon zeta eta theta omega END";

describe("transcript wrapping", () => {
  test("wraps every transcript column within a narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 28, height: 48 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="assistant" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="thinking" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="system" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="error" text={long} />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="user" text={long} />
        <AgentMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          line={{ kind: "agent-message", sender: "long-sender-name", recipient: "long-recipient-name", text: long }}
        />
        <PendingMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          pending={{ id: "queued", line: { kind: "agent-message", sender: "long-sender-name", recipient: "long-recipient-name", text: long } }}
        />
        <ToolLine
          theme={theme}
          call={{ id: "tool", name: "bash", arg: long, detail: "+100 −100", state: "ok" }}
        />
      </box>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await setup.renderOnce();
    await setup.flush();
    const frame = setup.captureCharFrame();

    // OpenTUI's test renderer does not paint Markdown tree-sitter content.
    // Thinking, system, error, and tool rows still exercise plain-text wrapping.
    expect(frame.match(/END/g)?.length).toBe(4);
    expect(frame.split("\n").every((line) => line.length <= 28)).toBe(true);
    expect(frame).toContain("recipient-name");
    expect(frame).toContain("+100");
    expect(frame).toContain("−100");
    expect(frame).toContain("✓");
  });
});

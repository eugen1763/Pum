import { afterEach, describe, expect, test } from "bun:test";
import { StyledText } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { caretChunk } from "../src/animation";
import { PopupFrame } from "../src/popup-frame";
import { buildSyntaxStyle, settleSyntaxHighlighting } from "../src/syntax";
import { PRESETS, rgba, type Theme } from "../src/theme";
import { TextLine } from "../src/transcript";

let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); destroy = undefined; });

describe("transparent native rendering", () => {
  for (const width of [32, 100]) {
    test(`presets, semantic surfaces and opaque overrides at ${width} columns`, async () => {
      // No renderer background override: exercise the same transparent clear
      // buffer as main.tsx, rather than just checking React style properties.
      const setup = await createTestRenderer({ width, height: 16 });
      destroy = () => setup.renderer.destroy();
      const root = createRoot(setup.renderer);
      async function paint(theme: Theme, strength: number) {
        root.render(
          <box style={{ width, height: 16, flexDirection: "column", backgroundColor: theme.bg }}>
            <TextLine theme={theme} syntaxStyle={buildSyntaxStyle(theme)} role="user" text="User bar" />
            <TextLine theme={theme} syntaxStyle={buildSyntaxStyle(theme)} role="system" text="System text" />
            <text content={new StyledText([caretChunk(rgba(theme.bg), rgba(theme.accent), strength)])} />
            <PopupFrame theme={theme} terminalWidth={width} terminalHeight={16}
              geometry={{ left: 2, top: 5, width: width - 4, height: 5 }} zIndex={100}>
              <text content="Popup text" fg={theme.fg} />
            </PopupFrame>
          </box>,
        );
        await setup.renderOnce();
        await setup.flush();
        await settleSyntaxHighlighting(setup.renderer.root);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await setup.renderOnce();
        await setup.flush();
      }
      for (const preset of Object.values(PRESETS)) {
        // Opaque -> transparent uses the same retained root. Stale fill after
        // a theme preview/restore is just as wrong as an opaque first frame.
        for (const theme of [{ ...preset, bg: "#123456" }, preset]) {
          await paint(theme, 1);
          const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
          // Markdown paint is asynchronous; the real user's full-width
          // bar and prompt gutter exist independently of syntax completion.
          const user = spans.find((span) => span.text.includes("❯"));
          const answer = spans.find((span) => span.text.includes("System text"));
          const popup = spans.find((span) => span.text.includes("Popup text"));
          expect(user?.bg.equals(rgba(theme.userBg))).toBe(true);
          expect(answer?.bg.equals(rgba(theme.bg))).toBe(true);
          expect(popup?.bg.equals(rgba(theme.popupBg))).toBe(true);
          const caret = spans.find((span) => span.text.includes("▊"));
          expect(caret?.bg.equals(rgba(theme.bg))).toBe(true);
          expect(caret?.fg.equals(rgba(theme.accent))).toBe(true);
          expect(setup.captureCharFrame().split("\n").every((line) => Array.from(line).length <= width)).toBe(true);
        }
        await paint(preset, 0);
        expect(setup.captureCharFrame()).not.toContain("▊");
        // A hidden caret still occupies a transparent cell, not an opaque
        // black block (including when the theme has dark/light foregrounds).
        expect(setup.captureSpans().lines[2]!.spans.every((span) => span.bg.a === 0)).toBe(true);
      }
    });
  }
});

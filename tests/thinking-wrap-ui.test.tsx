import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { AnimationProvider } from "../src/animation";
import { StreamLine, TextLine, normalizeThinkingText } from "../src/transcript";
import { loadTheme } from "../src/theme";
import type { SyntaxStyle } from "@opentui/core";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

/**
 * Reasoning as deepseek-v4-flash writes it: dense with file names, flags and
 * paths. OpenTUI's own word wrap breaks after `.`, `-`, `/` and `(`, so every
 * one of these tokens is a place the transcript used to split a word.
 */
const THINKING = [
  "Before we start I should read src/check-mode.ts and auth.json to see which",
  "provider the check-mode flag selects. The models.json file lists ds4-code",
  "and ds4-ops under custom-192-168-210-135-4000 (the local endpoint), so the",
  "settings.json default provider is not the one that answers here.",
].join(" ");

const theme = loadTheme("tokyonight");
const style = {} as SyntaxStyle;

async function frameWords(node: React.ReactNode, width: number) {
  const setup = await createTestRenderer({ width, height: 60 });
  const root = createRoot(setup.renderer);
  root.render(<box style={{ flexDirection: "column", width: "100%" }}>{node}</box>);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.renderOnce();
  await setup.flush();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame
    .split("\n")
    .map((line) => line.slice(2).trimEnd())
    .join(" ")
    .replaceAll("▊", "")
    .split(/\s+/)
    .filter(Boolean);
}

const expected = normalizeThinkingText(THINKING).split(/\s+/).filter(Boolean);

describe("thinking rows never split a word", () => {
  test("settled reasoning keeps every token whole at any width", async () => {
    for (const width of [40, 52, 64, 71, 80, 96, 120]) {
      const words = await frameWords(
        <TextLine theme={theme} syntaxStyle={style} role="thinking" text={THINKING} />,
        width,
      );
      expect(words).toEqual(expected);
    }
  }, 120_000);

  test("streaming reasoning keeps every token whole at any width", async () => {
    for (const width of [40, 52, 64, 71, 80, 96, 120]) {
      const words = await frameWords(
        <AnimationProvider enabled={false}>
          <StreamLine theme={theme} syntaxStyle={style} role="thinking" text={THINKING} />
        </AnimationProvider>,
        width,
      );
      expect(words).toEqual(expected);
    }
  }, 120_000);
});

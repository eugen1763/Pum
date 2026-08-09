import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { PromptStash, PromptStashRow } from "./app";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const theme = loadTheme("tokyonight");

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

describe("prompt cache UI", () => {
  test("aligns wrapped continuation lines after the status icon", async () => {
    const setup = await createTestRenderer({ width: 18, height: 5 });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <PromptStashRow
        theme={theme}
        prompt={{ text: "one two three four five", executed: false }}
        index={0}
        selected={false}
      />,
    );
    await settle(setup);
    const lines = setup.captureCharFrame().split("\n").filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.startsWith("  ") || line.startsWith("○ "))).toBe(true);
  });

  test("scrolls to a newly appended row without cursor navigation", async () => {
    const setup = await createTestRenderer({ width: 30, height: 6 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const prompts = Array.from({ length: 5 }, (_, index) => ({
      text: `cached prompt ${index + 1}`,
      executed: false,
    }));
    root.render(
      <PromptStash theme={theme} prompts={prompts} cursor={-1} selectedIndices={new Set()} height={10} />,
    );
    await settle(setup);
    root.render(
      <PromptStash
        theme={theme}
        prompts={[...prompts, { text: "new cached prompt", executed: false }]}
        cursor={-1}
        selectedIndices={new Set()}
        height={10}
      />,
    );
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("new cached prompt");
  });
});

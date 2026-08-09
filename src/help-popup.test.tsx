import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { HelpPopup, maxHelpScrollOffset } from "./help-popup";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function renderHelp(width: number, height: number, scrollOffset: number) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <HelpPopup
        theme={loadTheme("tokyonight")}
        terminalWidth={width}
        terminalHeight={height}
        scrollOffset={scrollOffset}
      />
    </box>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return setup.captureCharFrame();
}

describe("Help popup layout", () => {
  test("uses readable grouped columns in a wide terminal", async () => {
    const frame = await renderHelp(100, 28, 0);
    expect(frame).toContain("Prompt");
    expect(frame).toContain("History and sessions");
    expect(frame).toContain("Commands");
    expect(frame).toContain("/ in Settings");
    expect(frame).toContain("esc or ? close");
  });

  test("supports scrolling to application controls in a short narrow terminal", async () => {
    const frame = await renderHelp(52, 16, maxHelpScrollOffset(16));
    expect(frame).toContain("Application");
    expect(frame).toContain("Ctrl+P");
    expect(frame).toContain("↑↓ scroll");
  });
});

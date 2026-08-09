import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { helpLines, HelpPopup, HELP_SUMMARY, maxHelpScrollOffset } from "./help-popup";
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
  test("summarizes the main workflow", async () => {
    const frame = await renderHelp(80, 28, 0);
    expect(frame).toContain("PUM workflow");
    for (const line of HELP_SUMMARY) expect(frame).toContain(line);
  });

  test("adds category gaps only when terminal height permits", () => {
    expect(helpLines(40).filter((line) => line.kind === "blank").length).toBeGreaterThan(0);
    expect(helpLines(16).some((line) => line.kind === "blank")).toBe(false);
  });

  test("uses readable grouped columns in a wide terminal", async () => {
    const frame = await renderHelp(100, 28, 0);
    expect(frame).toContain("Prompt");
    expect(frame).toContain("History and sessions");
    expect(frame).toContain("Commands");
    expect(frame).toContain("/ in Settings");
    expect(frame).toContain("esc or ? close");
    const footer = frame.split("\n").find((line) => line.includes("esc or ? close"));
    expect(footer).not.toContain("Send, or steer while working");
  });

  test("supports scrolling to application controls in a short narrow terminal", async () => {
    const frame = await renderHelp(52, 16, maxHelpScrollOffset(16));
    expect(frame).toContain("Application");
    expect(frame).toContain("Ctrl+P");
    expect(frame).toContain("↑↓ scroll");
    const footer = frame.split("\n").find((line) => line.includes("esc or ? close"));
    expect(footer).not.toContain("Ctrl+P");
  });

  test("keeps the footer on a fixed row in a short wide terminal", async () => {
    const frame = await renderHelp(100, 10, 0);
    const lines = frame.split("\n");
    const footerIndex = lines.findIndex((line) => line.includes("esc or ? close"));

    expect(footerIndex).toBeGreaterThan(0);
    expect(lines[footerIndex]).not.toContain("Send, or steer while working");
    expect(lines[footerIndex - 1]).not.toContain("esc or ? close");
  });
});

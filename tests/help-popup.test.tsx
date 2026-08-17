import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
  HELP_GROUPS,
  helpLayout,
  helpLines,
  HelpPopup,
  HELP_SUMMARY,
  maxHelpScrollOffset,
} from "../src/help-popup";
import { loadTheme } from "../src/theme";

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
  test("documents input mode, cache aliases, scoped history, and Processes", () => {
    const controls = HELP_GROUPS.flatMap((group) => group.controls);
    expect(controls).toContainEqual(["Alt+I", "Toggle multiline input mode"]);
    expect(controls.some(([key]) => key === "Ctrl+I")).toBe(false);
    expect(controls.some(([key]) => key === "Ctrl+Alt+Enter")).toBe(true);
    expect(controls.some(([key, text]) => key === "Main ↑ / ↓" && text.includes("Sent history"))).toBe(true);
    expect(controls.some(([key, text]) => key === "Ctrl+H" && text.includes("/history"))).toBe(true);
    // /processes and /triggers are separate commands: /triggers forces the
    // Triggers tab, /processes keeps the last one.
    expect(controls).toContainEqual(["/processes", "Open Processes on last tab"]);
    expect(controls).toContainEqual(["/triggers", "Open Processes on Triggers"]);
    expect(controls.some(([key]) => key === "Ctrl+P")).toBe(true);
    expect(controls.some(([key]) => key === "/ in Settings")).toBe(true);
  });

  test("summarizes the main workflow", async () => {
    const frame = await renderHelp(80, 28, 0);
    expect(frame).toContain("PUM workflow");
    for (const line of HELP_SUMMARY) expect(frame).toContain(line);
  });

  test("adds category gaps only when terminal height permits", () => {
    expect(helpLines(40).filter((line) => line.kind === "blank").length).toBeGreaterThan(0);
    expect(helpLines(16).some((line) => line.kind === "blank")).toBe(false);
  });

  test("uses readable grouped columns with exact outer content gaps", async () => {
    const frame = await renderHelp(140, 28, 0);
    const lines = frame.split("\n");
    expect(frame).toContain("Prompt");
    expect(frame).toContain("History and sessions");
    expect(frame).toContain("Commands");
    expect(frame).toContain("Ctrl+P");
    expect(frame).toContain("esc or ? close");

    const summaryEnd = lines.findIndex((line) => line.includes("switch transcripts"));
    const contentStart = lines.findIndex((line) => line.includes("Prompt"));
    const footerIndex = lines.findIndex((line) => line.includes("esc or ? close"));
    expect(contentStart - summaryEnd).toBe(2);

    // The footer sits two rows after the last content row: one bottom gap and
    // the footer itself. Walk up from the footer past the blank gap so the
    // assertion stays valid as the Prompt group gains rows.
    let lastContentIndex = footerIndex - 1;
    while (lastContentIndex > contentStart && lines[lastContentIndex].match(/^\s*│\s*│\s*$/u)) {
      lastContentIndex -= 1;
    }
    expect(footerIndex - lastContentIndex).toBe(2);
    expect(lines[footerIndex]).not.toContain("Send, or steer while working");
  });

  test("keeps every wide-layout row reachable", async () => {
    // A constant popup height used to hide the last rows of the taller column
    // at every terminal size, and the arrows did nothing in this layout.
    const tall = await renderHelp(140, 40, 0);
    expect(tall).toContain("Ctrl+H");
    expect(tall).toContain("pum -r");
    expect(tall).toContain("/ in Settings");
    expect(tall).toContain("Ctrl+End");
    expect(tall).toContain("Close popup; clear; twice quits");
    expect(tall).not.toContain("↑↓ scroll");

    const short = await renderHelp(140, 28, 0);
    expect(short).not.toContain("pum -r");
    expect(short).toContain("↑↓ scroll");

    const scrolled = await renderHelp(140, 28, maxHelpScrollOffset(28, 140));
    expect(scrolled).toContain("Ctrl+H");
    expect(scrolled).toContain("pum -r");
  });

  test("stacks category groups vertically when the full columns would clip", async () => {
    expect(helpLayout(100, 28).twoColumns).toBe(false);
    const firstPage = await renderHelp(100, 28, 0);
    const lastPage = await renderHelp(100, 28, maxHelpScrollOffset(28));
    // Scroll to the Commands heading itself rather than a fixed distance from
    // the end, so adding a command does not move this assertion off the page.
    const commandsOffset = helpLines(28)
      .findIndex((line) => line.kind === "heading" && line.text === "Commands");
    const commandsPage = await renderHelp(100, 28, Math.min(
      Math.max(0, commandsOffset),
      maxHelpScrollOffset(28),
    ));

    expect(firstPage).toContain("Prompt");
    expect(firstPage).toContain("Cache and agents");
    expect(commandsPage).toContain("Commands");
    expect(lastPage).toContain("Application");
    expect(lastPage).toContain("↑↓ scroll");
    for (const line of `${firstPage}\n${lastPage}`.split("\n")) {
      expect(Array.from(line).length).toBeLessThanOrEqual(100);
    }
  });

  test("supports scrolling with footer separation in a short narrow terminal", async () => {
    const frame = await renderHelp(52, 16, maxHelpScrollOffset(16));
    const lines = frame.split("\n");
    expect(frame).toContain("Application");
    expect(frame).toContain("Ctrl+P");
    expect(frame).toContain("↑↓ scroll");
    const footerIndex = lines.findIndex((line) => line.includes("esc or ? close"));
    const lastControlIndex = footerIndex - 2;
    expect(lines[footerIndex - 1]).toMatch(/^\s*│\s*│\s*$/u);
    expect(lines[lastControlIndex]).not.toMatch(/^\s*│\s*│\s*$/u);
    expect(lines[footerIndex]).not.toContain("Ctrl+P");
  });

  test("uses compact gaps only when a narrow terminal cannot hold both", async () => {
    expect(helpLayout(52, 13)).toMatchObject({ topGap: 1, bottomGap: 1 });
    expect(helpLayout(52, 12)).toMatchObject({ topGap: 0, bottomGap: 1 });
    expect(helpLayout(52, 10)).toMatchObject({ topGap: 0, bottomGap: 0 });

    const frame = await renderHelp(52, 12, 0);
    const lines = frame.split("\n");
    const footerIndex = lines.findIndex((line) => line.includes("esc or ? close"));
    expect(footerIndex).toBeGreaterThan(0);
    expect(lines[footerIndex - 1]).toMatch(/^\s*│\s*│\s*$/u);
    expect(lines[footerIndex]).not.toContain("Prompt");
  });

  test("keeps both gaps and the footer fixed in the minimum wide layout", async () => {
    const frame = await renderHelp(140, 10, 0);
    const lines = frame.split("\n");
    const summaryEnd = lines.findIndex((line) => line.includes("switch transcripts"));
    const contentStart = lines.findIndex((line) => line.includes("Prompt"));
    const footerIndex = lines.findIndex((line) => line.includes("esc or ? close"));

    expect(helpLayout(140, 10)).toMatchObject({ topGap: 1, bottomGap: 1, contentHeight: 1 });
    expect(contentStart - summaryEnd).toBe(2);
    expect(footerIndex - contentStart).toBe(2);
    expect(lines[footerIndex]).not.toContain("Send, or steer while working");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { PRESETS } from "./theme";
import { SessionHistoryPopup, sessionHistoryOption } from "./session-history-popup";
import type { SessionHistoryItem } from "./session-history-metadata";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function item(index: number, overrides: Partial<SessionHistoryItem> = {}): SessionHistoryItem {
  const path = `/fixture/session-${index}.jsonl`;
  return {
    path,
    id: `session-${index}`,
    cwd: "/fixture/project",
    created: new Date(`2026-08-${String(Math.min(9, index + 1)).padStart(2, "0")}T10:00:00.000Z`),
    modified: new Date("2026-08-09T10:00:00.000Z"),
    messageCount: index + 1,
    firstMessage: `Fixture session ${index}`,
    allMessagesText: "fixture",
    historyMetadata: {
      latestUserMessageAt: new Date("2026-08-09T15:04:00.000Z"),
      fileBytes: 1536,
      tokens: { outgoing: 1200, incoming: 345, cacheRead: 2400 },
    },
    ...overrides,
  };
}

async function renderPopup(width: number, height: number, sessions: SessionHistoryItem[], currentPath?: string) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  let selected: string | undefined;
  createRoot(setup.renderer).render(
    <box style={{ width, height, backgroundColor: PRESETS.tokyonight!.bg }}>
      <SessionHistoryPopup
        theme={PRESETS.tokyonight!}
        sessions={sessions}
        currentPath={currentPath}
        terminalWidth={width}
        terminalHeight={height}
        onSelect={(path) => { selected = path; }}
      />
    </box>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return { setup, selected: () => selected };
}

function expectFrameWithinWidth(frame: string, width: number): void {
  for (const line of frame.split("\n")) expect([...line].length).toBeLessThanOrEqual(width);
}

describe("session history popup", () => {
  test("marks and selects the current session while keeping metadata compact", async () => {
    const sessions = [item(0), item(1), item(2)];
    const currentPath = sessions[1]!.path;
    const { setup, selected } = await renderPopup(90, 20, sessions, currentPath);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Session history");
    expect(frame).toContain("● Fixture session 1");
    expect(frame).toContain("1.5 KiB");
    expect(frame).toContain("↑1.2k ↓345 ↺2.4k");
    expect(frame).toContain("size = JSONL file bytes");
    const selectedText = setup.captureSpans().lines
      .flatMap((line) => line.spans)
      .filter((span) => span.bg.equals(parseColor(PRESETS.tokyonight!.selectionBg)))
      .map((span) => span.text)
      .join("");
    expect(selectedText).toContain("Fixture session 1");

    setup.mockInput.pressEnter();
    await setup.renderOnce();
    await setup.flush();
    expect(selected()).toBe(currentPath);
  });

  test("scrolls the selected current session into a short list viewport", async () => {
    const sessions = Array.from({ length: 20 }, (_, index) => item(index));
    const currentPath = sessions[16]!.path;
    const { setup } = await renderPopup(70, 10, sessions, currentPath);
    expect(setup.captureCharFrame()).toContain("● Fixture session 16");
  });

  test("uses one-line rows on narrow terminals and never exceeds terminal width", async () => {
    const { setup } = await renderPopup(38, 8, [item(0)], item(0).path);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("● Fixture session 0");
    expectFrameWithinWidth(frame, 38);
  });

  test("keeps a usable list in a very short terminal", async () => {
    const { setup } = await renderPopup(30, 4, [item(0), item(1)], item(1).path);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("● Fixture session 1");
    expect(frame).not.toContain("size=JSONL bytes");
    expectFrameWithinWidth(frame, 30);
  });

  test("uses a deterministic missing-user fallback and shows only known token values", () => {
    const option = sessionHistoryOption(item(0, {
      historyMetadata: {
        latestUserMessageAt: null,
        fileBytes: null,
        tokens: { incoming: 8 },
      },
    }), undefined, false);
    expect(option.description).toContain("no user message");
    expect(option.description).toContain("size ?");
    expect(option.description).toContain("↓8");
    expect(option.description).not.toContain("↑");
    expect(option.description).not.toContain("↺");
  });
});

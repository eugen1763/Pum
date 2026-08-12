import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { loadTheme } from "./theme";
import { maxStatsScrollOffset, StatsPopup, statsLines, statsPopupGeometry } from "./stats-popup";
import type { SessionStatsSnapshot } from "./session-stats";

let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); destroy = undefined; });

const snapshot: SessionStatsSnapshot = {
  models: [
    { model: "mock/agent-model-with-a-long-name", role: "Agent", attempts: 4, outgoing: 1200, incoming: 345, cacheRead: 2400, cost: 0.25, compressions: 2 },
    { model: "mock/check-model", role: "Check", attempts: 2, outgoing: 50, incoming: 4, cacheRead: 10, cost: 0.01, compressions: 0 },
    { model: "legacy/model", role: "Agent", attempts: null, outgoing: 5, incoming: 1, cacheRead: 0, cost: 0, compressions: 0 },
  ],
  tools: [
    { tool: "read", successful: 5, failed: 0, blocked: 0, runningInterrupted: 0, total: 5 },
    { tool: "bash", successful: 1, failed: 2, blocked: 1, runningInterrupted: 1, total: 5 },
  ],
  outcomes: { successful: 6, failed: 2, blocked: 1, runningInterrupted: 1 },
};

async function render(width: number, height: number, offset = 0) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <StatsPopup
        theme={loadTheme("tokyonight")}
        snapshot={snapshot}
        terminalWidth={width}
        terminalHeight={height}
        scrollOffset={offset}
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

describe("statistics popup", () => {
  test("uses wide table columns and legacy em dash values", async () => {
    const frame = await render(110, 28);
    expect(frame).toContain("Session statistics");
    expect(frame).toContain("Model / role");
    expect(frame).toContain("mock/check-model · Check");
    expect(frame).toContain("—");
    expect(frame).toContain("Running/Interrupted");
  });

  test("keeps narrow rows within the available content width", async () => {
    const geometry = statsPopupGeometry(42, 12);
    expect(geometry).toMatchObject({ compact: true, left: 1, top: 1, width: 40, height: 10 });
    const lines = statsLines(snapshot, 40);
    expect(lines.every((line) => Bun.stringWidth(line.text) <= 40)).toBe(true);
    const frame = await render(42, 12);
    expect(frame).toContain("Session statistics");
    expect(frame).toContain("Models");
  });

  test("calculates scrolling for long content and renders later tool rows", async () => {
    const offset = maxStatsScrollOffset(snapshot, 50, 10);
    expect(offset).toBeGreaterThan(0);
    const frame = await render(50, 10, offset);
    expect(frame).toContain("bash");
    expect(frame).toContain("esc close");
  });
});

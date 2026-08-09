import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ComponentProps } from "react";
import { AnimationProvider } from "./animation";
import { StatusBar, statusBarLayout } from "./status-bar";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function renderStatus(
  width: number,
  agentCount: number,
  runningAgentCount: number,
  overrides: Partial<ComponentProps<typeof StatusBar>> = {},
) {
  const setup = await createTestRenderer({ width, height: 8 });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <AnimationProvider enabled={false}>
      <StatusBar
        theme={loadTheme("tokyonight")}
        modelId="mock-model"
        thinkingLevel="off"
        branch="main"
        outgoingTokens={1200}
        incomingTokens={345}
        cacheReadTokens={2400}
        cost={0}
        contextPct={20}
        busy={false}
        elapsedSec={0}
        agentCount={agentCount}
        runningAgentCount={runningAgentCount}
        maxActiveAgentCount={10}
        {...overrides}
      />
    </AnimationProvider>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

const thresholdInput = {
  modelId: "m",
  thinkingLevel: "o",
  branch: "main",
  outgoingTokens: 1200,
  incomingTokens: 345,
  cacheReadTokens: 2400,
  cost: 0.25,
  contextPct: 20,
  busy: false,
  elapsedSec: 0,
  agentCount: 0,
  runningAgentCount: 0,
  maxActiveAgentCount: 10,
};

const visibleFields = (width: number) => {
  const layout = statusBarLayout({ ...thresholdInput, width });
  return [
    ...(layout.showTitle ? ["title"] : []),
    ...layout.metadata.map((item) => item.key),
  ];
};

describe("StatusBar usage and subagent counts", () => {
  test("shows separate compact token metrics in a wide layout", async () => {
    const frame = await renderStatus(100, 0, 0);
    expect(frame).toContain("main · ↑ 1.2k · ↓ 345 · ↺ 2.4k · 20%");
  });
  test("shows separate idle and capacity-aware working counts in a wide layout", async () => {
    const frame = await renderStatus(100, 5, 2);
    expect(frame).toContain("◇ 3 • 2/10");
    expect(frame).not.toContain("◇ 5");
  });

  test("preserves both counts in the narrow stacked layout", async () => {
    const frame = await renderStatus(48, 5, 2);
    expect(frame).toContain("◇ 3 • 2/10");
    expect(frame).toContain("main · ↑ 1.2k · ↓ 345 · ↺ 2.4k · 20%");
  });

  test("omits zero-count indicators", async () => {
    const idle = await renderStatus(80, 3, 0);
    expect(idle).toContain("◇ 3");
    expect(idle).not.toContain("• 0");

    destroy?.();
    destroy = undefined;

    const active = await renderStatus(80, 2, 2);
    expect(active).toContain("• 2/10");
    expect(active).not.toContain("◇ 0");
  });

  test("removes optional fields at each successive width threshold", () => {
    expect(visibleFields(46)).toEqual([
      "title", "branch", "outgoing", "incoming", "cacheRead", "cost", "context",
    ]);
    expect(visibleFields(45)).toEqual([
      "title", "branch", "outgoing", "incoming", "cacheRead", "context",
    ]);
    expect(visibleFields(37)).toEqual([
      "title", "branch", "outgoing", "incoming", "cacheRead", "context",
    ]);
    expect(visibleFields(36)).toEqual([
      "title", "branch", "outgoing", "incoming", "context",
    ]);
    expect(visibleFields(28)).toEqual([
      "title", "branch", "outgoing", "incoming", "context",
    ]);
    expect(visibleFields(27)).toEqual(["title", "branch", "incoming", "context"]);
    expect(visibleFields(19)).toEqual(["title", "branch", "incoming", "context"]);
    expect(visibleFields(18)).toEqual(["title", "branch", "context"]);
    expect(visibleFields(12)).toEqual(["title", "branch", "context"]);
    expect(visibleFields(11)).toEqual(["branch", "context"]);
  });

  test("renders no wrapped or overflowing header rows at very narrow widths", async () => {
    const width = 4;
    const frame = await renderStatus(width, 5, 2, {
      modelId: "long-model-name",
      thinkingLevel: "high",
      cost: 0.25,
      activeAgentName: "long-agent-name",
    });
    const visibleLines = frame.split("\n").filter((line) => line.trim().length > 0);

    expect(visibleLines.length).toBeLessThanOrEqual(2);
    expect(visibleLines.every((line) => line.length <= width)).toBe(true);
  });
});

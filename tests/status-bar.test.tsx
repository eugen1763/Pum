import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ComponentProps } from "react";
import { AnimationProvider } from "../src/animation";
import { StatusBar, statusBarLayout, truncateStatusText } from "../src/status-bar";
import { statusTextWidth } from "../src/status-metadata";
import { loadTheme } from "../src/theme";

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
        cwd="/repo/project"
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

async function renderStatusSetup(
  width: number,
  overrides: Partial<ComponentProps<typeof StatusBar>> = {},
  animationEnabled = false,
) {
  const setup = await createTestRenderer({ width, height: 8 });
  destroy = () => setup.renderer.destroy();
  const theme = loadTheme("tokyonight");
  createRoot(setup.renderer).render(
    <AnimationProvider enabled={animationEnabled}>
      <StatusBar
        theme={theme}
        modelId="mock-model"
        thinkingLevel="off"
        cwd="C:\\dev\\Pum"
        branch="main"
        outgoingTokens={0}
        incomingTokens={0}
        cacheReadTokens={0}
        cost={0}
        contextPct={20}
        busy={false}
        elapsedSec={0}
        agentCount={0}
        runningAgentCount={0}
        maxActiveAgentCount={10}
        {...overrides}
      />
    </AnimationProvider>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  return { setup, theme };
}

const thresholdInput = {
  modelId: "m",
  thinkingLevel: "o",
  cwd: "/repo/project",
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

const visibleOptionalFields = (width: number) => {
  const layout = statusBarLayout({ ...thresholdInput, width });
  return [
    ...(layout.showTitle ? ["title"] : []),
    ...layout.metadata.map((item) => item.key),
  ];
};

function expectOneMeasuredLine(frame: string, width: number) {
  const lines = frame.split("\n");
  expect(lines[0]).toBeDefined();
  expect(statusTextWidth(lines[0]!.trimEnd())).toBeLessThanOrEqual(width);
  expect(lines.slice(1).every((line) => line.trim().length === 0)).toBe(true);
}

function expectAgentCounts(
  frame: string,
  width: number,
  agentCount: number,
  runningAgentCount: number,
  expected: { idle: number | null; active: number | null },
) {
  const layout = statusBarLayout({
    ...thresholdInput,
    width,
    agentCount,
    runningAgentCount,
  });
  const idleAgentCount = Math.max(0, agentCount - runningAgentCount);
  const visible = {
    idle: layout.showIdleAgents && idleAgentCount > 0 ? idleAgentCount : null,
    active: layout.showRunningAgents && runningAgentCount > 0 ? runningAgentCount : null,
  };

  expect(visible).toEqual(expected);
  if (expected.idle !== null) expect(frame).toContain(`◇ ${expected.idle}`);
  else expect(frame).not.toContain("◇");
  if (expected.active !== null) expect(frame).toContain(`◆ ${expected.active}/10`);
  else expect(frame).not.toContain("/10");
}

describe("StatusBar usage and subagent counts", () => {
  test("shows separate compact token metrics in a wide layout", async () => {
    const frame = await renderStatus(100, 0, 0);
    expect(frame).toContain("project · main · ↑ 1.2k · ↓ 345 · ↺ 2.4k · 20%");
    expectOneMeasuredLine(frame, 100);
  });

  test("renders cwd immediately before branch with its semantic color", async () => {
    const { setup, theme } = await renderStatusSetup(100);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Pum · main");
    const cwdSpan = setup.captureSpans().lines.flatMap((line) => line.spans)
      .find((span) => span.text === "Pum");
    expect(cwdSpan?.fg.equals(parseColor(theme.statusCwd))).toBe(true);
  });

  test("shows separate idle and capacity-aware working counts", async () => {
    const frame = await renderStatus(100, 5, 2);
    expectAgentCounts(frame, 100, 5, 2, { idle: 3, active: 2 });
    expect(frame).not.toContain("◇ 5");
    expectOneMeasuredLine(frame, 100);
  });

  test.each([false, true])("keeps activity icons static with animation enabled=%s", async (enabled) => {
    const { setup, theme } = await renderStatusSetup(100, {
      busy: true,
      elapsedSec: 65,
      agentCount: 5,
      runningAgentCount: 2,
    }, enabled);
    const initial = setup.captureCharFrame();
    expect(initial).toContain("◇ 3 ◆ 2/10");
    expect(initial).toContain("◆ working 1m 5s");
    expect(statusTextWidth("◆")).toBe(1);
    const icons = setup.captureSpans().lines.flatMap((line) => line.spans)
      .filter((span) => span.text.includes("◆"));
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every((span) => span.fg.equals(parseColor(theme.accent)))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toBe(initial);
    expectOneMeasuredLine(initial, 100);
  });

  test("shows the global running-shell count and keeps one row", async () => {
    const frame = await renderStatus(100, 0, 0, { runningShellCount: 3 });
    expect(frame).toContain("▣ 3");
    expectOneMeasuredLine(frame, 100);

    const layout = statusBarLayout({ ...thresholdInput, width: 2, runningShellCount: 3 });
    expect(layout.totalWidth).toBeLessThanOrEqual(2);
    expect(layout.showRunningShells).toBe(false);
  });

  test("keeps one line and removes usage fields before agent state", async () => {
    const frame = await renderStatus(48, 5, 2);
    expectAgentCounts(frame, 48, 5, 2, { idle: 3, active: 2 });
    expect(frame).toContain("main · 20%");
    expect(frame).not.toContain("↑");
    expect(frame).not.toContain("↓");
    expect(frame).not.toContain("↺");
    expectOneMeasuredLine(frame, 48);
  });

  test("omits zero-count indicators", async () => {
    const idle = await renderStatus(80, 3, 0);
    expectAgentCounts(idle, 80, 3, 0, { idle: 3, active: null });

    destroy?.();
    destroy = undefined;

    const active = await renderStatus(80, 2, 2);
    expectAgentCounts(active, 80, 2, 2, { idle: null, active: 2 });
  });

  test("removes optional fields in the exact required threshold order", () => {
    expect(visibleOptionalFields(68)).toEqual([
      "title", "cwd", "branch", "outgoing", "incoming", "cacheRead", "cost", "context",
    ]);
    expect(visibleOptionalFields(67)).toEqual([
      "title", "cwd", "branch", "outgoing", "incoming", "cacheRead", "context",
    ]);
    expect(visibleOptionalFields(59)).toEqual([
      "title", "cwd", "branch", "outgoing", "incoming", "cacheRead", "context",
    ]);
    expect(visibleOptionalFields(58)).toEqual([
      "title", "cwd", "branch", "outgoing", "incoming", "context",
    ]);
    expect(visibleOptionalFields(49)).toEqual([
      "title", "cwd", "branch", "incoming", "context",
    ]);
    expect(visibleOptionalFields(40)).toEqual(["title", "cwd", "branch", "context"]);
    expect(visibleOptionalFields(32)).toEqual(["cwd", "branch", "context"]);
    expect(visibleOptionalFields(25)).toEqual(["branch", "context"]);
    expect(visibleOptionalFields(15)).toEqual(["context"]);
  });

  test("prioritizes active work across branch, model, thinking, and agent metadata", () => {
    const input = {
      ...thresholdInput,
      modelId: "模型-ultra-long",
      thinkingLevel: "high",
      branch: "feature/very-long",
      busy: true,
      elapsedSec: 65,
      agentCount: 12,
      runningAgentCount: 9,
      activeAgentName: "worker-界面",
      contextPct: 88,
    };

    const medium = statusBarLayout({ ...input, width: 48 });
    expect(medium.totalWidth).toBeLessThanOrEqual(48);
    expect(medium.modelText).toBe("模型-ultra-long");
    expect(medium.activeAgentText).toBe("worker-界面");
    expect(medium.showRunningAgents).toBe(true);
    expect(medium.workingMode).toBe("compact");
    expect(medium.thinkingText).toBeNull();
    expect(medium.metadata).toEqual([]);

    const narrow = statusBarLayout({ ...input, width: 24 });
    expect(narrow.totalWidth).toBeLessThanOrEqual(24);
    expect(narrow.modelText).toBeNull();
    expect(narrow.activeAgentText).toBe("work…");
    expect(narrow.showRunningAgents).toBe(true);
    expect(narrow.workingMode).toBe("compact");

    const tiny = statusBarLayout({ ...input, width: 8 });
    expect(tiny.totalWidth).toBeLessThanOrEqual(8);
    expect(tiny.workingMode).toBe("icon");
    expect(tiny.modelText).toBeNull();
    expect(tiny.activeAgentText).toBeNull();
    expect(tiny.showRunningAgents).toBe(false);
  });

  test("truncates Unicode text by terminal columns and complete graphemes", () => {
    expect(truncateStatusText("模型-agent", 7)).toBe("模型-a…");
    expect(statusTextWidth(truncateStatusText("模型-agent", 7)!)).toBe(7);
    expect(truncateStatusText("e\u0301clair", 4)).toBe("e\u0301cl…");
    expect(statusTextWidth(truncateStatusText("e\u0301clair", 4)!)).toBe(4);
    expect(truncateStatusText("界面", 1)).toBe("…");
  });

  test("renders exactly one non-overflowing row at every very narrow width", async () => {
    for (const width of [1, 2, 3, 4, 5, 8, 12, 16, 24, 32]) {
      const frame = await renderStatus(width, 12, 9, {
        modelId: "模型-ultra-long",
        thinkingLevel: "high",
        cwd: "C:\\开发\\界面",
        branch: "feature/very-long",
        cost: 0.25,
        contextPct: 88,
        busy: true,
        elapsedSec: 65,
        activeAgentName: "worker-界面",
      });
      expectOneMeasuredLine(frame, width);
      expect(frame).toContain("◆");
      if (width === 1) expect(frame.split("\n")[0]).toBe("◆");
      destroy?.();
      destroy = undefined;
    }
  });
});

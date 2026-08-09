import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { AnimationProvider } from "./animation";
import { StatusBar } from "./status-bar";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function renderStatus(width: number, agentCount: number, runningAgentCount: number) {
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
      />
    </AnimationProvider>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("StatusBar usage and subagent counts", () => {
  test("shows separate compact token metrics in a wide layout", async () => {
    const frame = await renderStatus(100, 0, 0);
    expect(frame).toContain("main · ↑1.2k · ↓345 · ○2.4k · 20%");
  });
  test("shows separate idle and static working counts in a wide layout", async () => {
    const frame = await renderStatus(100, 5, 2);
    expect(frame).toContain("◇ 3 • 2");
    expect(frame).not.toContain("◇ 5");
  });

  test("preserves both counts in the narrow stacked layout", async () => {
    const frame = await renderStatus(34, 5, 2);
    expect(frame).toContain("◇ 3 • 2");
    expect(frame).toContain("main · ↑1.2k · ↓345 · ○2.4k · 20%");
  });

  test("omits zero-count indicators", async () => {
    const idle = await renderStatus(80, 3, 0);
    expect(idle).toContain("◇ 3");
    expect(idle).not.toContain("• 0");

    destroy?.();
    destroy = undefined;

    const active = await renderStatus(80, 2, 2);
    expect(active).toContain("• 2");
    expect(active).not.toContain("◇ 0");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./app";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

const settings = {
  showThinking: false,
  theme: "tokyonight" as const,
  animations: false,
  workingRuleAnimation: "off" as const,
  webSearch: false,
  writingStyle: "none" as const,
  explanationStrength: "simple" as const,
  checkMode: "off" as const,
  checkModel: "mock/check",
  maxActiveSubagents: 10,
};

function fakeSession(sent: string[]) {
  return {
    agent: { state: { model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionId: "main-session",
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async (text: string) => { sent.push(text); },
    steer: async () => {},
  } as any;
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp() {
  const sent: string[] = [];
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession(sent);
  const manager = {
    getAgents: () => [], subscribe: () => () => {}, bindMainSession: async () => {},
    abortAgent: async () => {}, sendUserMessage: async () => {}, persistToolEvent() {},
  } as any;
  createRoot(setup.renderer).render(
    <App session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
      settings={settings} searchProviders={[]} subagentManager={manager}
      promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
      promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }} />,
  );
  await settle(setup);
  return { setup, sent };
}

describe("prompt input mode", () => {
  test("Alt+I toggles the visible input indicator", async () => {
    const { setup } = await renderApp();
    expect(setup.captureCharFrame()).toContain("❯ Ask something…");
    setup.mockInput.pressKey("i", { meta: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("i Ask something…");
    expect(setup.captureCharFrame()).not.toContain("❯ Ask something…");
    setup.mockInput.pressKey("i", { meta: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ Ask something…");
  });

  test("Ctrl+I does not toggle the visible input indicator", async () => {
    const { setup } = await renderApp();
    setup.mockInput.pressKey("i", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ Ask something…");
    expect(setup.captureCharFrame()).not.toContain("i Ask something…");
  });

  test("plain Enter inserts a newline while input mode is on", async () => {
    const { setup, sent } = await renderApp();
    setup.mockInput.pressKey("i", { meta: true });
    await setup.mockInput.typeText("first");
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("second");
    await settle(setup);
    expect(sent).toEqual([]);
    const lines = setup.captureCharFrame().split("\n");
    const first = lines.findIndex((line) => line.includes("first"));
    const second = lines.findIndex((line, index) => index > first && line.includes("second"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(first + 1);
    expect(lines[second]).toContain("i second");
  });

  test("toggling input mode off restores plain Enter sending", async () => {
    const { setup, sent } = await renderApp();
    setup.mockInput.pressKey("i", { meta: true });
    await setup.mockInput.typeText("first");
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("second");
    setup.mockInput.pressKey("i", { meta: true });
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(sent).toEqual(["first\nsecond"]);
  });
});

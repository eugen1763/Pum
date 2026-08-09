import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App, promptPlaceholder } from "./app";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function fakeSession() {
  return {
    agent: {
      state: {
        model: {
          id: "mock-model",
          provider: "mock",
          input: ["text"],
          contextWindow: 32_000,
        },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [] },
    sessionFile: undefined,
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async () => {},
    steer: async () => {},
  } as any;
}

async function renderApp(width: number, height: number) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => ({}),
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={{
        showThinking: false,
        theme: "tokyonight",
        animations: false,
        workingRuleAnimation: "off",
        webSearch: false,
        writingStyle: "none",
        explanationStrength: "simple",
        checkMode: "off",
        checkModel: "mock/check",
        maxActiveSubagents: 10,
      }}
      searchProviders={[]}
      subagentManager={manager}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  return setup;
}

async function settle(setup: Awaited<ReturnType<typeof renderApp>>) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
}

describe("prompt input layout", () => {
  test("renders the header-bottom rule directly below StatusBar", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const lines = setup.captureCharFrame().split("\n");

    expect(lines[0]).toBe("─".repeat(70));
    expect(lines[1]).toContain("pum");
    expect(lines[2]).toBe("─".repeat(70));
  });

  test("uses concise contextual placeholders without control hints", () => {
    const placeholders = [
      promptPlaceholder({ busy: false, stashOpen: false }),
      promptPlaceholder({ activeAgentName: "worker", busy: false, stashOpen: false }),
      promptPlaceholder({ activeAgentName: "worker", busy: true, stashOpen: false }),
      promptPlaceholder({ busy: true, stashOpen: false }),
      promptPlaceholder({ busy: false, stashOpen: true }),
    ];

    expect(placeholders).toEqual([
      "Ask something…",
      "Message worker…",
      "Steer worker…",
      "Steer…",
      "Cache…",
    ]);
    expect(placeholders.every((placeholder) => !placeholder.includes("[") && !placeholder.includes("Ctrl")))
      .toBe(true);
  });

  test("moves the only prompt glyph through command suggestions", async () => {
    const setup = await renderApp(70, 20);

    await setup.mockInput.typeText("/");
    await settle(setup);
    let frame = setup.captureCharFrame();

    expect(frame).toContain("❯ /compress");
    expect(frame).not.toContain("> /compress");
    expect(frame.match(/❯/gu)).toHaveLength(1);

    setup.mockInput.pressArrow("down");
    await settle(setup);
    frame = setup.captureCharFrame();

    expect(frame).toContain("❯ /clear");
    expect(frame).not.toContain("❯ /compress");
    expect(frame.match(/❯/gu)).toHaveLength(1);

    await setup.mockInput.typeText(" ");
    await settle(setup);
    frame = setup.captureCharFrame();

    expect(frame).toContain("❯ / ");
    expect(frame.match(/❯/gu)).toHaveLength(1);
  });

  test("wraps four columns before the former terminal-edge boundary", async () => {
    const setup = await renderApp(40, 16);

    await setup.mockInput.typeText("123456789012345678901234567890ABCD");
    await settle(setup);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("  123456789012345678901234567890AB");
    expect(frame).toContain("❯ CD");
    expect(frame.split("\n").every((line) => line.length <= 40)).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";

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

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

function fakeSession() {
  return {
    sessionId: "main-session",
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
    sessionManager: {
      buildContextEntries: () => [],
      getEntries: () => [],
    },
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

async function renderApp(kittyKeyboard: boolean) {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <App
      session={fakeSession()}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => fakeSession()}
      loadSessions={async () => []}
      onSwitchSession={async () => fakeSession()}
      settings={settings}
      searchProviders={[]}
      subagentManager={{
        getAgents: () => [],
        subscribe: () => () => {},
        bindMainSession: async () => {},
      } as any}
    />,
  );
  await settle(setup);
  return setup;
}

describe("? opens help", () => {
  test("on a legacy terminal that sends the bare character", async () => {
    const setup = await renderApp(false);

    setup.mockInput.pressKey("?");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("Controls");
  });

  // Kitty encodes `?` as ESC[63u, so a raw `key.sequence === "?"` comparison
  // never matches and the character lands in the prompt instead.
  test("on a terminal using the kitty keyboard protocol", async () => {
    const setup = await renderApp(true);

    setup.mockInput.pressKey("?");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("Controls");
  });
});

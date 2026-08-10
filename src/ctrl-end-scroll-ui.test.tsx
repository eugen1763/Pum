import { afterEach, describe, expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
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

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

describe("transcript scrolling shortcuts", () => {
  test("Ctrl+End scrolls the transcript to the bottom", async () => {
    const transcriptRows = Array.from(
      { length: 30 },
      (_, index) => `transcript row ${index + 1}`,
    );
    const session = {
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
    const manager = {
      getAgents: () => [],
      subscribe: () => () => {},
      bindMainSession: async () => {},
    } as any;
    const setup = await createTestRenderer({
      width: 70,
      height: 14,
      kittyKeyboard: true,
    });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <App
        session={session}
        modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
        onNewSession={async () => session}
        loadSessions={async () => []}
        onSwitchSession={async () => session}
        settings={settings}
        searchProviders={[]}
        subagentManager={manager}
        startupWarnings={transcriptRows}
      />,
    );
    await settle(setup);

    const transcript = setup.renderer.root.findDescendantById("transcript-scrollbox");
    expect(transcript).toBeInstanceOf(ScrollBoxRenderable);
    const scrollbox = transcript as ScrollBoxRenderable;
    expect(scrollbox.scrollHeight).toBeGreaterThan(scrollbox.viewport.height);

    scrollbox.scrollTop = 0;
    await settle(setup);
    expect(scrollbox.scrollTop).toBe(0);

    setup.renderer.keyInput.processParsedKey({
      name: "end",
      ctrl: true,
      meta: false,
      shift: false,
      option: false,
      sequence: "\u001b[1;5F",
      number: false,
      raw: "\u001b[1;5F",
      eventType: "press",
      source: "kitty",
    });
    await settle(setup);

    expect(scrollbox.scrollTop).toBe(scrollbox.scrollHeight - scrollbox.viewport.height);
  });
});

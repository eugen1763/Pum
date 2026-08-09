import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./app";

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

describe("prompt input layout", () => {
  test("wraps four columns before the former terminal-edge boundary", async () => {
    const setup = await createTestRenderer({ width: 40, height: 16, kittyKeyboard: true });
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
          webSearch: false,
          writingStyle: "none",
          checkMode: false,
          checkModel: "mock/check",
        }}
        searchProviders={[]}
        subagentManager={manager}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();

    await setup.mockInput.typeText("123456789012345678901234567890ABCD");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("  123456789012345678901234567890AB");
    expect(frame).toContain("❯ CD");
    expect(frame.split("\n").every((line) => line.length <= 40)).toBe(true);
  });
});

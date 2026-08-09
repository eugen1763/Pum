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

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

describe("Settings keyboard flow", () => {
  test("filters in search, moves to rows, and uses slash to return to search", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const session = fakeSession();
    const manager = {
      getAgents: () => [],
      subscribe: () => () => {},
      bindMainSession: async () => {},
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
          workingRuleAnimation: "input-only",
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
    await settle(setup);

    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("check");
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Check mode");
    expect(frame).toContain("Check model");
    expect(frame).not.toContain("Theme");

    setup.mockInput.pressArrow("down");
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("› Check mode");

    await setup.mockInput.typeText("/");
    await settle(setup);
    await setup.mockInput.typeText("x");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("No matching settings");
  });
});

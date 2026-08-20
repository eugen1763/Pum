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

function fakeSession() {
  return {
    agent: {
      state: {
        model: { id: "unknown", provider: "unknown", input: ["text"], contextWindow: 1 },
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

async function renderApp(width = 72, height = 20) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const providers = [
    { id: "anthropic", name: "Anthropic", auth: { apiKey: { name: "API key", login() {}, resolve() {} } } },
    { id: "openai", name: "OpenAI", auth: { apiKey: { name: "API key", login() {}, resolve() {} } } },
  ];
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{
        getProviders: () => providers,
        getAvailableSnapshot: () => [],
        hasConfiguredAuth: (id: string) => id === "anthropic",
      } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
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

async function openProviders(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.mockInput.typeText("/providers");
  await settle(setup);
  setup.mockInput.pressEnter();
  await settle(setup);
  await settle(setup);
}

describe("the /providers command", () => {
  test("opens the provider list", async () => {
    const setup = await renderApp();

    await openProviders(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Providers");
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("OpenAI");
  });

  test("shows which providers hold a credential", async () => {
    const setup = await renderApp();

    await openProviders(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Anthropic — logged in");
    expect(frame).toContain("OpenAI — not logged in");
  });

  test("asks before deleting the selected provider", async () => {
    const setup = await renderApp();
    await openProviders(setup);

    await setup.mockInput.typeText("d");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Remove the stored credential for Anthropic");
  });

  test("closes on escape", async () => {
    const setup = await renderApp();
    await openProviders(setup);
    // Prove the popup was open, so this test cannot pass by never opening it.
    expect(setup.captureCharFrame()).toContain("Anthropic — logged in");

    setup.mockInput.pressEscape();
    await settle(setup);

    expect(setup.captureCharFrame()).not.toContain("Anthropic — logged in");
  });
});

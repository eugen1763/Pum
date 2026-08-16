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
  workingRuleAnimation: "input-only" as const,
  webSearch: false,
  writingStyle: "none" as const,
  explanationStrength: "simple" as const,
  checkMode: "off" as const,
  checkModel: "mock/check",
  maxActiveSubagents: 10,
};

const models = [
  {
    id: "mock-model",
    name: "Mock Model",
    provider: "mock",
    input: ["text"],
    contextWindow: 32_000,
  },
  {
    id: "check-model",
    name: "Check Model",
    provider: "mock",
    input: ["text"],
    contextWindow: 32_000,
  },
] as any;

function fakeSession() {
  return {
    agent: {
      state: {
        model: models[0],
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

async function renderApp(width = 80, height = 24) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
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
      modelRuntime={{
        getAvailableSnapshot: () => models,
        getProviders: () => [],
        getProvider: (id: string) => ({ id, name: "Mock Provider" }),
      } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={manager}
    />,
  );
  await settle(setup);
  return setup;
}

function expectSettingsOpen(frame: string) {
  expect(frame).toContain("Settings");
  expect(frame).toContain("Search");
}

function expectSettingsClosed(frame: string) {
  expect(frame).not.toContain("type to filter");
}

async function expectPromptFocus(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
) {
  await setup.mockInput.typeText(text);
  await settle(setup);
  expect(setup.captureCharFrame().split("\n").some((line) => line.includes(`❯ ${text}`))).toBe(true);
}

async function openSettings(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  setup.mockInput.pressKey("p", { ctrl: true });
  await settle(setup);
  expectSettingsOpen(setup.captureCharFrame());
}

async function openFilteredRow(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  query: string,
) {
  await setup.mockInput.typeText(query);
  await settle(setup);
  setup.mockInput.pressArrow("down");
  await settle(setup);
}

describe("Settings keyboard flow", () => {
  test("cycles through the new working animation labels", async () => {
    const setup = await renderApp();
    await openSettings(setup);
    await openFilteredRow(setup, "working animation");

    expect(setup.captureCharFrame()).toContain("Input sweep");
    for (const label of [
      "Coordinated sweep",
      "Sparkle trail",
      "Comet pair",
      "Electric spark",
      "Constellation",
      "Random constellation",
      "Energy transfer",
      "Off",
    ]) {
      setup.mockInput.pressArrow("right");
      await settle(setup);
      expect(setup.captureCharFrame()).toContain(label);
    }
  });

  test("closes focused search with one Escape and restores prompt focus", async () => {
    const setup = await renderApp();
    await openSettings(setup);

    setup.mockInput.pressEscape();
    await settle(setup);

    expectSettingsClosed(setup.captureCharFrame());
    await expectPromptFocus(setup, "after focused search");
  });

  test("closes from a highlighted row with one Escape", async () => {
    const setup = await renderApp();
    await openSettings(setup);

    setup.mockInput.pressArrow("down");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("› Theme");

    setup.mockInput.pressEscape();
    await settle(setup);

    expectSettingsClosed(setup.captureCharFrame());
    await expectPromptFocus(setup, "after highlighted row");
  });

  test("closes focused filtered results and empty results with one Escape", async () => {
    const setup = await renderApp();
    await openSettings(setup);

    await setup.mockInput.typeText("check");
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Check mode");
    expect(frame).not.toContain("Theme");

    setup.mockInput.pressEscape();
    await settle(setup);
    expectSettingsClosed(setup.captureCharFrame());

    await openSettings(setup);
    await setup.mockInput.typeText("no-such-setting");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("No matching settings");

    setup.mockInput.pressEscape();
    await settle(setup);
    expectSettingsClosed(setup.captureCharFrame());
    await expectPromptFocus(setup, "after filtered results");
  });

  test("steps back from model and check-model pages before closing", async () => {
    const setup = await renderApp();
    await openSettings(setup);

    await openFilteredRow(setup, "active search");
    expect(setup.captureCharFrame()).toContain("› Model");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Search provider or model");

    setup.mockInput.pressEscape();
    await settle(setup);
    expectSettingsOpen(setup.captureCharFrame());
    expect(setup.captureCharFrame()).toContain("› Model");
    setup.mockInput.pressEscape();
    await settle(setup);
    expectSettingsClosed(setup.captureCharFrame());

    await openSettings(setup);
    await openFilteredRow(setup, "separate verifier");
    expect(setup.captureCharFrame()).toContain("› Check model");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Check model");
    expect(setup.captureCharFrame()).toContain("Search provider or model");

    setup.mockInput.pressEscape();
    await settle(setup);
    expectSettingsOpen(setup.captureCharFrame());
    expect(setup.captureCharFrame()).toContain("› Check model");
    setup.mockInput.pressEscape();
    await settle(setup);
    expectSettingsClosed(setup.captureCharFrame());
    await expectPromptFocus(setup, "after model pages");
  });

  test("handles rapid open-close without a stale keyboard closure", async () => {
    const setup = await renderApp();

    setup.mockInput.pressKey("p", { ctrl: true });
    setup.mockInput.pressEscape();
    await settle(setup);

    expectSettingsClosed(setup.captureCharFrame());
    await expectPromptFocus(setup, "after rapid close");
  });

  test("closes focused search and restores prompt focus in a narrow terminal", async () => {
    const setup = await renderApp(48, 18);
    await openSettings(setup);
    expect(setup.captureCharFrame()).toContain("/ search");

    setup.mockInput.pressEscape();
    await settle(setup);

    expectSettingsClosed(setup.captureCharFrame());
    await expectPromptFocus(setup, "narrow focus");
  });
});

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
    agent: { state: { model: { id: "unknown", provider: "unknown", input: ["text"], contextWindow: 1 }, thinkingLevel: "off" } },
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

async function renderApp(width = 58, height = 14, readPastedText?: () => Promise<string>) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const providers = [
    { id: "anthropic", name: "Anthropic", auth: { oauth: { name: "Account", login() {}, refresh() {}, toAuth() {}, loginLabel: "Claude Pro" } } },
    { id: "local", name: "Local Models", auth: { apiKey: { name: "Environment key", resolve() {} } } },
    { id: "openai", name: "OpenAI", auth: { apiKey: { name: "API key", login() {}, resolve() {} } } },
  ];
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getProviders: () => providers, getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={{ getAgents: () => [], subscribe: () => () => {}, bindMainSession: async () => {} } as any}
      loginRequired
      readPastedText={readPastedText}
    />,
  );
  await settle(setup);
  return setup;
}

describe("provider search App keyboard flow", () => {
  test("filters metadata, moves to results, restores search, and closes once", async () => {
    const setup = await renderApp();
    expect(setup.captureCharFrame()).toContain("OpenAI");

    await setup.mockInput.typeText("claude oauth");
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Anthropic");
    expect(frame).not.toContain("OpenAI");
    expect(frame).not.toContain("Local Models");

    setup.mockInput.pressArrow("down");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("› Anthropic");

    await setup.mockInput.typeText("/");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("claude oauth");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Select a provider login method");

    await setup.mockInput.typeText("prompt focus restored");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ prompt focus restored");
  });

  test("keeps the selected filtered row visible in a short narrow App", async () => {
    const setup = await renderApp(36, 10);
    await setup.mockInput.typeText("api key");
    await settle(setup);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("OpenAI");
    expect(frame).toContain("/ search");
    expect(frame.split("\n").every((line) => Array.from(line).length <= 36)).toBe(true);
  });
  test("leaves bracketed provider-search paste with the focused input", async () => {
    const setup = await renderApp();
    setup.mockInput.pasteBracketedText("openai");
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("OpenAI");
    expect(frame).not.toContain("Anthropic");
    expect(frame).not.toContain("Local Models");
  });

  test("uses the Windows Ctrl+V fallback for custom URL and secret fields", async () => {
    const values = ["https://local.example.test/v1\r\n", "ui-pasted-secret"];
    const setup = await renderApp(58, 14, async () => values.shift() ?? "");
    for (let index = 0; index < 4; index++) setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pressKey("v", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("https://local.example.test/v1");
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pressKey("v", { ctrl: true });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("••••••••••••••••");
    expect(frame).not.toContain("ui-pasted-secret");
  });

  test("accepts bracketed paste in custom URL and secret fields", async () => {
    const setup = await renderApp();
    for (let index = 0; index < 4; index++) setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pasteBracketedText("https://bracketed.example.test/v1\r\n");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("https://bracketed.example.test/v1");
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pasteBracketedText("bracketed-secret");
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("••••••••••••••••");
    expect(frame).not.toContain("bracketed-secret");
  });
});

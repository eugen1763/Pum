import { afterEach, describe, expect, test } from "bun:test";
import { parseColor, TextareaRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { loadTheme } from "../src/theme";
import { sessionSettingsFileFor } from "../src/session-settings";

let destroy: (() => void) | undefined;
const directories: string[] = [];
afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;
async function settle(setup: Setup) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp() {
  const directory = mkdtempSync(join(tmpdir(), "pum-theme-ui-"));
  directories.push(directory);
  const sessionFile = join(directory, "session.jsonl");
  let prompts = 0;
  const session = {
    agent: { state: {
      model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
      thinkingLevel: "off",
    } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionFile, sessionId: "theme-session", subscribe: () => () => {},
    setThinkingLevel() {}, setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {},
    prompt: async () => { prompts++; }, steer: async () => {},
  } as any;
  const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true, exitOnCtrlC: false });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(<App
    session={session}
    modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []}
    onSwitchSession={async () => session}
    settings={{ showThinking: false, theme: "tokyonight", animations: false,
      workingRuleAnimation: "off", webSearch: false, writingStyle: "none",
      explanationStrength: "simple", checkMode: "off", checkModel: "mock/check",
      maxActiveSubagents: 10 }}
    searchProviders={[]}
    subagentManager={{ getAgents: () => [], subscribe: () => () => {},
      bindMainSession: async () => {}, setMaxActiveSubagents() {}, persistToolEvent() {} } as any}
    promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
    promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [],
      markExecutedMany: () => [], replace: () => [], remove: () => [] }}
  />);
  await settle(setup);
  return { setup, file: sessionSettingsFileFor(sessionFile), prompts: () => prompts };
}

function textarea(root: BaseRenderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root;
  for (const child of root.getChildren()) {
    const found = textarea(child);
    if (found) return found;
  }
  return undefined;
}

function expectTheme(setup: Setup, name: string) {
  expect(textarea(setup.renderer.root)!.textColor.equals(parseColor(loadTheme(name).fg))).toBe(true);
}

async function type(setup: Setup, text: string) {
  await setup.mockInput.typeText(text);
  await settle(setup);
}

describe("theme autocomplete previews", () => {
  for (const command of ["/theme", "/settings theme"]) {
    test(`${command} previews keyboard selection, restores on insertion, and commits on execution`, async () => {
      const { setup, file, prompts } = await renderApp();
      await type(setup, `${command} `);
      expectTheme(setup, "tokyonight");
      setup.mockInput.pressArrow("down");
      await settle(setup);
      expect(setup.captureCharFrame()).toContain("❯ gruvbox");
      expectTheme(setup, "gruvbox");
      expect(existsSync(file)).toBe(false);
      setup.mockInput.pressEnter();
      await settle(setup);
      expect(setup.captureCharFrame()).toContain(`${command} gruvbox`);
      expectTheme(setup, "tokyonight");
      expect(existsSync(file)).toBe(false);
      setup.mockInput.pressEnter();
      await settle(setup);
      expectTheme(setup, "gruvbox");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "gruvbox" });
      expect(prompts()).toBe(0);
    });
  }

  test("Escape and draft clearing restore the committed theme without a write", async () => {
    const { setup, file } = await renderApp();
    await type(setup, "/theme gru");
    expectTheme(setup, "gruvbox");
    setup.mockInput.pressEscape();
    await settle(setup);
    expectTheme(setup, "tokyonight");
    setup.mockInput.pressKey("c", { ctrl: true });
    await settle(setup);
    await type(setup, "/theme nor");
    expectTheme(setup, "nord");
    setup.mockInput.pressKey("c", { ctrl: true });
    await settle(setup);
    expectTheme(setup, "tokyonight");
    expect(existsSync(file)).toBe(false);
  });

  test("hover selects a theme and keyboard acceptance uses the hovered row", async () => {
    const { setup, file } = await renderApp();
    await type(setup, "/theme ");
    const y = setup.captureCharFrame().split("\n").findIndex((line) => line.trim() === "nord");
    expect(y).toBeGreaterThan(0);
    await setup.mockMouse.moveTo(4, y);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ nord");
    expectTheme(setup, "nord");
    expect(existsSync(file)).toBe(false);
    setup.mockInput.pressArrow("down");
    await settle(setup);
    expectTheme(setup, "dracula");
    setup.mockInput.pressArrow("up");
    await settle(setup);
    expectTheme(setup, "nord");
    setup.mockInput.pressEnter();
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "nord" });
  });

  test("opening Settings does not save the preview", async () => {
    const { setup, file } = await renderApp();
    await type(setup, "/theme gru");
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("tokyonight");
    expect(existsSync(file)).toBe(false);
  });

  test("Tab only inserts a name and cancelled previews restore the committed session theme", async () => {
    const { setup, file } = await renderApp();
    await type(setup, "/theme nord");
    setup.mockInput.pressEnter();
    await settle(setup);
    const committed = readFileSync(file, "utf8");
    await type(setup, "/theme ");
    expectTheme(setup, "tokyonight");
    setup.mockInput.pressTab();
    await settle(setup);
    expect(textarea(setup.renderer.root)!.plainText).toBe("/theme tokyonight");
    expectTheme(setup, "nord");
    expect(readFileSync(file, "utf8")).toBe(committed);
    setup.mockInput.pressKey("c", { ctrl: true });
    await settle(setup);
    await type(setup, "/settings theme gru");
    expectTheme(setup, "gruvbox");
    setup.mockInput.pressEscape();
    await settle(setup);
    expectTheme(setup, "nord");
    expect(readFileSync(file, "utf8")).toBe(committed);
  });

  test("invalid commands leave the theme unchanged", async () => {
    const { setup, file } = await renderApp();
    await type(setup, "/theme invalid");
    setup.mockInput.pressEnter();
    await settle(setup);
    expectTheme(setup, "tokyonight");
    expect(existsSync(file)).toBe(false);
  });
});

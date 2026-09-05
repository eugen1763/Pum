import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { saveSessionSettings, sessionSettingsFileFor, type SessionSettings } from "../src/session-settings";
import { getCheckModeConfig } from "../src/check-mode";
import { runtimeSettings } from "../src/runtime-settings";
import { webSearch } from "../src/web-search";
import { getWritingStyle } from "../src/writing-style";
import { getExplanationStrength } from "../src/explanation-strength";

let destroy: (() => void) | undefined;
const directories: string[] = [];
afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
  const directory = mkdtempSync(join(tmpdir(), "pum-session-settings-ui-"));
  directories.push(directory);
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    settingsManager: {
      setDefaultModelAndProvider() {},
      setDefaultThinkingLevel() {},
      flush: async () => {},
      drainErrors: () => [],
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionFile: join(directory, "session.jsonl"),
    sessionId: "current-session",
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
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(options: { overlay?: SessionSettings; forcedCheckPaths?: string[]; forcedSandboxMode?: "off" | "require"; replaceOnNew?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  if (options.overlay) saveSessionSettings(session.sessionFile, options.overlay);
  const sandboxModes: string[] = [];
  const limits: number[] = [];
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: async () => {},
    persistToolEvent() {},
    setMaxActiveSubagents(value: number) { limits.push(value); },
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => options.replaceOnNew ? fakeSession() : session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      forcedSandboxMode={options.forcedSandboxMode}
      forcedCheckPaths={options.forcedCheckPaths}
      onSandboxModeChange={(mode) => { sandboxModes.push(mode); }}
      searchProviders={[]}
      subagentManager={manager}
      promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
      promptStashStore={{
        load: () => [],
        append: () => [],
        markExecuted: () => [],
        markExecutedMany: () => [],
        replace: () => [],
        remove: () => [],
      }}
    />,
  );
  await settle(setup);
  return { setup, session, sandboxModes, limits };
}

/** Open Settings, leave the search box, and land on the first row. */
async function openSettings(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  setup.mockInput.pressKey("p", { ctrl: true });
  await settle(setup);
  setup.mockInput.pressArrow("down");
  await settle(setup);
}

describe("settings belong to the session", () => {
  test("attach applies the saved overlay to policy and presentation globals, preserving forced roots/sandbox", async () => {
    const { sandboxModes, limits } = await renderApp({
      overlay: { checkMode: "on", webSearch: true, sandboxMode: "off", writingStyle: "STE", explanationStrength: "detailed", maxActiveSubagents: 3 },
      forcedSandboxMode: "require", forcedCheckPaths: ["/forced-root"],
    });
    expect(getCheckModeConfig()).toMatchObject({ profile: "on", additionalPaths: ["/forced-root"] });
    expect(webSearch.enabled).toBe(true);
    expect(sandboxModes.at(-1)).toBe("require");
    expect(getWritingStyle()).toBe("STE");
    expect(getExplanationStrength()).toBe("detailed");
    expect(limits.at(-1)).toBe(3);
  });

  test("new session reapplies global defaults instead of leaving the prior overlay effective", async () => {
    const { setup } = await renderApp({ overlay: { checkMode: "on", webSearch: true, writingStyle: "STE", explanationStrength: "detailed" }, replaceOnNew: true });
    expect(getCheckModeConfig().profile).toBe("on");
    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(getCheckModeConfig().profile).toBe("off");
    expect(webSearch.enabled).toBe(false);
    expect(getWritingStyle()).toBe("none");
    expect(getExplanationStrength()).toBe("simple");
  });

  test("desired Check change persists immediately, but the visible pending/effective boundary waits for a worker", async () => {
    const { setup, session } = await renderApp({ overlay: { checkMode: "on" } });
    const release = runtimeSettings.begin({ role: "long-running worker" });
    try {
      setup.mockInput.pressKey("p", { ctrl: true });
      await settle(setup);
      await setup.mockInput.typeText("Check mode");
      await settle(setup);
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("right");
      await settle(setup);
      setup.mockInput.pressEscape();
      await settle(setup);
      // Off is global, so persisting desired Off removes the previous On overlay.
      expect(existsSync(sessionSettingsFileFor(session.sessionFile))).toBe(false);
      expect(getCheckModeConfig().profile).toBe("on");
      expect(setup.captureCharFrame()).toContain("Check off (effective on)");
      release();
      await settle(setup);
      expect(getCheckModeConfig().profile).toBe("off");
      expect(setup.captureCharFrame()).not.toContain("Pending until");
    } finally { release(); }
  });

  test("a change lands in the session companion file, not the global config", async () => {
    const { setup, session } = await renderApp();
    await openSettings(setup);

    setup.mockInput.pressArrow("right");
    await settle(setup);

    const file = sessionSettingsFileFor(session.sessionFile);
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    // Whatever the first row is, exactly that field moved - and nothing else.
    expect(Object.keys(stored).length).toBeGreaterThan(0);
    expect(Object.keys(stored)).not.toContain("checkPaths");
  });

  test("`s` promotes the session settings and clears the overrides", async () => {
    const { setup, session } = await renderApp();
    await openSettings(setup);
    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(existsSync(sessionSettingsFileFor(session.sessionFile))).toBe(true);

    setup.mockInput.pressKey("s");
    await settle(setup);

    // Nothing differs from global any more, so the companion file goes.
    expect(existsSync(sessionSettingsFileFor(session.sessionFile))).toBe(false);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("global defaults");
  });

  test("the footer advertises `s`", async () => {
    const { setup } = await renderApp();
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("s save");
  });

  test("`s` typed into the search box filters instead of saving", async () => {
    const { setup, session } = await renderApp();
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);

    // The search box owns the keyboard until it is left, so `s` is a character.
    await setup.mockInput.typeText("s");
    await settle(setup);
    expect(existsSync(sessionSettingsFileFor(session.sessionFile))).toBe(false);
    expect(setup.captureCharFrame()).not.toContain("global defaults");
  });
});

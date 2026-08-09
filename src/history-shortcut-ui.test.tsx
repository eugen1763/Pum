import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import type { SubagentSnapshot } from "./subagents/types";

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
    sessionFile: "/tmp/current-session.jsonl",
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

const agent: SubagentSnapshot = {
  id: "agent-1",
  name: "worker-one",
  task: "Test keyboard focus",
  status: "idle",
  worktree: {
    name: "worker-one",
    path: "/tmp/project/.pum/worktrees/worker-one",
    branch: "pum/worker-one",
    baseBranch: "main",
    baseCommit: "abc123",
  },
  parentAgentId: null,
  modelId: "mock/mock-model",
  thinkingLevel: "off",
  transcript: { lines: [], stream: null, pending: [] },
  startedAt: 1,
  updatedAt: 1,
  usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
};

type RenderOptions = {
  kittyKeyboard?: boolean;
  loginRequired?: boolean;
  agents?: SubagentSnapshot[];
  initialStash?: Array<{ text: string; executed: boolean }>;
};

async function renderApp(options: RenderOptions = {}) {
  const setup = await createTestRenderer({
    width: 90,
    height: 28,
    kittyKeyboard: options.kittyKeyboard ?? true,
  });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  let historyLoads = 0;
  let stash = options.initialStash ?? [];
  const manager = {
    getAgents: () => options.agents ?? [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => agent.worktree,
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{
        getAvailableSnapshot: () => [],
        getProviders: () => [],
      } as any}
      onNewSession={async () => session}
      loadSessions={async () => {
        historyLoads++;
        return [{
          path: "/tmp/older-session.jsonl",
          name: "Older session",
          firstMessage: "Earlier work",
          modified: new Date("2026-08-08T12:00:00Z"),
          messageCount: 4,
        }] as any;
      }}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={manager}
      loginRequired={options.loginRequired}
      promptHistoryStore={{
        load: () => [],
        append: () => [],
        remove: () => [],
      }}
      promptStashStore={{
        load: () => stash,
        append: (_cwd, prompt, executed = false) => {
          stash = [...stash, { text: prompt, executed }];
          return stash;
        },
        markExecuted: () => stash,
        markExecutedMany: () => stash,
        replace: (_cwd, index, prompt, executed) => {
          stash = stash.map((item, itemIndex) => itemIndex === index ? { text: prompt, executed } : item);
          return stash;
        },
        remove: (_cwd, index) => {
          stash = stash.filter((_, itemIndex) => itemIndex !== index);
          return stash;
        },
      }}
    />,
  );
  await settle(setup);
  return { setup, historyLoads: () => historyLoads };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

function expectInput(frame: string, text: string) {
  expect(frame.split("\n").some((line) => line.includes(`❯ ${text}`))).toBe(true);
}

describe("session history keyboard shortcuts", () => {
  test("opens with a distinguishable Ctrl+H and restores input focus after Escape", async () => {
    const { setup, historyLoads } = await renderApp();

    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(historyLoads()).toBe(1);
    expect(setup.captureCharFrame()).toContain("Session history");
    expect(setup.captureCharFrame()).toContain("Older session");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Session history");

    await setup.mockInput.typeText("after close");
    await settle(setup);
    expectInput(setup.captureCharFrame(), "after close");
  });

  test("opens through /history and clears the command input", async () => {
    const { setup, historyLoads } = await renderApp();

    await setup.mockInput.typeText("/history");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(historyLoads()).toBe(1);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Session history");
    expect(frame).not.toContain("❯ /history");
  });

  test("plain Backspace edits non-empty input and does nothing on empty input", async () => {
    const { setup, historyLoads } = await renderApp();

    setup.mockInput.pressBackspace();
    await settle(setup);
    expect(historyLoads()).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("Session history");

    await setup.mockInput.typeText("alpha");
    setup.mockInput.pressBackspace();
    await settle(setup);
    expectInput(setup.captureCharFrame(), "alph");
    expect(historyLoads()).toBe(0);
  });

  test("Ctrl+Backspace and Ctrl+W delete the previous word", async () => {
    const { setup, historyLoads } = await renderApp();

    await setup.mockInput.typeText("alpha beta");
    setup.mockInput.pressBackspace({ ctrl: true });
    await settle(setup);
    expectInput(setup.captureCharFrame(), "alpha ");

    await setup.mockInput.typeText("gamma");
    setup.mockInput.pressKey("w", { ctrl: true });
    await settle(setup);
    expectInput(setup.captureCharFrame(), "alpha ");
    expect(historyLoads()).toBe(0);
  });

  test("keeps raw ^H as Backspace when Ctrl+H and Backspace are byte-identical", async () => {
    const { setup, historyLoads } = await renderApp({ kittyKeyboard: false });

    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(historyLoads()).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("Session history");

    await setup.mockInput.typeText("alpha");
    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expectInput(setup.captureCharFrame(), "alph");
    expect(historyLoads()).toBe(0);
  });

  test("opens globally from Settings and cache, then closes back to the input", async () => {
    const { setup, historyLoads } = await renderApp({
      initialStash: [{ text: "cached task", executed: false }],
    });

    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Settings");

    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Session history");
    expect(setup.captureCharFrame()).not.toContain("Settings");

    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("cached task");

    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(historyLoads()).toBe(2);
    expect(setup.captureCharFrame()).toContain("Session history");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("cached task");
  });

  test("does not steal Ctrl+H from Help, Login, or the agent selector", async () => {
    const { setup, historyLoads } = await renderApp({ agents: [agent] });

    await setup.mockInput.typeText("?");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Controls");
    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Controls");
    expect(historyLoads()).toBe(0);

    setup.mockInput.pressEscape();
    setup.mockInput.pressKey("l", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Agents");
    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Agents");
    expect(historyLoads()).toBe(0);
  });

  test("does not steal Ctrl+H from Login", async () => {
    const { setup, historyLoads } = await renderApp({ loginRequired: true });

    expect(setup.captureCharFrame()).toContain("Login");
    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Login");
    expect(setup.captureCharFrame()).not.toContain("Session history");
    expect(historyLoads()).toBe(0);
  });
});

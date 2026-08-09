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

function fakeSession(options: {
  id?: string;
  path?: string;
  transcript?: string;
  onPrompt?: (text: string) => void;
} = {}) {
  const entries = options.transcript ? [{
    type: "message",
    message: { role: "user", content: options.transcript },
  }] : [];
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
      buildContextEntries: () => entries,
      getEntries: () => entries,
    },
    sessionFile: options.path ?? "/tmp/current-session.jsonl",
    sessionId: options.id ?? "current-session",
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async (text: string) => options.onPrompt?.(text),
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
  width?: number;
  height?: number;
  kittyKeyboard?: boolean;
  loginRequired?: boolean;
  agents?: SubagentSnapshot[];
  initialStash?: Array<{ text: string; executed: boolean }>;
  session?: ReturnType<typeof fakeSession>;
  switchSession?: (path: string) => Promise<ReturnType<typeof fakeSession> | null>;
  newSession?: () => Promise<ReturnType<typeof fakeSession> | null>;
  sendUserMessage?: (agentId: string, text: string) => Promise<void>;
};

async function renderApp(options: RenderOptions = {}) {
  const setup = await createTestRenderer({
    width: options.width ?? 90,
    height: options.height ?? 28,
    kittyKeyboard: options.kittyKeyboard ?? true,
  });
  destroy = () => setup.renderer.destroy();
  const session = options.session ?? fakeSession();
  let historyLoads = 0;
  let stash = options.initialStash ?? [];
  const manager = {
    getAgents: () => options.agents ?? [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: options.sendUserMessage ?? (async () => {}),
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
      onNewSession={options.newSession ?? (async () => session)}
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
      onSwitchSession={options.switchSession ?? (async () => session)}
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

  test("restores prompt focus when a narrow-layout switch is cancelled", async () => {
    let switches = 0;
    const currentPrompts: string[] = [];
    const { setup } = await renderApp({
      width: 44,
      height: 18,
      session: fakeSession({
        transcript: "current transcript",
        onPrompt: (text) => currentPrompts.push(text),
      }),
      switchSession: async () => {
        switches++;
        return null;
      },
    });

    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(switches).toBe(1);
    expect(setup.captureCharFrame()).not.toContain("Session history");
    await setup.mockInput.typeText("after cancelled switch");
    await settle(setup);
    expectInput(setup.captureCharFrame(), "after cancelled switch");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(currentPrompts).toEqual(["after cancelled switch"]);
  });

  test("keeps the current session and prompt focus when /new is cancelled", async () => {
    let replacements = 0;
    const currentPrompts: string[] = [];
    const { setup } = await renderApp({
      session: fakeSession({
        transcript: "current transcript",
        onPrompt: (text) => currentPrompts.push(text),
      }),
      newSession: async () => {
        replacements++;
        return null;
      },
    });

    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(replacements).toBe(1);
    await setup.mockInput.typeText("after cancelled new");
    await settle(setup);
    expectInput(setup.captureCharFrame(), "after cancelled new");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(currentPrompts).toEqual(["after cancelled new"]);
  });

  test("returns from a child transcript to main and routes the restored draft to the switched session", async () => {
    const switchedPrompts: string[] = [];
    const childPrompts: string[] = [];
    const switched = fakeSession({
      id: "older-session",
      path: "/tmp/older-session.jsonl",
      transcript: "switched main transcript",
      onPrompt: (text) => switchedPrompts.push(text),
    });
    const child = {
      ...agent,
      transcript: {
        lines: [{ kind: "text", role: "assistant", text: "child transcript" }],
        stream: null,
        pending: [],
      },
    } as SubagentSnapshot;
    const { setup } = await renderApp({
      session: fakeSession({ transcript: "old main transcript" }),
      agents: [child],
      switchSession: async () => switched,
      sendUserMessage: async (_agentId, text) => {
        childPrompts.push(text);
      },
    });

    await setup.mockInput.typeText("main draft");
    setup.mockInput.pressKey("l", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("child transcript");

    await setup.mockInput.typeText("child draft");
    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("switched main transcript");
    expect(frame).not.toContain("child transcript");
    expectInput(frame, "main draft");

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(switchedPrompts).toEqual(["main draft"]);
    expect(childPrompts).toEqual([]);
  });
});

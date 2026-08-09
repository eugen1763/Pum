import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../app";
import type { SubagentSnapshot } from "./types";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const snapshot: SubagentSnapshot = {
  id: "agent-1",
  name: "worker-one",
  task: "Review the parser",
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
  transcript: {
    lines: [{
      kind: "agent-message",
      sender: "main",
      recipient: "worker-one",
      text: "Subagent transcript",
    }],
    stream: null,
    pending: [],
  },
  startedAt: 1,
  updatedAt: 1,
  usage: { tokens: 1200, cost: 0.25, contextPct: 40 },
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

function memoryStores(initial: Array<{ text: string; executed: boolean }> = []) {
  let stash = initial.map((prompt) => ({ ...prompt }));
  let history: string[] = [];
  return {
    stash: {
      load: () => stash,
      append: (_cwd: string, prompt: string, executed = false) => {
        stash = [...stash, { text: prompt, executed }];
        return stash;
      },
      markExecuted: (_cwd: string, index: number) => {
        stash = stash.map((prompt, itemIndex) => itemIndex === index ? { ...prompt, executed: true } : prompt);
        return stash;
      },
      markExecutedMany: (_cwd: string, indices: Iterable<number>) => {
        const selected = new Set(indices);
        stash = stash.map((prompt, index) => selected.has(index) ? { ...prompt, executed: true } : prompt);
        return stash;
      },
      replace: (_cwd: string, index: number, prompt: string, executed: boolean) => {
        stash = stash.map((item, itemIndex) => itemIndex === index ? { text: prompt, executed } : item);
        return stash;
      },
      remove: (_cwd: string, index: number) => {
        stash = stash.filter((_, itemIndex) => itemIndex !== index);
        return stash;
      },
    },
    history: {
      load: () => history,
      append: (_cwd: string, prompt: string) => {
        history = [...history, prompt];
        return history;
      },
      remove: (_cwd: string, prompt: string) => {
        history = history.filter((item) => item !== prompt);
        return history;
      },
    },
    getStash: () => stash,
  };
}

async function renderCacheApp(options: {
  initialStash?: Array<{ text: string; executed: boolean }>;
  onMainPrompt?: (prompt: string) => void;
  onSubagentMessage?: (prompt: string) => void;
}) {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const stores = memoryStores(options.initialStash);
  const session = fakeSession();
  session.prompt = async (prompt: string) => options.onMainPrompt?.(prompt);
  const manager = {
    getAgents: () => [snapshot],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    sendUserMessage: async (_id: string, prompt: string) => options.onSubagentMessage?.(prompt),
    abortAgent: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => snapshot.worktree,
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
        workingRuleAnimation: "off",
        webSearch: false,
        writingStyle: "none",
        explanationStrength: "simple",
        checkMode: false,
        checkModel: "mock/check",
      }}
      searchProviders={[]}
      subagentManager={manager}
      promptHistoryStore={stores.history}
      promptStashStore={stores.stash}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return { setup, stores };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

describe("subagent transcript UI", () => {
  test("cycles forward and backward with header notice", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const manager = {
      getAgents: () => [snapshot],
      subscribe: () => () => {},
      bindMainSession: async () => {},
      sendUserMessage: async () => {},
      abortAgent: async () => {},
      persistToolEvent() {},
      createStandaloneWorktree: async () => snapshot.worktree,
    } as any;
    const session = fakeSession();
    const root = createRoot(setup.renderer);
    root.render(
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
          checkMode: false,
          checkModel: "mock/check",
        }}
        searchProviders={[]}
        subagentManager={manager}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("◇ 1");

    setup.mockInput.pressTab({ shift: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("worker-one");
    expect(setup.captureCharFrame()).toContain("Subagent transcript");
    expect(setup.captureCharFrame()).toContain("1.2k · $0.250 · 40%");

    setup.mockInput.pressTab({ shift: true, ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("Subagent transcript");
  });

  test("opens the agent tree and selects with Ctrl+L navigation", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const child = {
      ...snapshot,
      id: "agent-2",
      name: "child-worker",
      parentAgentId: snapshot.id,
      startedAt: 2,
      transcript: {
        lines: [{
          kind: "agent-message" as const,
          sender: "worker-one",
          recipient: "child-worker",
          text: "Child transcript",
        }],
        stream: null,
        pending: [],
      },
    };
    const manager = {
      getAgents: () => [snapshot, child],
      subscribe: () => () => {},
      bindMainSession: async () => {},
      sendUserMessage: async () => {},
      abortAgent: async () => {},
      persistToolEvent() {},
      createStandaloneWorktree: async () => snapshot.worktree,
    } as any;
    const session = fakeSession();
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
          workingRuleAnimation: "off",
          webSearch: false,
          writingStyle: "none",
          explanationStrength: "simple",
          checkMode: false,
          checkModel: "mock/check",
        }}
        searchProviders={[]}
        subagentManager={manager}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();

    setup.mockInput.pressKey("l", { ctrl: true });
    const popup = await setup.waitForFrame((frame) => frame.includes("Agents"));
    expect(popup).toContain("Agents");
    expect(popup.indexOf("child-worker")).toBeGreaterThan(popup.indexOf("worker-one"));

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("right");
    const selectedFrame = await setup.waitForFrame((frame) => frame.includes("Child transcript"));
    expect(selectedFrame).not.toContain("→/enter open");
  });

  test("caches a selected subagent draft without sending it", async () => {
    let mainPrompts = 0;
    let subagentMessages = 0;
    const { setup, stores } = await renderCacheApp({
      onMainPrompt: () => { mainPrompts++; },
      onSubagentMessage: () => { subagentMessages++; },
    });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await setup.mockInput.typeText("cache this worker draft");
    setup.mockInput.pressEnter({ meta: true });
    await settle(setup);

    expect(stores.getStash()).toEqual([{ text: "cache this worker draft", executed: false }]);
    expect(mainPrompts).toBe(0);
    expect(subagentMessages).toBe(0);
    expect(setup.captureCharFrame()).toContain("Message worker-one…");
  });

  test("loads cache text into the subagent draft and preserves both transcript drafts", async () => {
    const { setup } = await renderCacheApp({
      initialStash: [{ text: "loaded worker task", executed: false }],
    });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);
    setup.mockInput.pressArrow("up");
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);
    await setup.mockInput.typeText(" plus edits");

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await setup.mockInput.typeText("main draft");
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("loaded worker task plus edits");

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("main draft");
  });

  test("routes a selected cache batch through the main session", async () => {
    const mainPrompts: string[] = [];
    const subagentMessages: string[] = [];
    const { setup, stores } = await renderCacheApp({
      initialStash: [
        { text: "task one", executed: false },
        { text: "task two", executed: false },
      ],
      onMainPrompt: (prompt) => mainPrompts.push(prompt),
      onSubagentMessage: (prompt) => subagentMessages.push(prompt),
    });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);
    setup.mockInput.pressArrow("down", { shift: true });
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(mainPrompts).toHaveLength(1);
    expect(mainPrompts[0]).toContain("<task 1>\ntask one\n</task 1>");
    expect(mainPrompts[0]).toContain("<task 2>\ntask two\n</task 2>");
    expect(subagentMessages).toEqual([]);
    expect(stores.getStash().every((prompt) => prompt.executed)).toBe(true);
  });

  test("requires two Escape presses before aborting the selected subagent", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    let aborts = 0;
    const runningSnapshot = { ...snapshot, status: "running" as const };
    const manager = {
      getAgents: () => [runningSnapshot],
      subscribe: () => () => {},
      bindMainSession: async () => {},
      sendUserMessage: async () => {},
      abortAgent: async () => { aborts++; },
      persistToolEvent() {},
      createStandaloneWorktree: async () => runningSnapshot.worktree,
    } as any;
    const session = fakeSession();
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
          checkMode: false,
          checkModel: "mock/check",
        }}
        searchProviders={[]}
        subagentManager={manager}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();

    setup.mockInput.pressTab({ shift: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    const armedFrame = await setup.waitForFrame((frame) => frame.includes("esc again to cancel"));
    expect(aborts).toBe(0);
    expect(armedFrame).toContain("esc again to cancel");

    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborts).toBe(1);
  });
});

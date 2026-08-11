import { afterEach, describe, expect, test } from "bun:test";
import { MarkdownRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { App } from "../app";
import { MessageCacheController } from "../message-cache";
import { formatWorkingDirectory } from "../status-metadata";
import type { SubagentSnapshot } from "./types";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function markdownContent(root: BaseRenderable): string[] {
  const content: string[] = [];
  const visit = (node: BaseRenderable) => {
    if (node instanceof MarkdownRenderable) content.push(node.content);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return content;
}

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
  usage: { outgoing: 1200, incoming: 345, cacheRead: 2400, cost: 0.25, contextPct: 40 },
};

function fakeSession(entries: any[] = []) {
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
    sessionFile: undefined,
    sessionId: "main-session",
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
  onMainPrompt?: (prompt: string) => unknown | Promise<unknown>;
  onSubagentMessage?: (id: string, prompt: string) => unknown | Promise<unknown>;
  messageCacheController?: MessageCacheController;
}) {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const stores = memoryStores(options.initialStash);
  const session = fakeSession();
  session.prompt = async (prompt: string) => { await options.onMainPrompt?.(prompt); };
  const manager = {
    getAgents: () => [snapshot],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    sendUserMessage: async (id: string, prompt: string) => { await options.onSubagentMessage?.(id, prompt); },
    abortAgent: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => snapshot.worktree,
  } as any;
  flushSync(() => createRoot(setup.renderer).render(
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
        checkMode: "off",
        checkModel: "mock/check",
        maxActiveSubagents: 10,
      }}
      searchProviders={[]}
      subagentManager={manager}
      promptHistoryStore={stores.history}
      promptStashStore={stores.stash}
      messageCacheController={options.messageCacheController}
    />,
  ));
  await setup.renderOnce();
  await setup.flush();
  return { setup, stores };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce();
  await setup.flush();
}

async function settleUntil(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  condition: () => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await settle(setup);
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("UI did not settle to the expected state");
}

async function press(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  action: () => void,
) {
  flushSync(action);
  await settle(setup);
}

describe("subagent transcript UI", () => {
  test("restores main usage and resets it for a new session", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const resumed = fakeSession([{
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "resumed" }],
        usage: {
          input: 1200,
          output: 345,
          cacheRead: 2400,
          cacheWrite: 100,
          cost: { total: 0.25 },
        },
      },
    }]);
    const fresh = fakeSession();
    let resolveNewSession: ((session: ReturnType<typeof fakeSession>) => void) | undefined;
    const manager = {
      getAgents: () => [],
      subscribe: () => () => {},
      bindMainSession: async () => {},
      abortAgent: async () => {},
      persistToolEvent() {},
      createStandaloneWorktree: async () => snapshot.worktree,
    } as any;
    flushSync(() => createRoot(setup.renderer).render(
      <App
        session={resumed}
        modelRuntime={{ getAvailableSnapshot: () => [] } as any}
        onNewSession={() => new Promise((resolve) => {
          resolveNewSession = resolve;
        })}
        loadSessions={async () => []}
        onSwitchSession={async () => resumed}
        settings={{
          showThinking: false,
          theme: "tokyonight",
          animations: false,
          workingRuleAnimation: "off",
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
    ));
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("↑ 1.3k · ↓ 345 · ↺ 2.4k · $0.250 · 12%");

    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(resolveNewSession).toBeDefined();
    const pendingFrame = setup.captureCharFrame();
    expect(pendingFrame).toContain("↑ 1.3k");
    expect(pendingFrame).toContain("↓ 345");
    expect(pendingFrame).toContain("12%");

    resolveNewSession!(fresh);
    await settleUntil(setup, () => !setup.captureCharFrame().includes("↑ 1.3k"));
    const freshFrame = setup.captureCharFrame();
    expect(freshFrame).not.toContain("↑ 1.3k");
    expect(freshFrame).not.toContain("↓ 345");
    expect(freshFrame).not.toContain("↺ 2.4k");
    expect(freshFrame).not.toContain("$0.250");
    expect(freshFrame).not.toContain("12%");
  });

  test("sends a direct selected-subagent prompt only through the manager", async () => {
    const mainPrompts: string[] = [];
    const subagentMessages: Array<{ id: string; prompt: string }> = [];
    let resolveSubagentDelivery!: () => void;
    const subagentDelivery = new Promise<void>((resolve) => {
      resolveSubagentDelivery = resolve;
    });
    const { setup } = await renderCacheApp({
      onMainPrompt: (prompt) => mainPrompts.push(prompt),
      onSubagentMessage: (id, prompt) => {
        subagentMessages.push({ id, prompt });
        resolveSubagentDelivery();
      },
    });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Message worker-one…");

    await setup.mockInput.typeText("Inspect the retry path.");
    setup.mockInput.pressEnter();
    await subagentDelivery;
    await settle(setup);

    expect(subagentMessages).toEqual([{
      id: "agent-1",
      prompt: "Inspect the retry path.",
    }]);
    expect(mainPrompts).toEqual([]);
  });

  test("does not route empty or main-transcript prompts to a subagent", async () => {
    const mainPrompts: string[] = [];
    const subagentMessages: string[] = [];
    const { setup } = await renderCacheApp({
      onMainPrompt: (prompt) => mainPrompts.push(prompt),
      onSubagentMessage: (_id, prompt) => subagentMessages.push(prompt),
    });

    setup.mockInput.pressEnter();
    await settle(setup);
    await setup.mockInput.typeText("Coordinate from main.");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(mainPrompts).toEqual(["Coordinate from main."]);
    expect(subagentMessages).toEqual([]);
  });

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
    flushSync(() => root.render(
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
    ));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("◇ 1");

    setup.mockInput.pressTab({ shift: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("worker-one");
    expect(markdownContent(setup.renderer.root)).toContain("Subagent transcript");
    const childFrame = setup.captureCharFrame();
    expect(childFrame).toContain(`${formatWorkingDirectory(process.cwd())} · pum/worker-one`);
    expect(childFrame).toContain("↑ 1.2k · ↓ 345 · 40%");
    expect(childFrame).not.toContain("↺ 2.4k");
    expect(childFrame).not.toContain("$0.250");

    setup.mockInput.pressTab({ shift: true, ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(markdownContent(setup.renderer.root)).not.toContain("Subagent transcript");
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
    flushSync(() => createRoot(setup.renderer).render(
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
          checkMode: "off",
          checkModel: "mock/check",
          maxActiveSubagents: 10,
        }}
        searchProviders={[]}
        subagentManager={manager}
      />,
    ));
    await settle(setup);

    await press(setup, () => setup.mockInput.pressKey("l", { ctrl: true }));
    const popup = setup.captureCharFrame();
    expect(popup).toContain("Agents");
    expect(popup.indexOf("child-worker")).toBeGreaterThan(popup.indexOf("worker-one"));

    await press(setup, () => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("right");
    });
    const selectedFrame = setup.captureCharFrame();
    expect(selectedFrame).toContain("Message child-worker…");
    expect(selectedFrame).not.toContain("→/enter open");
    expect(markdownContent(setup.renderer.root)).toContain("Child transcript");
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
      onSubagentMessage: (_id, prompt) => subagentMessages.push(prompt),
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

  test("routes model cache sends through the same main batch and child paths", async () => {
    const entries = [
      { id: "cache-1", text: "task one", executed: false, owner: { type: "user" as const } },
      { id: "cache-2", text: "task two", executed: false, owner: { type: "user" as const } },
    ];
    let history: string[] = [];
    const store = {
      loadStash: () => entries,
      addAgentStash: () => { throw new Error("not used"); },
      removeStashById: () => { throw new Error("not used"); },
      executeStashByIds: (_cwd: string, ids: string[]) => {
        const selected = ids.map((id) => entries.find((entry) => entry.id === id)!);
        history = [...history, ...selected.map((entry) => entry.text)];
        for (const entry of entries) {
          if (ids.includes(entry.id)) entry.executed = true;
        }
        return { entries: selected, state: { history, stash: entries } };
      },
    } as any;
    const controller = new MessageCacheController("/tmp/project", store);
    const mainPrompts: string[] = [];
    const subagentMessages: string[] = [];
    const { setup } = await renderCacheApp({
      messageCacheController: controller,
      onMainPrompt: (prompt) => mainPrompts.push(prompt),
      onSubagentMessage: (_id, prompt) => subagentMessages.push(prompt),
    });
    await setup.mockInput.typeText("keep main draft");

    await controller.send(
      { kind: "subagent", id: "agent-1", name: "worker-one" },
      ["cache-2", "cache-1", "cache-2"],
    );
    await settle(setup);

    expect(mainPrompts).toHaveLength(1);
    expect(mainPrompts[0]).toContain("<task 1>\ntask two\n</task 1>");
    expect(mainPrompts[0]).toContain("<task 2>\ntask one\n</task 2>");
    expect(mainPrompts[0]).toContain("<task 3>\ntask two\n</task 3>");
    expect(subagentMessages).toEqual([]);
    expect(setup.captureCharFrame()).toContain("keep main draft");
    controller.releaseRequester({ kind: "subagent", id: "agent-1" });
    controller.releaseRequester({ kind: "main", id: "main-session" });

    await controller.send(
      { kind: "subagent", id: "agent-1", name: "worker-one" },
      ["cache-1"],
    );
    await settle(setup);
    expect(subagentMessages).toEqual(["task one"]);
  });

  test("keeps model cache entries pending after failed main and child delivery", async () => {
    const entries = [
      { id: "cache-main", text: "main task", executed: false, owner: { type: "user" as const } },
      { id: "cache-child", text: "child task", executed: false, owner: { type: "user" as const } },
    ];
    const store = {
      loadStash: () => entries,
      addAgentStash: () => { throw new Error("not used"); },
      removeStashById: () => { throw new Error("not used"); },
      executeStashByIds: (_cwd: string, ids: string[]) => {
        const selected = ids.map((id) => entries.find((entry) => entry.id === id)!);
        for (const entry of entries) if (ids.includes(entry.id)) entry.executed = true;
        return {
          entries: selected,
          state: { history: selected.map((entry) => entry.text), stash: entries },
        };
      },
    } as any;
    const controller = new MessageCacheController("/tmp/project", store);
    const { setup } = await renderCacheApp({
      messageCacheController: controller,
      onMainPrompt: async () => { throw new Error("main enqueue failed"); },
      onSubagentMessage: async () => { throw new Error("child enqueue failed"); },
    });

    await expect(controller.send(
      { kind: "main", id: "main-session", name: "main" },
      ["cache-main"],
    )).rejects.toThrow("main enqueue failed");
    await expect(controller.send(
      { kind: "subagent", id: "agent-1", name: "worker-one" },
      ["cache-child"],
    )).rejects.toThrow("child enqueue failed");
    await settle(setup);

    expect(entries.map((entry) => entry.executed)).toEqual([false, false]);
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
    flushSync(() => createRoot(setup.renderer).render(
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
    ));
    await settle(setup);

    await press(setup, () => setup.mockInput.pressTab({ shift: true }));
    expect(setup.captureCharFrame()).toContain("Steer worker-one…");

    await press(setup, () => setup.mockInput.pressEscape());
    const armedFrame = setup.captureCharFrame();
    expect(aborts).toBe(0);
    expect(armedFrame).toContain("esc again to cancel");

    await press(setup, () => setup.mockInput.pressEscape());
    expect(aborts).toBe(1);
  });
});

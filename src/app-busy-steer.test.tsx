import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, RenderErrorBoundary } from "./app";
import * as settingsModule from "./settings";
import { SpawnPreviewManager } from "./subagents/spawn-preview";
import { loadTheme, PRESET_NAMES } from "./theme";

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

const child = {
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
  transcript: { lines: [], stream: null, pending: [] },
  startedAt: 1,
  updatedAt: 1,
  usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type Calls = {
  prompts: string[];
  steers: string[];
  childMessages: Array<{ id: string; text: string }>;
};

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
        stash = stash.map((prompt, item) => item === index ? { ...prompt, executed: true } : prompt);
        return stash;
      },
      markExecutedMany: (_cwd: string, indices: Iterable<number>) => {
        const selected = new Set(indices);
        stash = stash.map((prompt, index) => selected.has(index) ? { ...prompt, executed: true } : prompt);
        return stash;
      },
      replace: (_cwd: string, index: number, prompt: string, executed: boolean) => {
        stash = stash.map((item, position) => position === index ? { text: prompt, executed } : item);
        return stash;
      },
      remove: (_cwd: string, index: number) => {
        stash = stash.filter((_, position) => position !== index);
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

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 5));
  flushSync();
  await setup.renderOnce();
  await setup.flush();
}

type RenderOptions = {
  agents?: any[];
  stash?: Array<{ text: string; executed: boolean }>;
  compact?: () => Promise<{ tokensBefore: number }>;
  onNewSession?: () => Promise<any>;
  onPrompt?: (text: string) => Promise<void>;
  captureImage?: () => Promise<{ path: string; mimeType: string }>;
  spawnPreviewManager?: SpawnPreviewManager;
};

async function renderApp(options: RenderOptions = {}) {
  const setup = await createTestRenderer({ width: 90, height: 24, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const calls: Calls = { prompts: [], steers: [], childMessages: [] };
  const stores = memoryStores(options.stash);
  const session = {
    sessionId: "main-session",
    sessionFile: undefined,
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text", "image"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: options.compact ?? (async () => ({ tokensBefore: 0 })),
    prompt: async (text: string) => {
      calls.prompts.push(text);
      await options.onPrompt?.(text);
    },
    steer: async (text: string) => { calls.steers.push(text); },
  } as any;
  const manager = {
    getAgents: () => options.agents ?? [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    persistToolEvent() {},
    recallQueuedUserMessage: async () => null,
    sendUserMessage: async (id: string, text: string) => { calls.childMessages.push({ id, text }); },
    createStandaloneWorktree: async () => child.worktree,
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={options.onNewSession ?? (async () => session)}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={manager}
      spawnPreviewManager={options.spawnPreviewManager}
      captureImage={options.captureImage}
      promptHistoryStore={stores.history}
      promptStashStore={stores.stash}
    />,
  );
  await settle(setup);
  return { setup, calls, stores };
}

describe("prompt delivery while the interface is busy", () => {
  test("sends a prompt typed during /compress to the idle agent, never to steer", async () => {
    const compaction = deferred<{ tokensBefore: number }>();
    const { setup, calls } = await renderApp({ compact: () => compaction.promise });

    await setup.mockInput.typeText("/compress");
    setup.mockInput.pressEnter();
    await settle(setup);

    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(calls.prompts).toEqual(["hello"]);
    expect(calls.steers).toEqual([]);
    compaction.resolve({ tokensBefore: 0 });
    await settle(setup);
  });

  test("refuses a prompt while the session is being replaced and keeps the draft", async () => {
    const replacement = deferred<undefined>();
    const { setup, calls } = await renderApp({ onNewSession: () => replacement.promise });

    await setup.mockInput.typeText("/clear");
    setup.mockInput.pressEnter();
    await settle(setup);

    await setup.mockInput.typeText("do not lose me");
    setup.mockInput.pressEnter();
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("wait for the session change to finish before sending");
    // The text stays in the draft, so a resend costs nothing.
    expect(frame).toContain("do not lose me");
    expect(calls.prompts).toEqual([]);
    expect(calls.steers).toEqual([]);

    replacement.resolve(undefined);
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls.prompts).toEqual(["do not lose me"]);
  });
});

describe("slash commands in a subagent view", () => {
  test("neither suggests nor completes a command into a child message", async () => {
    const { setup, calls } = await renderApp({ agents: [child] });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Message worker-one…");

    await setup.mockInput.typeText("/sta");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("/stats");

    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls.childMessages).toEqual([{ id: "agent-1", text: "/sta" }]);
  });
});

describe("spawn preview and the current view", () => {
  test("shows the popup for the selected view even with an attached image", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-spawn-preview-"));
    const imagePath = join(directory, "image.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const preview = new SpawnPreviewManager();
    try {
      const { setup } = await renderApp({
        spawnPreviewManager: preview,
        captureImage: async () => ({ path: imagePath, mimeType: "image/png" }),
      });

      setup.mockInput.pressKey("v", { meta: true });
      await settle(setup);
      expect(setup.captureCharFrame()).toContain("[Image #1]");

      let resolved = false;
      const result = preview.request(
        { sessionId: "main-session", agentId: null, name: "main" },
        { task: "Check the parser", modelId: "mock/model", thinkingLevel: "off" },
      );
      void result.then(() => { resolved = true; });
      await settle(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Spawn preview");
      expect(frame).not.toContain("before switching agents");
      expect(resolved).toBe(false);

      preview.cancel();
      await expect(result).resolves.toEqual({ approved: false, note: "", reason: "cancelled" });
      await settle(setup);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("settings steps in one React batch", () => {
  const realSaveSettings = settingsModule.saveSettings;
  beforeAll(() => {
    // update() persists, and the real write would land in the user's own
    // pum.json. Keep the step logic and drop the write.
    mock.module("./settings", () => ({ ...settingsModule, saveSettings: () => {} }));
  });
  afterAll(() => {
    mock.module("./settings", () => ({ ...settingsModule, saveSettings: realSaveSettings }));
  });

  test("two arrow presses advance the theme by two presets", async () => {
    const { setup } = await renderApp();

    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressArrow("down");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain(`‹ ${PRESET_NAMES[0]} ›`);

    // Both presses land before React commits the first, so both must step from
    // the latest value rather than from the same render closure.
    setup.mockInput.pressArrow("right");
    setup.mockInput.pressArrow("right");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain(`‹ ${PRESET_NAMES[2]} ›`);
  });
});

describe("cache rows and delivery", () => {
  test("marks a selected batch executed only after delivery succeeds", async () => {
    const delivery = deferred<void>();
    const { setup, calls, stores } = await renderApp({
      stash: [
        { text: "task one", executed: false },
        { text: "task two", executed: false },
      ],
      onPrompt: () => delivery.promise,
    });

    setup.mockInput.pressTab();
    await settle(setup);
    setup.mockInput.pressArrow("down", { shift: true });
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(calls.prompts).toHaveLength(1);
    expect(stores.getStash().some((prompt) => prompt.executed)).toBe(false);

    delivery.resolve();
    await settle(setup);
    expect(stores.getStash().every((prompt) => prompt.executed)).toBe(true);
  });
});

describe("render error boundary", () => {
  test("keeps the surrounding interface alive when a child throws", async () => {
    const setup = await createTestRenderer({ width: 60, height: 8, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const Boom = (): never => { throw new Error("bad transcript row"); };
    // React reports the caught error through console.error; the test asserts on
    // the rendered row instead, so keep the output readable.
    const reportError = console.error;
    console.error = () => {};
    try {
      createRoot(setup.renderer).render(
        <box style={{ flexDirection: "column" }}>
          <text content="above the boundary" />
          <RenderErrorBoundary theme={loadTheme("tokyonight")} label="transcript" resetKey="one">
            <Boom />
          </RenderErrorBoundary>
          <text content="below the boundary" />
        </box>,
      );
      await settle(setup);
    } finally {
      console.error = reportError;
    }

    const frame = setup.captureCharFrame();
    expect(frame).toContain("transcript failed to render: bad transcript row");
    expect(frame).toContain("above the boundary");
    expect(frame).toContain("below the boundary");
  });
});

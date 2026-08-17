import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../../src/app";
import type { ManagedShellSnapshot, ShellManagerLike } from "../../src/processes-popup";
import type { TriggerManagerLike, TriggerSnapshot } from "../../src/triggers/popup";

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

function trigger(id: string, name: string, createdAt: number, paused = false): TriggerSnapshot {
  return {
    id,
    name,
    state: paused ? "paused" : "idle",
    target: { sessionId: "session-1", agentId: null, label: "main" },
    executable: "printf",
    args: [name],
    cwd: "/tmp/project",
    mode: "repeat",
    restartDelayMs: 1000,
    createdAt,
    expiresAt: createdAt + 60_000,
    nextRestartAt: null,
    fireCount: 1,
    maxFires: 10,
    pendingCount: 0,
    coalescedCount: 0,
    paused,
  };
}

function fakeSession() {
  let listener: ((event: any) => void) | undefined;
  let aborts = 0;
  const session = {
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
    subscribe: (next: (event: any) => void) => {
      listener = next;
      return () => {};
    },
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => { aborts++; },
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async () => {},
    steer: async () => {},
  } as any;
  return {
    session,
    emit: (event: any) => listener?.(event),
    aborts: () => aborts,
  };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

// The shell tail arrives through an async getOutput() round trip, so a fixed
// settle can assert before it renders on a slow runner. Poll the frame instead.
async function waitForFrame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  expected: string,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await setup.renderOnce();
    await setup.flush();
    if (setup.captureCharFrame().includes(expected)) return;
    if (Date.now() > deadline) {
      expect(setup.captureCharFrame()).toContain(expected);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function renderApp(options: { loginRequired?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 90, height: 28, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const fake = fakeSession();
  const calls: string[] = [];
  const snapshots = [
    trigger("later", "Later trigger", 200),
    trigger("first", "First trigger", 100, true),
  ];
  const triggerManager: TriggerManagerLike = {
    subscribe: () => () => {},
    getTriggers: () => snapshots,
    pause: (id) => { calls.push(`pause:${id}`); },
    resume: (id) => { calls.push(`resume:${id}`); },
    invoke: (id) => { calls.push(`run:${id}`); },
    cancel: (id) => { calls.push(`cancel:${id}`); },
  };
  const shells: ManagedShellSnapshot[] = [{
    id: "shell-api",
    name: "API server",
    state: "running",
    owner: { sessionId: "session-1", agentId: null, label: "main" },
    executable: "server",
    args: ["--port", "8080"],
    cwd: "/tmp/project",
    createdAt: 100,
    startedAt: 110,
    finishedAt: null,
    exitCode: null,
    signal: null,
    ready: true,
    readyAt: 120,
    output: { path: "/tmp/shell-api", bytes: 6, truncated: false, exists: true },
  }];
  const shellManager: ShellManagerLike = {
    subscribe: () => () => {},
    list: () => shells,
    inspect: (id) => shells.find((shell) => shell.id === id)!,
    getOutput: async (id) => ({ shell: shells.find((shell) => shell.id === id)!, tail: "ready\n" }),
    terminate: async (id) => {
      calls.push(`kill:${id}`);
      return shells.find((shell) => shell.id === id)!;
    },
  };
  const subagentManager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    setMaxActiveSubagents() {},
  } as any;

  createRoot(setup.renderer).render(
    <App
      session={fake.session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => fake.session}
      loadSessions={async () => []}
      onSwitchSession={async () => fake.session}
      settings={settings}
      searchProviders={[]}
      subagentManager={subagentManager}
      triggerManager={triggerManager}
      shellManager={shellManager}
      loginRequired={options.loginRequired}
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
  return { setup, calls, ...fake };
}

describe("external trigger App controls", () => {
  test("opens with Ctrl+T and dispatches actions for the selected sorted trigger", async () => {
    const { setup, calls } = await renderApp();

    setup.mockInput.pressKey("t", { ctrl: true });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Processes");
    expect(frame.indexOf("First trigger")).toBeLessThan(frame.indexOf("Later trigger"));

    setup.mockInput.pressKey("p");
    setup.mockInput.pressKey("r");
    setup.mockInput.pressKey("f");
    setup.mockInput.pressKey("c");
    await settle(setup);
    expect(calls).toEqual(["resume:first", "run:first", "cancel:first"]);

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("p");
    await settle(setup);
    expect(calls.at(-1)).toBe("pause:later");
  });

  test("opens through /triggers and restores prompt focus after one Escape", async () => {
    const { setup } = await renderApp();

    await setup.mockInput.typeText("/triggers");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Processes");
    expect(setup.captureCharFrame()).not.toContain("❯ /triggers");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Processes");

    await setup.mockInput.typeText("focused again");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ focused again");
  });

  test("Escape closes the popup without entering the active-work cancellation flow", async () => {
    const { setup, emit, aborts } = await renderApp();
    emit({ type: "agent_start" });
    await settle(setup);

    setup.mockInput.pressKey("t", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);

    expect(setup.captureCharFrame()).not.toContain("Processes");
    expect(setup.captureCharFrame()).not.toContain("esc again to cancel");
    expect(aborts()).toBe(0);
  });

  test("does not steal Ctrl+T from the login modal", async () => {
    const { setup } = await renderApp({ loginRequired: true });
    expect(setup.captureCharFrame()).toContain("Login");

    setup.mockInput.pressKey("t", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Login");
    expect(setup.captureCharFrame()).not.toContain("Processes");
  });

  test("switches to Shells and kills the selected running shell", async () => {
    const { setup, calls } = await renderApp();

    setup.mockInput.pressKey("t", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("API server");
    await waitForFrame(setup, "ready");

    setup.mockInput.pressKey("k");
    await settle(setup);
    expect(calls).toContain("kill:shell-api");
  });
});

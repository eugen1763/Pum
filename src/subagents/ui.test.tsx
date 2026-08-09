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

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
  },
  startedAt: 1,
  updatedAt: 1,
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

    setup.mockInput.pressTab({ shift: true, ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("Subagent transcript");
  });

  test("requires two Escape presses before aborting the selected subagent", async () => {
    const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    let aborts = 0;
    const runningSnapshot = { ...snapshot, status: "running" as const };
    const manager = {
      getAgents: () => [runningSnapshot],
      subscribe: () => () => {},
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    expect(aborts).toBe(0);
    expect(setup.captureCharFrame()).toContain("esc again to cancel");

    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborts).toBe(1);
  });
});

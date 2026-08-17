import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { settleSyntaxHighlighting } from "../src/syntax";
import type { PumSettings } from "../src/settings";
import type { SubagentSnapshot } from "../src/subagents/types";

let destroy: (() => void | Promise<void>) | undefined;
afterEach(async () => {
  await destroy?.();
  destroy = undefined;
});

const baseSettings: PumSettings = {
  showThinking: false,
  theme: "tokyonight",
  animations: false,
  workingRuleAnimation: "off",
  webSearch: false,
  writingStyle: "none",
  explanationStrength: "simple",
  checkMode: "off",
  checkModel: "mock/check",
  sandboxMode: "off",
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
    sessionManager: { buildContextEntries: () => [] },
    sessionId: "main-session",
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

function subagent(): SubagentSnapshot {
  return {
    id: "worker",
    name: "worker",
    task: "test thinking visibility",
    status: "running",
    worktree: {
      name: "worker",
      path: "/tmp/project/.pum/worktrees/worker",
      branch: "pum/worker",
      baseBranch: "main",
      baseCommit: "abc123",
    },
    parentAgentId: null,
    modelId: "mock/mock-model",
    thinkingLevel: "high",
    transcript: {
      lines: [
        { kind: "text", role: "thinking", text: "retained subagent reasoning" },
        { kind: "text", role: "assistant", text: "retained subagent answer" },
      ],
      stream: { kind: "thinking", text: "streamed subagent reasoning" },
      pending: [],
    },
    startedAt: 1,
    updatedAt: 1,
    runStartedAt: Date.now(),
    usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
  };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Assistant rows render as Markdown, which highlights asynchronously. A cold
  // tree-sitter client takes longer than the timer, so without this wait the
  // text is missing from the frame unless another test file warmed the client
  // first. Waiting here makes the file pass on its own.
  await settleSyntaxHighlighting(setup.renderer.root);
  await setup.renderer.idle();
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(showThinking: boolean) {
  const setup = await createTestRenderer({ width: 90, height: 26, kittyKeyboard: true });
  const session = fakeSession();
  const agent = subagent();
  const manager = {
    getAgents: () => [agent],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: async () => {},
  } as any;
  const root = createRoot(setup.renderer);
  destroy = async () => {
    await settleSyntaxHighlighting(setup.renderer.root);
    root.unmount();
    await setup.flush();
    await setup.renderer.idle();
    setup.renderer.destroy();
  };
  root.render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={{ ...baseSettings, showThinking }}
      searchProviders={[]}
      subagentManager={manager}
    />,
  );
  await settle(setup);
  setup.mockInput.pressTab({ shift: true });
  await settle(setup);
  return setup.captureCharFrame();
}

describe("subagent thinking visibility", () => {
  test("hides retained and streaming subagent thinking when the setting is off", async () => {
    const frame = await renderApp(false);

    expect(frame).toContain("retained subagent answer");
    expect(frame).not.toContain("retained subagent reasoning");
    expect(frame).not.toContain("streamed subagent reasoning");
  });

  test("shows retained and streaming subagent thinking when the setting is on", async () => {
    const frame = await renderApp(true);

    expect(frame).toContain("retained subagent answer");
    expect(frame).toContain("retained subagent reasoning");
    expect(frame).toContain("streamed subagent reasoning");
  });
});

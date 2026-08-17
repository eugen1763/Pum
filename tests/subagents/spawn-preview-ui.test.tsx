import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { App } from "../../src/app";
import { SpawnPreviewManager } from "../../src/subagents/spawn-preview";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const child = {
  id: "child-1",
  name: "worker-one",
  task: "Work",
  status: "idle",
  worktree: { name: "worker-one", path: "/tmp/worker-one", branch: "pum/worker-one", baseBranch: "main", baseCommit: "abc" },
  parentAgentId: null,
  modelId: "mock/mock-model",
  thinkingLevel: "off",
  transcript: { lines: [], stream: null, pending: [] },
  startedAt: 1,
  updatedAt: 1,
  usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
};

function fakeSession() {
  return {
    sessionId: "main-session",
    agent: { state: { model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: () => () => {},
    setThinkingLevel() {}, setModel: async () => {}, abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }), prompt: async () => {}, steer: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [], getFollowUpMessages: () => [], followUp: async () => {},
  } as any;
}

const settings = {
  showThinking: false, theme: "tokyonight", animations: false,
  workingRuleAnimation: "off" as const, webSearch: false, writingStyle: "none" as const,
  explanationStrength: "simple" as const, checkMode: "off" as const,
  checkModel: "mock/check", maxActiveSubagents: 10,
};

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce(); await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce(); await setup.flush();
}

async function renderApp() {
  const setup = await createTestRenderer({ width: 64, height: 18, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const preview = new SpawnPreviewManager();
  const manager = {
    getAgents: () => [child], subscribe: () => () => {}, bindMainSession: async () => {},
    abortAgent: async () => {}, recallQueuedUserMessage: async () => null,
  } as any;
  createRoot(setup.renderer).render(
    <App session={session} modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session} loadSessions={async () => []}
      onSwitchSession={async () => session} settings={settings} searchProviders={[]}
      subagentManager={manager} spawnPreviewManager={preview} />,
  );
  await settle(setup);
  return { setup, preview };
}

const options = { task: "# Preview task\n\nKeep this exact prompt.", modelId: "mock/model", thinkingLevel: "off" };

describe("spawn preview App flow", () => {
  test("routes child ownership, approves with a note, and restores the prior draft", async () => {
    const { setup, preview } = await renderApp();
    await setup.mockInput.typeText("main draft");
    const result = preview.request({ sessionId: "child-session", agentId: child.id, name: child.name }, options);
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Spawn preview · worker-one");
    expect(frame).toContain("Child task");
    expect(frame).toContain("worker-one");

    await setup.mockInput.typeText("Run focused tests");
    setup.mockInput.pressEnter();
    await expect(result).resolves.toEqual({ approved: true, note: "Run focused tests" });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("main draft");
    await setup.mockInput.typeText(" restored");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("main draft restored");
  });

  test("labels readonly child previews", async () => {
    const { setup, preview } = await renderApp();
    const result = preview.request(
      { sessionId: "main-session", agentId: null, name: "main" },
      { ...options, readonly: true },
    );
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Child task · readonly");
    preview.cancel();
    await result;
  });

  test("cancels without changing the parent draft", async () => {
    const { setup, preview } = await renderApp();
    await setup.mockInput.typeText("safe draft");
    const result = preview.request({ sessionId: "main-session", agentId: null, name: "main" }, options);
    await settle(setup);
    setup.mockInput.pressEscape();
    await expect(result).resolves.toEqual({ approved: false, note: "", reason: "cancelled" });
    await settle(setup);
    await setup.mockInput.typeText(" kept");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("safe draft kept");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { TextareaRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { App } from "./app";

let destroy: (() => void) | undefined;

function focusedTextarea(root: BaseRenderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable && root.focused) return root;
  for (const child of root.getChildren()) {
    const found = focusedTextarea(child);
    if (found) return found;
  }
  return undefined;
}
afterEach(() => destroy?.());

function fakeSession() {
  return {
    sessionId: "main-session",
    agent: { state: { model: { id: "model", provider: "mock", input: ["text"], contextWindow: 32_000 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: () => () => {}, setThinkingLevel() {}, setModel: async () => {},
    abort: async () => {}, compact: async () => ({ tokensBefore: 0 }), prompt: async () => {}, steer: async () => {}, followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }), getSteeringMessages: () => [], getFollowUpMessages: () => [],
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

describe("queued user message recall UI", () => {
  test("recalls only the selected child's newest queued user message into its isolated draft", async () => {
    const setup = await createTestRenderer({ width: 64, height: 18, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const session = fakeSession();
    const listeners = new Set<(event: any) => void>();
    const child: any = {
      id: "child", name: "worker", task: "Work", status: "running",
      worktree: { name: "worker", path: "/tmp/worker", branch: "pum/worker", baseBranch: "main", baseCommit: "abc" },
      parentAgentId: null, modelId: "mock/model", thinkingLevel: "off",
      transcript: { lines: [], stream: null, pending: [
        { id: "old", line: { kind: "text", role: "user", text: "older queued" }, deliveryText: "older queued" },
        { id: "new", line: { kind: "text", role: "user", text: "newest queued" }, deliveryText: "newest queued" },
        { id: "agent", line: { kind: "agent-message", sender: "main", recipient: "worker", text: "do not recall" } },
      ] },
      startedAt: 1, updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
    };
    const recalledTargets: string[] = [];
    const manager = {
      getAgents: () => [structuredClone(child)],
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      bindMainSession: async () => {}, abortAgent: async () => {},
      recallQueuedUserMessage: async (id: string) => {
        recalledTargets.push(id);
        child.transcript.pending = child.transcript.pending.filter((item: any) => item.id !== "new");
        for (const listener of listeners) listener({ type: "changed" } as any);
        return { id: "new", text: "newest queued" };
      },
    } as any;
    createRoot(setup.renderer).render(
      <App session={session} modelRuntime={{ getAvailableSnapshot: () => [] } as any}
        onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
        settings={settings} searchProviders={[]} subagentManager={manager} />,
    );
    await settle(setup);
    await setup.mockInput.typeText("main draft");
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressArrow("up");
    for (let attempt = 0; attempt < 20; attempt++) {
      await settle(setup);
      if (focusedTextarea(setup.renderer.root)?.plainText === "newest queued") break;
    }

    expect(recalledTargets).toEqual(["child"]);
    expect(focusedTextarea(setup.renderer.root)?.plainText).toBe("newest queued");
    expect(setup.captureCharFrame()).not.toContain("○ newest queued");
    expect(child.transcript.pending.map((item: any) => item.id)).toEqual(["old", "agent"]);

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("main draft");

  });

  test("does not steal Up from a non-empty child draft", async () => {
    const setup = await createTestRenderer({ width: 64, height: 18, kittyKeyboard: true });
    destroy = () => setup.renderer.destroy();
    const session = fakeSession();
    let calls = 0;
    const child: any = {
      id: "child", name: "worker", task: "Work", status: "running",
      worktree: { name: "worker", path: "/tmp/worker", branch: "pum/worker", baseBranch: "main", baseCommit: "abc" },
      parentAgentId: null, modelId: "mock/model", thinkingLevel: "off",
      transcript: { lines: [], stream: null, pending: [{ id: "queued", line: { kind: "text", role: "user", text: "queued" }, deliveryText: "queued" }] },
      startedAt: 1, updatedAt: 1, usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
    };
    const manager = { getAgents: () => [child], subscribe: () => () => {}, bindMainSession: async () => {}, recallQueuedUserMessage: async () => { calls += 1; return null; } } as any;
    createRoot(setup.renderer).render(
      <App session={session} modelRuntime={{ getAvailableSnapshot: () => [] } as any}
        onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
        settings={settings} searchProviders={[]} subagentManager={manager} />,
    );
    await settle(setup);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await setup.mockInput.typeText("editing");
    setup.mockInput.pressArrow("up");
    await settle(setup);
    expect(calls).toBe(0);
    expect(setup.captureCharFrame()).toContain("editing");
  });
});

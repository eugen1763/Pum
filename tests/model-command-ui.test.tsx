import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { sessionSettingsFileFor } from "../src/session-settings";

let destroy: (() => void) | undefined;
const dirs: string[] = [];
afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const models = [
  { id: "plain", name: "Plain Model", provider: "mock", reasoning: false, input: ["text"], contextWindow: 32000 },
  { id: "reasoner", name: "Reasoning Model", provider: "mock", reasoning: true, input: ["text"], contextWindow: 32000 },
] as any;
const settings = { showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off", webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off", checkModel: "mock/plain", maxActiveSubagents: 10 } as any;

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(options: { child?: boolean; rejectModel?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const dir = mkdtempSync(join(tmpdir(), "pum-model-ui-"));
  dirs.push(dir);
  const calls: string[] = [];
  const session = {
    agent: { state: { model: models[0], thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionFile: join(dir, "session.jsonl"), sessionId: "model-test",
    subscribe: () => () => {},
    setThinkingLevel(level: string) { calls.push(`effort:${level}`); session.agent.state.thinkingLevel = level; },
    async setModel(model: any) {
      calls.push(`model:${model.id}`);
      if (options.rejectModel) throw new Error("No API key for mock");
      session.agent.state.model = model;
    },
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }), prompt: async () => { calls.push("prompt"); }, steer: async () => {},
  } as any;
  const child = {
    id: "child", name: "worker", task: "test", status: "idle", parentAgentId: null,
    worktree: { name: "worker", path: dir, branch: "main", baseBranch: "main", baseCommit: "abc" },
    modelId: "mock/plain", thinkingLevel: "off", transcript: { lines: [], stream: null, pending: [] },
    startedAt: 1, updatedAt: 1, usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
  };
  const manager = {
    getAgents: () => options.child ? [child] : [], getAgent: () => options.child ? child : undefined,
    subscribe: () => () => {}, bindMainSession: async () => {},
    abortAgent: async () => {}, sendUserMessage: async () => { calls.push("child prompt"); }, persistToolEvent() {},
    appendAgentLine(_id: string, line: any) { calls.push(`child error:${line.text}`); },
  } as any;
  createRoot(setup.renderer).render(<App session={session}
    modelRuntime={{ getAvailableSnapshot: () => models, getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
    settings={settings} searchProviders={[]} subagentManager={manager}
    promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
    promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }}
  />);
  await settle(setup);
  return { setup, session, calls };
}
async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  await settle(setup);
  // Command-name Enter completes the selected row; Tab makes that explicit.
  if (!text.includes(" ")) { setup.mockInput.pressTab(); await settle(setup); }
  setup.mockInput.pressEnter();
  await settle(setup);
}

describe("model and effort slash UI", () => {
  test("no model argument opens the existing picker", async () => {
    const { setup, calls } = await renderApp();
    await submit(setup, "/model");
    expect(setup.captureCharFrame()).toContain("Search provider or model");
    expect(setup.captureCharFrame()).toContain("reasoner");
    expect(calls).toEqual([]);
  });
  test("model and independent effort changes use session APIs without a prompt", async () => {
    const { setup, session, calls } = await renderApp();
    await submit(setup, "/model mock/reasoner low");
    expect(calls).toEqual(["model:reasoner", "effort:low"]);
    expect(session.agent.state.model).toBe(models[1]);
    await submit(setup, "/effort high");
    expect(calls).toEqual(["model:reasoner", "effort:low", "effort:high"]);
    await submit(setup, "/effort");
    expect(setup.captureCharFrame()).toContain("effort: high");
  });
  test("invalid effort leaves the model untouched; auth failures do not set effort", async () => {
    const { setup, calls } = await renderApp({ rejectModel: true });
    await submit(setup, "/model mock/plain high");
    expect(calls).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Unsupported effort");
    await submit(setup, "/model mock/reasoner low");
    expect(calls).toEqual(["model:reasoner"]);
    expect(setup.captureCharFrame()).toContain("No API key for mock");
  });
  test("Tab completes model and effort arguments", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.typeText("/model mock/rea");
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("/model mock/reasoner");
    await setup.mockInput.typeText(" l");
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toEqual(["model:reasoner", "effort:low"]);
  });
  test("selected child cannot silently change main or receive slash text", async () => {
    const { setup, calls } = await renderApp({ child: true });
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await submit(setup, "/model mock/reasoner low");
    await submit(setup, "/effort high");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.startsWith("child error:") && call.includes("Select the main transcript first"))).toBe(true);
  });
  for (const alias of ["/s", "/store"]) test(`${alias} promotes current settings with popup feedback`, async () => {
    const { setup, session, calls } = await renderApp();
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(existsSync(sessionSettingsFileFor(session.sessionFile))).toBe(true);
    setup.mockInput.pressEscape();
    await settle(setup);
    await submit(setup, alias);
    expect(existsSync(sessionSettingsFileFor(session.sessionFile))).toBe(false);
    expect(setup.captureCharFrame()).toContain("Saved these settings as the global defaults.");
    expect(calls).toEqual([]);
  });
});

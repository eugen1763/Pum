import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { clearRequestDiagnostics } from "../src/request-diagnostics";

let destroy: (() => void) | undefined;
const previous = process.env.PUM_REQUEST_DIAGNOSTICS;
afterEach(() => {
  destroy?.();
  destroy = undefined;
  clearRequestDiagnostics();
  if (previous === undefined) delete process.env.PUM_REQUEST_DIAGNOSTICS;
  else process.env.PUM_REQUEST_DIAGNOSTICS = previous;
});

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp() {
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const calls: string[] = [];
  const childLines: { line: any; options: any }[] = [];
  const model = { id: "plain", name: "Plain", provider: "mock", reasoning: false, input: ["text"], contextWindow: 32000 };
  const session = {
    agent: { state: { model, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [], appendCustomEntry: () => calls.push("persist") },
    sessionId: "raw-main-session-id", subscribe: () => () => {},
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {},
    prompt: async () => { calls.push("main prompt"); }, steer: async () => { calls.push("steer"); },
  } as any;
  const child = {
    id: "child", name: "worker", task: "test", status: "idle", parentAgentId: null,
    worktree: { name: "worker", path: process.cwd(), branch: "main", baseBranch: "main", baseCommit: "abc" },
    modelId: "mock/plain", thinkingLevel: "off", transcript: { lines: [], stream: null, pending: [] },
    startedAt: 1, updatedAt: 1, usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
  };
  const manager = {
    getAgents: () => [child], getAgent: (id: string) => id === "child" ? child : undefined,
    getDiagnosticsSessionId: (id: string) => id === "child" ? "raw-child-session-id" : undefined,
    subscribe: () => () => {}, bindMainSession: async () => {},
    sendUserMessage: async () => { calls.push("child prompt"); }, persistToolEvent() {},
    appendAgentLine(_id: string, line: any, options: any) { childLines.push({ line, options }); },
  } as any;
  const settings = { showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off", webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off", checkModel: "mock/plain", maxActiveSubagents: 10 } as any;
  createRoot(setup.renderer).render(<App session={session}
    modelRuntime={{ getAvailableSnapshot: () => [model], getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
    settings={settings} searchProviders={[]} subagentManager={manager}
    promptHistoryStore={{ load: () => [], append: () => { calls.push("history"); return []; }, remove: () => [] }}
    promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }}
  />);
  await settle(setup);
  return { setup, calls, childLines };
}

async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  await settle(setup);
  if (!text.includes(" ")) { setup.mockInput.pressTab(); await settle(setup); }
  setup.mockInput.pressEnter();
  await settle(setup);
}

describe("diagnostics slash UI", () => {
  test("disabled main command shows opt-in instructions without a model turn or persistence", async () => {
    delete process.env.PUM_REQUEST_DIAGNOSTICS;
    const { setup, calls } = await renderApp();
    await submit(setup, "/diagnostics");
    expect(setup.captureCharFrame()).toContain("Request diagnostics are disabled");
    expect(calls).toEqual([]);
  });

  test("child report and clear are session-local ephemeral UI, never child prompts", async () => {
    process.env.PUM_REQUEST_DIAGNOSTICS = "1";
    const { setup, calls, childLines } = await renderApp();
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await submit(setup, "/diagnostics");
    expect(childLines).toHaveLength(1);
    expect(childLines[0]!.options).toEqual({ persist: false });
    expect(() => JSON.parse(childLines[0]!.line.text)).not.toThrow();
    expect(childLines[0]!.line.text).not.toContain("raw-child-session-id");
    await submit(setup, "/diagnostics clear");
    expect(childLines[1]!.line.text).toBe("Request diagnostics cleared for this session.");
    expect(childLines[1]!.options).toEqual({ persist: false });
    expect(calls).toEqual([]);
  });
});

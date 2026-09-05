import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { checkpointControllerForSession, createFileCheckpointExtension } from "../src/file-checkpoints";

let destroy: (() => void) | undefined;
const shutdowns: (() => void)[] = [];
function bindController(id: string) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const extension = createFileCheckpointExtension();
  if (typeof extension === "function") throw new Error("expected a named checkpoint extension");
  extension.factory({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: () => {},
  } as any);
  handlers.get("session_start")!({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => id } });
  shutdowns.push(() => handlers.get("session_shutdown")!());
  return checkpointControllerForSession(id)!;
}
afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const shutdown of shutdowns.splice(0)) shutdown();
});

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(options: { onNewSession?: () => Promise<any> } = {}) {
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
    onNewSession={options.onNewSession ?? (async () => session)} loadSessions={async () => []} onSwitchSession={async () => session}
    settings={settings} searchProviders={[]} subagentManager={manager}
    promptHistoryStore={{ load: () => [], append: () => { calls.push("history"); return []; }, remove: () => [] }}
    promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }}
  />);
  await settle(setup);
  return { setup, calls, childLines, child, manager };
}

async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  await settle(setup);
  if (!text.includes(" ")) { setup.mockInput.pressTab(); await settle(setup); }
  setup.mockInput.pressEnter();
  await settle(setup);
}

describe("checkpoint explicit user UI", () => {
  test("unavailable and invalid commands never reach the model or persistence", async () => {
    const { setup, calls } = await renderApp();
    await submit(setup, "/checkpoint list");
    expect(setup.captureCharFrame()).toContain("unavailable for this session runtime");
    await submit(setup, "/checkpoint recover");
    expect(setup.captureCharFrame()).toContain("Usage: /checkpoint");
    expect(calls).toEqual([]);
  });

  test("selected worker lists and clears its own runtime only", async () => {
    const main = bindController("raw-main-session-id");
    const childController = bindController("raw-child-session-id");
    let childCleared = 0;
    let mainCleared = 0;
    main.clear = () => { mainCleared++; };
    childController.clear = () => { childCleared++; };
    childController.list = () => [{ id: "cp-worker", path: "/project/new.ts", toolName: "write", createdAt: 1, bytes: 0, priorAbsent: true }];
    const { setup, calls, childLines } = await renderApp();
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await submit(setup, "/checkpoint list");
    expect(childLines[0]!.line.text).toContain("cp-worker | write | previously absent");
    expect(childLines[0]!.line.text).toContain("Runtime-only");
    expect(childLines[0]!.line.text).toContain("/project/new.ts");
    expect(childLines[0]!.options).toEqual({ persist: false });
    await submit(setup, "/checkpoint clear");
    expect(childCleared).toBe(1);
    expect(mainCleared).toBe(0);
    expect(childLines[1]!.line.text).toContain("original files unchanged");
    expect(calls).toEqual([]);
    // Restore disposal methods overridden for routing assertions.
    delete (main as any).clear;
    delete (childController as any).clear;
  });

  test("busy worker cannot recover; idle copy guards transitions and reports manual apply", async () => {
    const controller = bindController("raw-child-session-id");
    let recoverCalls = 0;
    let resolve!: (path: string) => void;
    controller.recover = () => { recoverCalls++; return new Promise((done) => { resolve = done; }); };
    const { setup, calls, childLines, child } = await renderApp();
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    child.status = "running";
    await submit(setup, "/checkpoint recover cp-1");
    expect(recoverCalls).toBe(0);
    expect(childLines.at(-1)!.line.text).toContain("become idle");
    child.status = "idle";
    await submit(setup, "/checkpoint recover cp-1");
    expect(recoverCalls).toBe(1);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    resolve("/project/recovered-copy.txt");
    await settle(setup);
    expect(childLines.at(-1)!.line.text).toContain("Original unchanged");
    expect(childLines.at(-1)!.line.text).toContain("apply it manually");
    await submit(setup, "/checkpoint list");
    expect(childLines.at(-1)!.line.text).toContain("Runtime-only");
    expect(calls).toEqual([]);
  });

  test("recovery errors are safe and release the operation guard", async () => {
    const controller = bindController("raw-main-session-id");
    controller.recover = async () => { throw new Error("SECRET raw backend failure"); };
    const { setup, calls } = await renderApp();
    await submit(setup, "/checkpoint recover cp-1");
    expect(setup.captureCharFrame()).toContain("Checkpoint recovery failed");
    expect(setup.captureCharFrame()).not.toContain("SECRET");
    await submit(setup, "/checkpoint list");
    expect(setup.captureCharFrame()).toContain("No file checkpoints retained");
    expect(calls).toEqual([]);
  });

  for (const change of ["same-id replacement", "different runtime", "unavailable"] as const) {
    test(`revalidates worker identity before the recovery microtask: ${change}`, async () => {
      const original = bindController("raw-child-session-id");
      let originalRecoveries = 0;
      let replacementRecoveries = 0;
      original.recover = async () => { originalRecoveries++; return "/original-copy"; };
      const { setup, calls, childLines, manager } = await renderApp();
      setup.mockInput.pressTab({ shift: true });
      await settle(setup);
      const append = manager.appendAgentLine.bind(manager);
      let changed = false;
      // The public report callback runs after submission selected its controller
      // and before Promise.then revalidates it. No timers or private App refs.
      manager.appendAgentLine = (id: string, line: any, options: any) => {
        append(id, line, options);
        if (changed || !line.text.startsWith("Creating a checkpoint recovery copy")) return;
        changed = true;
        if (change === "unavailable") manager.getDiagnosticsSessionId = () => undefined;
        else {
          const replacementId = change === "same-id replacement" ? "raw-child-session-id" : "replacement-child-session-id";
          const replacement = bindController(replacementId);
          replacement.recover = async () => { replacementRecoveries++; return "/replacement-copy"; };
          manager.getDiagnosticsSessionId = () => replacementId;
        }
      };
      await submit(setup, "/checkpoint recover cp-1");
      expect(changed).toBe(true);
      expect(originalRecoveries).toBe(0);
      expect(replacementRecoveries).toBe(0);
      expect(childLines.at(-1)!.line.text).toContain("Checkpoint recovery failed");
      expect(childLines.some(({ line }) => line.text.includes("Recovery copy created:"))).toBe(false);
      // A second explicit request is allowed only after the failed operation's
      // finally releases its guard, and resolves the now-current runtime anew.
      if (change === "unavailable") manager.getDiagnosticsSessionId = () => "raw-child-session-id";
      await submit(setup, "/checkpoint recover cp-1");
      expect(originalRecoveries).toBe(change === "unavailable" ? 1 : 0);
      expect(replacementRecoveries).toBe(change === "unavailable" ? 0 : 1);
      expect(childLines.at(-1)!.line.text).toContain("Original unchanged");
      expect(calls).toEqual([]);
    });
  }

  test("an in-flight new-session transition refuses recovery until it settles", async () => {
    const controller = bindController("raw-main-session-id");
    let recoveries = 0;
    controller.recover = async () => { recoveries++; return "/main-copy"; };
    let finishSwitch!: (session: null) => void;
    let switches = 0;
    const { setup, calls } = await renderApp({ onNewSession: () => {
      switches++;
      return new Promise((resolve) => { finishSwitch = resolve; });
    } });
    await submit(setup, "/new");
    expect(switches).toBe(1);
    await submit(setup, "/checkpoint recover cp-1");
    expect(recoveries).toBe(0);
    expect(setup.captureCharFrame()).toContain("wait for the session change to finish before sending");
    finishSwitch(null);
    await settle(setup);
    // The generic session-transition gate preserves the rejected draft.
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(recoveries).toBe(1);
    expect(setup.captureCharFrame()).toContain("Original unchanged");
    expect(calls).not.toContain("main prompt");
  });

  test("pending recovery failure blocks input and agent switching, then releases both", async () => {
    const controller = bindController("raw-child-session-id");
    let reject!: (error: Error) => void;
    let recoveries = 0;
    controller.recover = () => { recoveries++; return new Promise((_resolve, fail) => { reject = fail; }); };
    const { setup, calls, childLines, child } = await renderApp();
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    for (const status of ["starting", "running"]) {
      child.status = status;
      await submit(setup, "/checkpoint recover cp-1");
      expect(recoveries).toBe(0);
      expect(childLines.at(-1)!.line.text).toContain("become idle");
    }
    child.status = "idle";
    await submit(setup, "/checkpoint recover cp-1");
    expect(recoveries).toBe(1);
    setup.mockInput.pressTab({ shift: true });
    await submit(setup, "/checkpoint recover cp-2");
    expect(recoveries).toBe(1);
    expect(calls).toEqual([]);
    reject(new Error("PRIVATE backend details"));
    await settle(setup);
    expect(childLines.at(-1)!.line.text).toContain("Checkpoint recovery failed");
    expect(childLines.at(-1)!.line.text).not.toContain("PRIVATE");
    await submit(setup, "/checkpoint list");
    expect(childLines.at(-1)!.line.text).toContain("No file checkpoints retained");
    // The attempted switch while pending did not happen. A fresh switch after
    // rejection must work; ordinary input now reaches main rather than worker.
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await submit(setup, "hello after failure");
    expect(calls).toContain("main prompt");
    expect(calls).not.toContain("child prompt");
  });

  test("pasted marker payloads do not authorize checkpoint commands", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.pasteBracketedText("/checkpoint clear\n\n\n\n");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toContain("main prompt");
    expect(setup.captureCharFrame()).not.toContain("File checkpoints cleared");
  });

  test("leading whitespace is ordinary prompt text, never checkpoint authorization", async () => {
    const { setup, calls } = await renderApp();
    await submit(setup, " /checkpoint clear");
    expect(calls).toContain("main prompt");
  });
});

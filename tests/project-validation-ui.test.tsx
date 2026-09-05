import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { ProjectValidationController, VALIDATION_CUSTOM_TYPE } from "../src/project-validation";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let destroy: (() => void) | undefined;
const cleanups: (() => void)[] = [];
afterEach(() => {
  destroy?.(); destroy = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function bindController(session: any, readonly = false) {
  const cwd = mkdtempSync(join(tmpdir(), "pum-validation-ui-"));
  mkdirSync(join(cwd, ".pum"));
  const text = JSON.stringify({ version: 1, commands: [{ kind: "test", command: "echo validation", timeoutSeconds: 1 }] });
  writeFileSync(join(cwd, ".pum", "validation.json"), text);
  session.sessionManager.getCwd = () => cwd;
  session.dispose = () => {};
  session.agent ??= {};
  const controller = new ProjectValidationController({ cwd, readonly });
  cleanups.push(() => { controller.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  controller.bind(session);
  return { controller, digest: createHash("sha256").update(text).digest("hex") };
}

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
  const listeners = new Set<(event: any) => void>();
  const emit = (event: any) => { for (const listener of listeners) listener(event); };
  const childLines: { line: any; options: any }[] = [];
  const model = { id: "plain", name: "Plain", provider: "mock", reasoning: false, input: ["text"], contextWindow: 32000 };
  const session = {
    agent: { state: { model, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [], appendCustomEntry: () => calls.push("persist") },
    sessionId: "validation-ui-main", subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {},
    prompt: async () => { calls.push("main prompt"); }, steer: async () => { calls.push("steer"); },
  } as any;
  const child = {
    id: "child", name: "worker", task: "test", status: "idle", readonly: false, parentAgentId: null,
    worktree: { name: "worker", path: process.cwd(), branch: "main", baseBranch: "main", baseCommit: "abc" },
    modelId: "mock/plain", thinkingLevel: "off", transcript: { lines: [], stream: null, pending: [] },
    startedAt: 1, updatedAt: 1, usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
  };
  const manager = {
    getAgents: () => [child], getAgent: (id: string) => id === "child" ? child : undefined,
    getDiagnosticsSessionId: (id: string) => id === "child" ? "validation-ui-child" : undefined,
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
  return { setup, calls, childLines, child, manager, session, emit };
}

async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  await settle(setup);
  if (!text.includes(" ")) { setup.mockInput.pressTab(); await settle(setup); }
  setup.mockInput.pressEnter();
  await settle(setup);
}

describe("validation direct-user UI", () => {
  test("live persisted evidence renders from custom message events without creating authority", async () => {
    const { setup, calls, emit } = await renderApp();
    emit({ type: "message_end", message: { role: "custom", customType: VALIDATION_CUSTOM_TYPE, content: "Automatic validation: passed, test evidence", details: { outcome: "passed" } } });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Automatic validation: passed, test evidence");
    emit({ type: "message_end", message: { role: "custom", customType: VALIDATION_CUSTOM_TYPE, content: "Automatic validation: blocked, denied evidence", details: { outcome: "blocked" } } });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Automatic validation: blocked, denied evidence");
    expect(calls).toEqual([]);
  });
  test("preview is inert and approval/status/disable remain transient", async () => {
    const { setup, calls, session } = await renderApp();
    const { controller, digest } = bindController(session);
    await submit(setup, "/validation");
    expect(setup.captureCharFrame()).toContain("echo validation");
    expect(setup.captureCharFrame()).toContain(digest);
    expect(setup.captureCharFrame()).toContain("current/future project code");
    expect(controller.status()).toContain("disabled");
    await submit(setup, "/validation enable " + digest.toUpperCase());
    expect(controller.status()).toContain("enabled");
    await submit(setup, "/validation status");
    expect(setup.captureCharFrame()).toContain("Automatic validation enabled");
    await submit(setup, "/validation disable");
    expect(controller.status()).toContain("disabled");
    expect(calls).toEqual([]);
  });

  test("busy main cannot enable but direct disable remains available", async () => {
    const { setup, calls, session, emit } = await renderApp();
    const { controller, digest } = bindController(session);
    emit({ type: "agent_start" });
    await settle(setup);
    await submit(setup, "/validation enable " + digest);
    expect(setup.captureCharFrame()).toContain("become idle");
    expect(controller.status()).toContain("disabled");
    let disables = 0;
    const disable = controller.disable.bind(controller);
    controller.disable = () => { disables++; disable(); };
    await submit(setup, "/validation disable");
    expect(disables).toBe(1);
    expect(calls).toEqual([]);
  });

  test("busy worker cannot enable but disable still revokes its own controller", async () => {
    const { setup, calls, childLines, child, session } = await renderApp();
    const main = bindController(session);
    const workerSession = { sessionId: "validation-ui-child", sessionManager: {} } as any;
    const worker = bindController(workerSession);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    for (const status of ["starting", "running"]) {
      child.status = status;
      await submit(setup, "/validation enable " + worker.digest);
      expect(worker.controller.status()).toContain("disabled");
      expect(childLines.at(-1)!.line.text).toContain("become idle");
    }
    child.status = "idle";
    await submit(setup, "/validation enable " + worker.digest);
    expect(worker.controller.status()).toContain("enabled");
    child.status = "running";
    workerSession.isStreaming = true;
    await submit(setup, "/validation disable");
    expect(worker.controller.status()).toContain("disabled");
    expect(main.controller.status()).toContain("disabled");
    expect(childLines.every(({ options }) => options.persist === false)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("readonly selected worker refuses approval", async () => {
    const { setup, calls, childLines, child } = await renderApp();
    const { controller, digest } = bindController({ sessionId: "validation-ui-child", sessionManager: {} }, true);
    child.readonly = true;
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await submit(setup, "/validation enable " + digest);
    expect(childLines.at(-1)!.line.text).toContain("Readonly sessions cannot enable");
    expect(controller.status()).toContain("readonly role");
    expect(calls).toEqual([]);
  });

  test("mismatched digest never enables validation or sends a model turn", async () => {
    const { setup, calls, session } = await renderApp();
    const { controller } = bindController(session);
    await submit(setup, "/validation enable " + "0".repeat(64));
    expect(setup.captureCharFrame()).toContain("Project validation request failed");
    expect(controller.status()).toContain("disabled");
    expect(calls).toEqual([]);
  });
  test("unbound and invalid commands never become prompts, history, or durable authority", async () => {
    const { setup, calls } = await renderApp();
    await submit(setup, "/validation status");
    expect(setup.captureCharFrame()).toContain("Project validation is unavailable");
    for (const command of ["/validation enable", "/validation enable bad", "/validation enable " + "g".repeat(64), "/validation disable extra", "/validation run"]) {
      await submit(setup, command);
      expect(setup.captureCharFrame()).toContain("Usage: /validation");
    }
    expect(calls).toEqual([]);
  });

  test("selected worker reports remain transient and never fall through to main", async () => {
    const { setup, calls, childLines } = await renderApp();
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await submit(setup, "/validation status");
    expect(childLines.at(-1)!.line.text).toContain("Project validation is unavailable");
    expect(childLines.at(-1)!.options).toEqual({ persist: false });
    await submit(setup, "/validation enable bad");
    expect(childLines.at(-1)!.line.text).toContain("Usage: /validation");
    expect(calls).toEqual([]);
  });

  test("leading whitespace is ordinary prompt text, not validation approval", async () => {
    const { setup, calls, session } = await renderApp();
    const { controller, digest } = bindController(session);
    await submit(setup, " /validation enable " + digest);
    expect(controller.status()).toContain("disabled");
    expect(calls).toContain("main prompt");
  });

  test("pasted marker payloads never authorize validation commands", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.pasteBracketedText("/validation enable " + "a".repeat(64) + "\n\n\n\n");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toContain("main prompt");
    expect(setup.captureCharFrame()).not.toContain("Project validation is unavailable");
  });
});

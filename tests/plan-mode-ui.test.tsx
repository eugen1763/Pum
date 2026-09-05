import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { App } from "../src/app";
import { bindRuntimeSettingsActivity } from "../src/runtime-settings";
import { bindConversationBranchSession } from "../src/conversation-branch";
import { loadPlanRecord, PLAN_MODE_CUSTOM_TYPE, savePlanRecord, type PlanMode } from "../src/plan-mode";

let destroy: (() => void) | undefined;
const roots: string[] = [];
afterEach(() => {
  destroy?.(); destroy = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce(); await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce(); await setup.flush();
}

async function fixture(options: { stashedText?: string; startInPlan?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true, exitOnCtrlC: false });
  destroy = () => setup.renderer.destroy();
  const root = mkdtempSync(join(tmpdir(), "pum-plan-ui-")); roots.push(root);
  const sessionFile = join(root, "session.jsonl");
  const listeners = new Set<(event: any) => void>();
  const model = { id: "plain", name: "Plain", provider: "mock", reasoning: false, input: ["text"], contextWindow: 32000 };
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "how should we do this", timestamp: 1 } as any);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "here is a plan" }], stopReason: "stop" } as any);
  if (options.startInPlan) manager.appendCustomEntry(PLAN_MODE_CUSTOM_TYPE, { version: 1, mode: "plan" });
  const session = {
    isStreaming: false, pendingMessageCount: 0, isBashRunning: false, hasPendingBashMessages: false,
    isCompacting: false, isRetrying: false, sessionFile,
    agent: { state: { model, thinkingLevel: "off", isStreaming: false }, hasQueuedMessages: () => false },
    sendCustomMessage: async () => {}, sessionManager: manager, sessionId: "plan-ui-main",
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {}, prompt: async () => {}, dispose: () => {},
  } as any;
  bindConversationBranchSession(session);
  bindRuntimeSettingsActivity(session);
  const subagentManager = {
    getAgents: () => [], getAgent: () => undefined, subscribe: () => () => {},
    bindMainSession: async () => {}, resendUndeliveredMainSettlements: async () => {},
    sendUserMessage: async () => {}, persistToolEvent() {}, appendAgentLine() {},
    canBranchMainSession: () => true,
  } as any;
  const transitions: PlanMode[] = [];
  const mcpCommands: string[] = [];
  const mcpController = { command: async (text: string) => { mcpCommands.push(text); return "MCP preview"; }, cancel: () => {} } as any;
  const settings = {
    showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off",
    webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off",
    checkModel: "mock/plain", maxActiveSubagents: 10,
  } as any;
  createRoot(setup.renderer).render(<App session={session}
    modelRuntime={{ getAvailableSnapshot: () => [model], getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
    onTransitionPlanMode={async (mode, planOptions) => {
      planOptions.validate();
      planOptions.validateRetired();
      transitions.push(mode);
      // The host publishes the durable records and hands back a rebuilt runtime.
      manager.appendCustomEntry(PLAN_MODE_CUSTOM_TYPE, { version: 1, mode });
      savePlanRecord(sessionFile, { ...(loadPlanRecord(sessionFile) ?? {}), version: 1, mode, at: Date.now() });
      return { session: { ...session, agent: { ...session.agent } }, mode, recovered: false };
    }}
    settings={settings} searchProviders={[]} subagentManager={subagentManager}
    mcpForSession={(target) => target === session ? mcpController : undefined}
    promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
    promptStashStore={{
      load: () => options.stashedText ? [{ text: options.stashedText, executed: false }] : [],
      append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [],
    }}
  />);
  await settle(setup);
  return { setup, session, manager, sessionFile, transitions, mcpCommands };
}

async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text + " "); await settle(setup);
  setup.mockInput.pressEnter(); await settle(setup);
}

describe("rendered plan mode commands", () => {
  test("/plan enters the role and discloses what it blocks", async () => {
    const f = await fixture();
    expect(f.setup.captureCharFrame()).not.toContain("PLAN");
    await submit(f.setup, "/plan");
    expect(f.transitions).toEqual(["plan"]);
    const frame = f.setup.captureCharFrame();
    expect(frame).toContain("Plan mode is ON");
    expect(frame).toContain("blocked");
    // The role stays visible in the status bar, not only in one transcript line.
    expect(frame).toContain("PLAN");
  });

  test("/plan <text> records the plan and shows it while the role is on", async () => {
    const f = await fixture({ startInPlan: true });
    await submit(f.setup, "/plan write the migration first");
    expect(f.transitions).toEqual([]); // Already in plan mode: recording only.
    expect(loadPlanRecord(f.sessionFile)?.text).toBe("write the migration first");
    const frame = f.setup.captureCharFrame();
    expect(frame).toContain("Plan recorded");
    expect(frame).toContain("write the migration first");
  });

  test("leaving needs a second directly typed confirmation", async () => {
    const f = await fixture({ startInPlan: true });
    await submit(f.setup, "/implement");
    expect(f.transitions).toEqual([]);
    const armed = f.setup.captureCharFrame();
    expect(armed).toContain("restores file mutation");
    expect(armed).toContain("/implement confirm");
    await submit(f.setup, "/implement confirm");
    expect(f.transitions).toEqual(["implement"]);
    expect(f.setup.captureCharFrame()).toContain("Plan mode is off");
  });

  test("confirm alone cannot upgrade without the armed direct command", async () => {
    const f = await fixture({ startInPlan: true });
    await submit(f.setup, "/implement confirm");
    expect(f.transitions).toEqual([]);
    expect(f.setup.captureCharFrame()).toContain("Type /implement first");
  });

  test("a cached draft can neither enter nor leave plan mode", async () => {
    for (const command of ["/plan", "/implement confirm"]) {
      const f = await fixture({ stashedText: command, startInPlan: command !== "/plan" });
      f.setup.mockInput.pressTab(); await settle(f.setup);
      f.setup.mockInput.pressArrow("up"); await settle(f.setup);
      f.setup.mockInput.pressTab(); await settle(f.setup);
      expect(f.setup.captureCharFrame()).toContain(command);
      f.setup.mockInput.pressEnter(); await settle(f.setup);
      expect(f.setup.captureCharFrame()).toContain("require direct user input");
      expect(f.transitions).toEqual([]);
      destroy?.(); destroy = undefined;
    }
  });

  test("plan mode refuses the MCP lifecycle and project validation approval", async () => {
    const f = await fixture({ startInPlan: true });
    for (const command of ["/mcp connect server " + "a".repeat(64), "/mcp approve server " + "b".repeat(64)]) {
      await submit(f.setup, command);
      expect(f.setup.captureCharFrame()).toContain("Plan mode cannot connect, approve or use MCP");
    }
    expect(f.mcpCommands).toEqual([]);
    await submit(f.setup, "/validation enable " + "c".repeat(64));
    expect(f.setup.captureCharFrame()).toContain("Plan mode cannot enable project validation");
  });

  test("an armed /implement is disarmed by any non-direct submission", async () => {
    const f = await fixture({ startInPlan: true, stashedText: "/implement confirm" });
    await submit(f.setup, "/implement");
    expect(f.setup.captureCharFrame()).toContain("/implement confirm");
    f.setup.mockInput.pressTab(); await settle(f.setup);
    f.setup.mockInput.pressArrow("up"); await settle(f.setup);
    f.setup.mockInput.pressTab(); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.transitions).toEqual([]);
    // The arm is gone, so a later direct confirm has to start over.
    await submit(f.setup, "/implement confirm");
    expect(f.transitions).toEqual([]);
    expect(f.setup.captureCharFrame()).toContain("Type /implement first");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { App } from "../src/app";
import { bindRuntimeSettingsActivity } from "../src/runtime-settings";
import { bindConversationBranchSession } from "../src/conversation-branch";
import type { ConversationBranchSelection } from "../src/conversation-branch";

let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); destroy = undefined; });

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce(); await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce(); await setup.flush();
}

async function fixture(options: { stashedText?: string; branchable?: boolean; replaceSession?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true, exitOnCtrlC: false });
  destroy = () => setup.renderer.destroy();
  const listeners = new Set<(event: any) => void>();
  const model = { id: "plain", name: "Plain", provider: "mock", reasoning: false, input: ["text"], contextWindow: 32000 };
  const manager = SessionManager.inMemory(process.cwd());
  const first = manager.appendMessage({ role: "user", content: "original prompt", timestamp: 1 } as any);
  const answer = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "original answer" }], stopReason: "stop" } as any);
  manager.appendMessage({ role: "user", content: "second prompt", timestamp: 1 } as any);
  const session = {
    isStreaming: false,
    pendingMessageCount: 0,
    isBashRunning: false,
    hasPendingBashMessages: false,
    isCompacting: false,
    isRetrying: false,
    sessionFile: undefined,
    agent: {
      state: { model, thinkingLevel: "off", isStreaming: false },
      hasQueuedMessages: () => false,
    },
    sendCustomMessage: async () => {},
    sessionManager: manager,
    sessionId: "branch-ui-main",
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    prompt: async () => {},
    dispose: () => {},
  } as any;
  bindConversationBranchSession(session);
  bindRuntimeSettingsActivity(session);
  const subagentManager = {
    getAgents: () => [], getAgent: () => undefined, subscribe: () => () => {},
    bindMainSession: async () => {}, resendUndeliveredMainSettlements: async () => {},
    sendUserMessage: async () => {}, persistToolEvent() {}, appendAgentLine() {},
    canBranchMainSession: (target: unknown) => options.branchable !== false && target === manager,
  } as any;
  const branchCalls: ConversationBranchSelection[] = [];
  let guardFailure: string | undefined;
  const replacement = () => {
    const next = { ...session, agent: { ...session.agent } };
    bindConversationBranchSession(next);
    bindRuntimeSettingsActivity(next);
    return next;
  };
  const settings = {
    showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off",
    webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off",
    checkModel: "mock/plain", maxActiveSubagents: 10,
  } as any;
  createRoot(setup.renderer).render(<App session={session}
    modelRuntime={{ getAvailableSnapshot: () => [model], getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
    onBranchConversation={async (selection, branchOptions) => {
      branchOptions.validate();
      branchOptions.validateRetired();
      branchCalls.push(selection);
      if (guardFailure) throw new Error(guardFailure);
      // The real transaction always hands back a freshly built runtime object
      // on the same canonical file, id and lock.
      const next = options.replaceSession ? replacement() : session;
      return { session: next, editorText: "original prompt" };
    }}
    settings={settings} searchProviders={[]} subagentManager={subagentManager}
    promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
    promptStashStore={{
      load: () => options.stashedText ? [{ text: options.stashedText, executed: false }] : [],
      append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [],
    }}
  />);
  await settle(setup);
  return { setup, session, manager, branchCalls, first, answer,
    failGuard: (reason: string) => { guardFailure = reason; } };
}

async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text + " "); await settle(setup);
  setup.mockInput.pressEnter(); await settle(setup);
}

describe("rendered same-session conversation branch selection", () => {
  test("/branch opens a disclosed selector and only a confirmed point navigates", async () => {
    const f = await fixture();
    await submit(f.setup, "/branch");
    const listed = f.setup.captureCharFrame();
    expect(listed).toContain("Same-session conversation branch");
    expect(listed).toContain("are NOT rewound");
    expect(listed).toContain("BEFORE user");
    expect(listed).toContain("second prompt");
    // Enter previews the exact point; it must not navigate on its own.
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.setup.captureCharFrame()).toContain("Enter confirm branch");
    expect(f.branchCalls).toEqual([]);
    // Escape backs out of the confirmation instead of applying it.
    f.setup.mockInput.pressKey("ESCAPE"); await settle(f.setup);
    expect(f.setup.captureCharFrame()).toContain("Enter preview");
    expect(f.branchCalls).toEqual([]);
    f.setup.mockInput.pressArrow("down"); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.branchCalls.length).toBe(1);
    expect(f.branchCalls[0]!.entryId).toBe(f.answer);
    const applied = f.setup.captureCharFrame();
    expect(applied).toContain("were not rewound");
    expect(applied).not.toContain("Same-session conversation branch");
  });

  test("a restored earlier prompt is an untrusted draft, not fresh command authority", async () => {
    const f = await fixture();
    await submit(f.setup, "/branch");
    f.setup.mockInput.pressArrow("down"); await settle(f.setup);
    f.setup.mockInput.pressArrow("down"); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.branchCalls[0]!.entryId).toBe(f.first);
    expect(f.setup.captureCharFrame()).toContain("original prompt");
    // The restored draft carries restored origin, so a second /branch from it
    // is refused rather than reopening the selector.
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.branchCalls.length).toBe(1);
  });

  test("the selector owns the keyboard while it is open", async () => {
    const f = await fixture();
    await submit(f.setup, "/branch");
    for (const shortcut of ["n", "o", "h"]) {
      f.setup.mockInput.pressKey(shortcut, { ctrl: true });
      await settle(f.setup);
      const frame = f.setup.captureCharFrame();
      expect(frame).toContain("Same-session conversation branch");
      expect(frame).not.toContain("Recent answers");
    }
    expect(f.branchCalls).toEqual([]);
  });

  test("cached draft text cannot open the selector", async () => {
    const f = await fixture({ stashedText: "/branch" });
    f.setup.mockInput.pressTab(); await settle(f.setup);
    f.setup.mockInput.pressArrow("up"); await settle(f.setup);
    f.setup.mockInput.pressTab(); await settle(f.setup);
    expect(f.setup.captureCharFrame()).toContain("/branch");
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    const frame = f.setup.captureCharFrame();
    expect(frame).toContain("require direct user input");
    expect(frame).not.toContain("Same-session conversation branch");
    expect(f.branchCalls).toEqual([]);
  });

  test("retained worker admission refuses before any selector opens", async () => {
    const f = await fixture({ branchable: false });
    await submit(f.setup, "/rewind");
    const frame = f.setup.captureCharFrame();
    expect(frame).toContain("retained worker");
    expect(frame).not.toContain("Same-session conversation branch");
    expect(f.branchCalls).toEqual([]);
  });

  test("a rebuilt runtime replays the selected path with the same disclosure", async () => {
    const f = await fixture({ replaceSession: true });
    await submit(f.setup, "/branch");
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.branchCalls.length).toBe(1);
    const applied = f.setup.captureCharFrame();
    expect(applied).toContain("were not rewound");
    expect(applied).toContain("original answer");
    expect(applied).not.toContain("Same-session conversation branch");
  });

  test("a failed transaction reports recovery instead of claiming success", async () => {
    const f = await fixture();
    f.failGuard("Conversation branch recovery required. Further session work is blocked.");
    await submit(f.setup, "/branch");
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    const frame = f.setup.captureCharFrame();
    expect(frame).toContain("recovery required");
    expect(frame).not.toContain("were not rewound");
  });
});

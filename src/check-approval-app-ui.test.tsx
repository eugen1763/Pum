import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { CheckApprovalCoordinator, canonicalJson } from "./check-approvals";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function fakeSession() {
  return {
    agent: { state: { model: { id: "mock", provider: "mock", input: ["text"], contextWindow: 32000 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionId: "main",
    subscribe: () => () => {},
    setThinkingLevel() {}, setModel: async () => {}, clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {}, prompt: async () => {}, steer: async () => {},
  } as any;
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await Bun.sleep(10);
  await setup.renderOnce();
  await setup.flush();
}

async function render(coordinator: CheckApprovalCoordinator, checkApprovalStore?: any) {
  const setup = await createTestRenderer({ width: 76, height: 22, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const manager = {
    getAgents: () => [{ id: "child", name: "worker", status: "running", worktree: { path: "/repo/.pum/worktrees/worker", branch: "pum/worker" }, transcript: { lines: [], stream: null, pending: [] }, modelId: "mock/mock", thinkingLevel: "off", usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 }, updatedAt: 1, startedAt: 1 }],
    subscribe: () => () => {}, bindMainSession: async () => {},
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={{ showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off", webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "ask", checkModel: "mock/check" }}
      searchProviders={[]}
      subagentManager={manager}
      checkApprovalCoordinator={coordinator}
      checkApprovalStore={checkApprovalStore}
    />,
  );
  await settle(setup);
  return setup;
}

describe("ask approval app flow", () => {
  test("targets a subagent request and restores input focus after Escape", async () => {
    const coordinator = new CheckApprovalCoordinator();
    const setup = await render(coordinator);
    const decision = coordinator.request({
      toolName: "bash", model: "mock/check", cwd: "/repo/.pum/worktrees/worker",
      canonicalInput: canonicalJson({ command: "bun test" }), summary: "Run tests", reason: "Verifier unclear",
      paths: [], preview: "bun test",
    });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Approval required");
    expect(frame).toContain("bash · worker");
    expect(frame).toContain("Verifier unclear");
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(await decision).toBe("deny");
    expect(setup.captureCharFrame()).not.toContain("Approval required");
    await setup.mockInput.typeText("focused");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("focused");
  });

  test("chooses an exact project approval with keyboard navigation", async () => {
    const coordinator = new CheckApprovalCoordinator();
    const setup = await render(coordinator);
    const decision = coordinator.request({
      toolName: "edit", model: "mock/check", cwd: process.cwd(),
      canonicalInput: canonicalJson({ path: "a.ts", edits: [] }), summary: "Change one file", reason: "Verifier unavailable",
      paths: ["a.ts"], preview: "--- a/a.ts\n+++ b/a.ts",
    });
    await settle(setup);
    setup.mockInput.pressArrow("right");
    await settle(setup);
    setup.mockInput.pressArrow("right");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(await decision).toBe("allow-project");
  });

  test("clears exact project approvals from Settings", async () => {
    const coordinator = new CheckApprovalCoordinator();
    let cleared = 0;
    const setup = await render(coordinator, { clearProject: () => { cleared++; return 2; } });
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("clear approvals");
    await settle(setup);
    setup.mockInput.pressArrow("down");
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(cleared).toBe(1);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("cleared 2 Check mode project approvals");
  });
});

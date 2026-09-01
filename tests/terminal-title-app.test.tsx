import { afterEach, describe, expect, test } from "bun:test";
import { destroyTreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { settleSyntaxHighlighting } from "../src/syntax";
import { OrcaStatusController } from "../src/orca-status";
import { TerminalTitleController } from "../src/terminal-title";

let destroy: (() => Promise<void>) | undefined;

afterEach(async () => {
  await destroy?.();
  destroy = undefined;
});

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

describe("App terminal title lifecycle", () => {
  test("tracks main activity and active subagent transitions without duplicate writes", async () => {
    const setup = await createTestRenderer({ width: 70, height: 20, exitOnCtrlC: false });
    const root = createRoot(setup.renderer);
    let sessionListener: ((event: { type: string }) => void) | undefined;
    let managerListener: ((event: { type: "changed" }) => void) | undefined;
    let agents: any[] = [];
    const subagent = (status: string) => ({
      id: "child",
      name: "worker",
      task: "test",
      status,
      worktree: { path: "/tmp/worker", branch: "pum/worker" },
      parentAgentId: null,
      modelId: "mock/model",
      thinkingLevel: "off",
      transcript: { lines: [], stream: null, pending: [] },
      startedAt: 1,
      updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
    });
    const writes: string[] = [];
    const terminalTitle = new TerminalTitleController((title) => writes.push(title));
    const orcaWrites: string[] = [];
    const orcaStatus = new OrcaStatusController(true, (sequence) => orcaWrites.push(sequence));
    const session = {
      sessionId: "main",
      agent: {
        state: {
          model: { id: "model", provider: "mock", input: ["text"], contextWindow: 32_000 },
          thinkingLevel: "off",
        },
      },
      sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
      subscribe(listener: (event: { type: string }) => void) {
        sessionListener = listener;
        return () => {};
      },
      setThinkingLevel() {},
      setModel: async () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
      compact: async () => ({ tokensBefore: 0 }),
      prompt: async () => {},
      steer: async () => {},
    } as any;
    const manager = {
      getAgents: () => agents,
      subscribe(listener: (event: { type: "changed" }) => void) {
        managerListener = listener;
        return () => {};
      },
      bindMainSession: async () => {},
    } as any;

    root.render(
      <App
        session={session}
        modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
        onNewSession={async () => null}
        loadSessions={async () => []}
        onSwitchSession={async () => null}
        settings={{
          showThinking: false,
          theme: "tokyonight",
          animations: false,
          workingRuleAnimation: "off",
          webSearch: false,
          writingStyle: "none",
          explanationStrength: "simple",
          checkMode: "off",
          checkModel: "mock/check",
          maxActiveSubagents: 10,
        } as any}
        searchProviders={[]}
        subagentManager={manager}
        terminalTitle={terminalTitle}
        orcaStatus={orcaStatus}
      />,
    );
    destroy = async () => {
      terminalTitle.clear();
      await settleSyntaxHighlighting(setup.renderer.root);
      root.unmount();
      await setup.flush();
      setup.renderer.destroy();
      await destroyTreeSitterClient();
    };

    await settle(setup);
    expect(writes).toEqual(["Pum · idle"]);
    expect(orcaWrites).toHaveLength(1);
    expect(orcaWrites[0]).toContain('"state":"done"');
    expect(orcaWrites[0]).toContain('"sessionBoundary":true');

    sessionListener?.({ type: "agent_start" });
    await settle(setup);
    expect(writes.at(-1)).toBe("Pum · working");
    expect(orcaWrites.at(-1)).toContain('"state":"working"');

    agents = [subagent("starting")];
    managerListener?.({ type: "changed" });
    await settle(setup);
    expect(writes.at(-1)).toBe("Pum · working · 1 subagent");

    sessionListener?.({ type: "agent_settled" });
    await settle(setup);
    expect(writes.filter((title) => title === "Pum · working · 1 subagent")).toHaveLength(1);
    expect(orcaWrites.filter((sequence) => sequence.includes('"state":"working"'))).toHaveLength(1);

    agents = [subagent("completed")];
    managerListener?.({ type: "changed" });
    await settle(setup);
    expect(writes.at(-1)).toBe("Pum · idle");
    expect(orcaWrites.at(-1)).toContain('"state":"done"');
    expect(orcaWrites.at(-1)).not.toContain("sessionBoundary");

    await destroy();
    destroy = undefined;
    expect(writes.at(-1)).toBe("");
  });
});

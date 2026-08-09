import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_COMMUNICATION_SYSTEM_PROMPT,
  SUBAGENT_COORDINATION_SYSTEM_PROMPT,
  SubagentManager,
} from "./manager";

describe("SubagentManager extension", () => {
  test("registers main coordination tools", () => {
    const tools: string[] = [];
    const handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
    };
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
    });
    const events: any[] = [];
    manager.subscribe((event) => events.push(event));

    const extension = manager.mainExtension() as { factory: (api: any) => void };
    extension.factory(pi);

    expect(tools).toEqual([
      "spawn_subagent",
      "message_agent",
      "list_subagents",
      "stop_subagent",
      "worktree",
    ]);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    const beforeStart = handlers.get("before_agent_start")?.[0];
    const result = beforeStart?.({ systemPrompt: "base prompt" });
    expect(result.systemPrompt).toContain(SUBAGENT_COORDINATION_SYSTEM_PROMPT);
    expect(result.systemPrompt).toContain("Never wait for subagents with bash sleep");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("Do not automatically reply to an acknowledgement");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("stop the exchange immediately");

    handlers.get("message_start")?.[0]?.({
      message: {
        role: "custom",
        customType: "pum.agent_message",
        details: { id: "message-1" },
      },
    });
    expect(events).toContainEqual({ type: "main-pending-resolve", id: "message-1" });
  });

  test("restores parent metadata and migrates legacy records to main", async () => {
    const base = {
      name: "worker",
      task: "task",
      status: "idle",
      worktree: {
        name: "worker",
        path: "/tmp/worker",
        branch: "pum/worker",
        baseBranch: "main",
        baseCommit: "abc",
      },
      modelId: "mock/model",
      thinkingLevel: "off",
      startedAt: 1,
      updatedAt: 1,
    };
    const entries = [
      {
        type: "custom",
        customType: "pum.subagent",
        data: {
          event: "spawned",
          id: "parent",
          snapshot: { ...base, id: "parent", parentAgentId: null },
        },
      },
      {
        type: "custom",
        customType: "pum.subagent",
        data: {
          event: "spawned",
          id: "child",
          snapshot: { ...base, id: "child", parentAgentId: "parent" },
        },
      },
      {
        type: "custom",
        customType: "pum.subagent",
        data: {
          event: "usage",
          id: "child",
          usage: { tokens: 700, cost: 0.2, contextPct: 35 },
        },
      },
      {
        type: "custom",
        customType: "pum.subagent",
        data: {
          event: "spawned",
          id: "legacy",
          snapshot: { ...base, id: "legacy" },
        },
      },
    ];
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await manager.attachMain({ appendEntry() {} } as any, {
      getSessionId: () => "main-session",
      getEntries: () => entries,
    } as any, "/repo");

    expect(manager.getAgent("child")?.parentAgentId).toBe("parent");
    expect(manager.getAgent("child")?.usage).toEqual({ tokens: 700, cost: 0.2, contextPct: 35 });
    expect(manager.getAgent("legacy")?.parentAgentId).toBeNull();
    expect(manager.getAgent("legacy")?.usage).toEqual({ tokens: 0, cost: 0, contextPct: null });
  });

  test("binds the main session even when session_start was missed", async () => {
    const pi = {
      on() {},
      registerTool() {},
      appendEntry() {},
    };
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
    });
    const extension = manager.mainExtension() as { factory: (api: any) => void };
    extension.factory(pi);

    await manager.bindMainSession({
      getSessionId: () => "main-session",
      getEntries: () => [],
    } as any, "/repo");

    expect((manager as any).parentSessionId).toBe("main-session");
    expect((manager as any).mainApi).toBe(pi);
  });
});

import { describe, expect, test } from "bun:test";
import {
  MAX_ACTIVE_SUBAGENTS,
  SUBAGENT_COMMUNICATION_SYSTEM_PROMPT,
  SUBAGENT_COORDINATION_SYSTEM_PROMPT,
  SubagentManager,
  buildSubagentCapacityPrompt,
  countActiveSubagents,
  isCompletionOnlyMessage,
} from "./manager";
import type { SubagentStatus } from "./types";

function addTestAgent(manager: SubagentManager, id: string, status: SubagentStatus): void {
  (manager as any).records.set(id, {
    snapshot: {
      id,
      name: id,
      task: "test task",
      status,
      worktree: {
        name: id,
        path: `/tmp/${id}`,
        branch: `pum/${id}`,
        baseBranch: "main",
        baseCommit: "abc",
      },
      parentAgentId: null,
      modelId: "mock/model",
      thinkingLevel: "off",
      transcript: { lines: [], stream: null, pending: [] },
      startedAt: 1,
      updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
    },
  });
}

describe("SubagentManager extension", () => {
  test("registers main coordination tools", () => {
    const tools: string[] = [];
    const definitions = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
        definitions.set(tool.name, tool);
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
    expect(result.systemPrompt).toContain("0/5 active; 5 slots available");
    expect(result.systemPrompt).toContain("Prefer spawn_subagent for follow-up implementation work");
    expect(definitions.get("spawn_subagent").promptGuidelines).toContain(
      "For follow-up implementation work, prefer spawn_subagent while fewer than five subagents are starting or running.",
    );
    expect(definitions.get("spawn_subagent").promptGuidelines).toContain(
      "At five active subagents, queue related follow-up work through message_agent instead of spawning a sixth.",
    );
    expect(definitions.get("message_agent").description).toContain("durable queued message");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("Use finish_subagent as the only final completion report");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("Do not automatically reply to an acknowledgement");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("stop the exchange immediately");
    expect(SUBAGENT_COORDINATION_SYSTEM_PROMPT).toContain("A normal 'Message from <agent>' is not a completion notification");

    handlers.get("message_start")?.[0]?.({
      message: {
        role: "custom",
        customType: "pum.agent_message",
        details: { id: "message-1" },
      },
    });
    expect(events).toContainEqual({ type: "main-pending-resolve", id: "message-1" });
  });

  test("recognizes completion-only messages without blocking actionable communication", () => {
    expect(isCompletionOnlyMessage("Completed and committed all requested work. Tests pass.")).toBe(true);
    expect(isCompletionOnlyMessage("Implemented the feature as abc123. Validation passed.")).toBe(true);
    expect(isCompletionOnlyMessage("Task complete. No remaining concerns.")).toBe(true);
    expect(isCompletionOnlyMessage("Completed the first part. Please review the conflict.")).toBe(false);
    expect(isCompletionOnlyMessage("I am blocked on the API shape." )).toBe(false);
    expect(isCompletionOnlyMessage("Can you answer a question?" )).toBe(false);
  });

  test("blocks duplicate final reports from the child message tool", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const definitions = new Map<string, any>();
    const extension = (manager as any).childExtension("worker");
    extension.factory({
      on() {},
      registerTool(tool: any) {
        definitions.set(tool.name, tool);
      },
    });

    const messageTool = definitions.get("message_agent");
    expect(messageTool.description).toContain("Never use this tool for a final completion report");
    await expect(messageTool.execute("call-1", {
      target: "main",
      message: "Completed and committed the implementation. All tests pass.",
    })).rejects.toThrow("Use finish_subagent for the final summary");
  });

  test("counts only starting and running subagents as active", () => {
    const statuses: SubagentStatus[] = [
      "starting",
      "running",
      "idle",
      "completed",
      "failed",
      "stopped",
      "interrupted",
    ];
    expect(countActiveSubagents(statuses.map((status) => ({ status })))).toBe(2);
  });

  test("changes follow-up guidance when all five active slots are used", () => {
    expect(buildSubagentCapacityPrompt(4)).toContain("4/5 active; 1 slot available");
    expect(buildSubagentCapacityPrompt(4)).toContain("Prefer spawn_subagent");
    expect(buildSubagentCapacityPrompt(5)).toContain("no slots available");
    expect(buildSubagentCapacityPrompt(5)).toContain("appropriate related running subagent");
    expect(buildSubagentCapacityPrompt(5)).toContain("keep the work pending");
  });

  test("rejects a sixth active subagent with durable queue guidance", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    for (let index = 0; index < MAX_ACTIVE_SUBAGENTS; index += 1) {
      addTestAgent(manager, `active-${index}`, index === 0 ? "starting" : "running");
    }
    addTestAgent(manager, "idle-retained", "idle");
    addTestAgent(manager, "completed-retained", "completed");

    expect(manager.activeCount()).toBe(5);
    await expect(manager.spawn({
      task: "Follow-up implementation",
      modelId: "mock/model",
      thinkingLevel: "off",
    })).rejects.toThrow(
      "All 5 subagent slots are active (starting or running). Queue follow-up work to an appropriate related running subagent with message_agent.",
    );
  });

  test("injects at-capacity guidance into the main system prompt", () => {
    const handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
    };
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    for (let index = 0; index < MAX_ACTIVE_SUBAGENTS; index += 1) {
      addTestAgent(manager, `active-${index}`, "running");
    }
    (manager.mainExtension() as { factory: (api: any) => void }).factory(pi);

    const result = handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base prompt" });
    expect(result.systemPrompt).toContain("5/5 active; no slots available");
    expect(result.systemPrompt).toContain("Queue follow-up work with message_agent");
    expect(result.systemPrompt).toContain("keep the work pending for deliberate routing");
  });

  test("notifies an idle main after a user instruction reaches a subagent", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "idle");
    const record = (manager as any).records.get("worker");
    const deliveries: any[] = [];
    const events: any[] = [];
    manager.subscribe((event) => events.push(event));
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any, options: any) {
        deliveries.push({ message, options });
      },
    };
    (manager as any).parentSessionId = "main-session";
    record.session = {
      isStreaming: false,
      sessionId: "child-session",
      sessionManager: { appendCustomEntry() {} },
      prompt: async (text: string) => {
        (manager as any).processSessionEvent(record, {
          type: "message_start",
          message: { role: "user", content: text },
        });
      },
    };

    await manager.sendUserMessage("worker", "Check the parser edge case.");
    await Promise.resolve();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(deliveries[0].message.content).toContain("subagent worker");
    expect(deliveries[0].message.content).toContain("Check the parser edge case.");
    expect(events.filter((event) => event.type === "main-pending-add")).toHaveLength(1);
    expect(events.some((event) => event.type === "main-line")).toBe(false);
  });

  test("steers a busy main and resolves the notice without splitting its stream", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    const handlers = new Map<string, Function[]>();
    const deliveries: any[] = [];
    const events: any[] = [];
    manager.subscribe((event) => events.push(event));
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
      appendEntry() {},
      sendMessage(message: any, options: any) {
        deliveries.push({ message, options });
      },
    };
    (manager.mainExtension() as any).factory(pi);
    (manager as any).parentSessionId = "main-session";
    handlers.get("agent_start")?.[0]?.({});
    record.session = {
      isStreaming: true,
      sessionId: "child-session",
      sessionManager: { appendCustomEntry() {} },
      steer: async (text: string) => {
        (manager as any).processSessionEvent(record, {
          type: "message_start",
          message: { role: "user", content: text },
        });
      },
    };

    await manager.sendUserMessage("worker", "Use the new fixture.");
    const pending = events.find((event) => event.type === "main-pending-add").pending;
    handlers.get("message_start")?.[0]?.({
      message: {
        role: "custom",
        customType: "pum.agent_message",
        details: { id: pending.id },
      },
    });

    expect(deliveries[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(events).toContainEqual({ type: "main-pending-resolve", id: pending.id });
  });

  test("cleans up a failed subagent steer without notifying main", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    const deliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    };
    record.session = {
      isStreaming: true,
      sessionId: "child-session",
      sessionManager: { appendCustomEntry() {} },
      steer: async () => { throw new Error("delivery failed"); },
    };

    await expect(manager.sendUserMessage("worker", "Do not lose this.")).rejects.toThrow("delivery failed");
    expect(record.snapshot.transcript.pending).toEqual([]);
    expect(record.userInstructionNotices.size).toBe(0);
    expect(deliveries).toEqual([]);
  });

  test("does not notify main when queued subagent delivery is cancelled", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    const deliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    };
    record.session = {
      isStreaming: true,
      sessionId: "child-session",
      sessionManager: { appendCustomEntry() {} },
      steer: async () => {},
      clearQueue: () => ({ steering: ["Cancel this instruction."], followUp: [] }),
      abort: async () => {},
    };

    await manager.sendUserMessage("worker", "Cancel this instruction.");
    await manager.abortAgent("worker");

    expect(record.snapshot.transcript.pending).toEqual([]);
    expect(record.userInstructionNotices.size).toBe(0);
    expect(deliveries).toEqual([]);
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
    expect(manager.getAgent("child")?.usage).toEqual({
      outgoing: 700,
      incoming: 0,
      cacheRead: 0,
      cost: 0.2,
      contextPct: 35,
    });
    expect(manager.getAgent("legacy")?.parentAgentId).toBeNull();
    expect(manager.getAgent("legacy")?.usage).toEqual({
      outgoing: 0,
      incoming: 0,
      cacheRead: 0,
      cost: 0,
      contextPct: null,
    });
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

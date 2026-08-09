import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_COMMUNICATION_SYSTEM_PROMPT,
  SUBAGENT_COORDINATION_SYSTEM_PROMPT,
  SubagentManager,
  buildSubagentCapacityPrompt,
  countActiveSubagents,
  isCompletionOnlyMessage,
} from "./manager";
import { MESSAGE_CACHE_TOOLS } from "../message-cache";
import { TRIGGER_EVENT_CUSTOM_TYPE, type SubagentStatus } from "./types";

function addTestAgent(
  manager: SubagentManager,
  id: string,
  status: SubagentStatus,
  parentAgentId: string | null = null,
): void {
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
      parentAgentId,
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
    expect(result.systemPrompt).toContain("0/10 active; 10 slots available");
    expect(result.systemPrompt).toContain("Prefer spawn_subagent for follow-up implementation work");
    expect(definitions.get("spawn_subagent").promptGuidelines).toContain(
      "For follow-up implementation work, prefer spawn_subagent while configured capacity is available.",
    );
    expect(definitions.get("spawn_subagent").promptGuidelines).toContain(
      "At configured capacity, queue related follow-up work through message_agent instead of spawning another agent.",
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

  test("binds message cache tools to exact main and child requesters", () => {
    const requesters: any[] = [];
    const messageCacheController = {
      registerTools(pi: any, requesterFactory: (ctx: any) => any) {
        for (const name of MESSAGE_CACHE_TOOLS) pi.registerTool({ name });
        requesters.push(requesterFactory({ sessionManager: { getSessionId: () => "main-session" } }));
      },
      releaseRequester() {},
    };
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      messageCacheController: messageCacheController as any,
    });
    addTestAgent(manager, "child-1", "idle");
    const tools: string[] = [];
    const pi = {
      on() {},
      registerTool(tool: { name: string }) { tools.push(tool.name); },
    };

    (manager.mainExtension() as any).factory(pi);
    ((manager as any).childExtension("child-1") as any).factory(pi);

    expect(tools.filter((name) => name.startsWith("message_cache_"))).toEqual([
      ...MESSAGE_CACHE_TOOLS,
      ...MESSAGE_CACHE_TOOLS,
    ]);
    expect(requesters).toEqual([
      { kind: "main", id: "main-session", name: "main" },
      { kind: "subagent", id: "child-1", name: "child-1" },
    ]);
  });

  test("routes typed trigger events to the exact main and child sessions", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    const mainDeliveries: any[] = [];
    const mainEntries: any[] = [];
    (manager as any).parentSessionId = "main-session";
    (manager as any).mainRunning = true;
    (manager as any).mainApi = {
      appendEntry(customType: string, data: any) { mainEntries.push({ customType, data }); },
      sendMessage(message: any, options: any) { mainDeliveries.push({ message, options }); },
    };
    await manager.deliverTriggerEvent({
      id: "event-main",
      triggerId: "trigger-main",
      triggerName: "tests",
      sessionId: "main-session",
      agentId: null,
      text: "Main tests completed.",
      at: 1,
    });
    expect(mainEntries[0].customType).toBe(TRIGGER_EVENT_CUSTOM_TYPE);
    expect(mainDeliveries[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });

    addTestAgent(manager, "child", "idle");
    const childEntries: any[] = [];
    const childDeliveries: any[] = [];
    const record = (manager as any).records.get("child");
    record.session = {
      sessionId: "child-session",
      sessionManager: {
        appendCustomEntry(customType: string, data: any) { childEntries.push({ customType, data }); },
      },
    };
    record.api = {
      sendMessage(message: any, options: any) { childDeliveries.push({ message, options }); },
    };
    await manager.deliverTriggerEvent({
      id: "event-child",
      triggerId: "trigger-child",
      triggerName: "build",
      sessionId: "child-session",
      agentId: "child",
      text: "Child build completed.",
      at: 2,
    });
    expect(childEntries[0].customType).toBe(TRIGGER_EVENT_CUSTOM_TYPE);
    expect(childDeliveries[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    await expect(manager.deliverTriggerEvent({
      id: "wrong-session",
      triggerId: "trigger-child",
      triggerName: "build",
      sessionId: "other-session",
      agentId: "child",
      text: "Wrong target.",
      at: 3,
    })).rejects.toThrow("unavailable");
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
    await expect(messageTool.execute("call-2", {
      target: "parent",
      message: "Completed and committed the nested implementation. All tests pass.",
    })).rejects.toThrow("Use finish_subagent for the final summary");
  });

  test("finish_subagent notifies main for a main-spawned child", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "child", "running");
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

    const tools = new Map<string, any>();
    (manager as any).childExtension("child").factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });
    await tools.get("finish_subagent").execute("finish-1", { summary: "Child work passed." });
    (manager as any).processSessionEvent((manager as any).records.get("child"), {
      type: "agent_settled",
    });
    await Promise.resolve();

    expect(manager.getAgent("child")?.status).toBe("completed");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].message.content).toContain("Subagent child completed.");
    expect(deliveries[0].message.content).toContain("summary: Child work passed.");
    expect(deliveries[0].message.details.recipient).toBe("main");
    expect(events.filter((event) => event.type === "main-line")).toHaveLength(1);
  });

  test("finish_subagent notifies only the direct subagent spawner", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "idle");
    addTestAgent(manager, "child", "running", "parent");
    const mainDeliveries: any[] = [];
    const parentDeliveries: any[] = [];
    const events: any[] = [];
    manager.subscribe((event) => events.push(event));
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { mainDeliveries.push(message); },
    };
    const parent = (manager as any).records.get("parent");
    parent.session = {
      sessionId: "parent-session",
      isStreaming: false,
    };
    parent.api = {
      sendMessage(message: any, options: any) {
        parentDeliveries.push({ message, options });
      },
    };

    const tools = new Map<string, any>();
    (manager as any).childExtension("child").factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });
    await tools.get("finish_subagent").execute("finish-1", { summary: "Nested child passed." });
    (manager as any).processSessionEvent((manager as any).records.get("child"), {
      type: "agent_settled",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getAgent("child")?.status).toBe("completed");
    expect(parentDeliveries).toHaveLength(1);
    expect(parentDeliveries[0].message.content).toContain("Subagent child completed.");
    expect(parentDeliveries[0].message.details.recipient).toBe("parent");
    expect(parentDeliveries[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(manager.getAgent("parent")?.transcript.pending).toHaveLength(1);
    expect(mainDeliveries).toEqual([]);
    expect(events.some((event) => event.type === "main-line")).toBe(false);
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

  test("uses default, lower, higher, and validated active limits", () => {
    const defaultManager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    const lowerManager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 2 });
    const higherManager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 20 });
    const invalidManager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 0 });

    expect(defaultManager.getMaxActiveSubagents()).toBe(10);
    expect(lowerManager.getMaxActiveSubagents()).toBe(2);
    expect(higherManager.getMaxActiveSubagents()).toBe(20);
    expect(invalidManager.getMaxActiveSubagents()).toBe(10);
    higherManager.setMaxActiveSubagents(25);
    expect(higherManager.getMaxActiveSubagents()).toBe(25);
    higherManager.setMaxActiveSubagents(26);
    expect(higherManager.getMaxActiveSubagents()).toBe(10);
  });

  test("blocks managed parent merge for a direct running child", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "idle");
    addTestAgent(manager, "child", "running", "parent");

    await expect((manager as any).worktreeAction("/tmp", "merge", "parent"))
      .rejects.toThrow("Cannot merge parent while retained descendants remain:\n- child (running)");
  });

  test("blocks managed parent closure for completed and recursive descendants", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "idle");
    addTestAgent(manager, "child", "completed", "parent");
    addTestAgent(manager, "grandchild", "interrupted", "child");
    addTestAgent(manager, "unrelated", "failed");

    await expect((manager as any).worktreeAction("/tmp", "merge", "parent")).rejects.toThrow(
      "Cannot merge parent while retained descendants remain:\n- grandchild (interrupted)\n- child (completed)",
    );
    expect(() => (manager as any).assertNoRetainedDescendants(
      (manager as any).records.get("unrelated"),
      "merge",
    )).not.toThrow();
  });

  test("blocks finish_subagent until every descendant closes", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "idle");
    addTestAgent(manager, "child", "failed", "parent");
    const tools = new Map<string, any>();
    (manager as any).childExtension("parent").factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });

    await expect(tools.get("finish_subagent").execute("finish-parent", { summary: "Done." }))
      .rejects.toThrow("Cannot finish parent while retained descendants remain:\n- child (failed)");
    expect((manager as any).records.get("parent").finishRequested).toBeUndefined();
  });

  test("rejects a child spawn after its parent requests finish", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "running");
    const tools = new Map<string, any>();
    (manager as any).childExtension("parent").factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });
    await tools.get("finish_subagent").execute("finish-parent", { summary: "Done." });

    await expect(manager.spawn({
      task: "Late child.",
      name: "late-child",
      modelId: "mock/model",
      thinkingLevel: "off",
      parentAgentId: "parent",
    })).rejects.toThrow("Spawner subagent is finishing");
  });

  test("nested parent worktree tool uses the authoritative recursive guard", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "completed");
    addTestAgent(manager, "child", "completed", "parent");
    addTestAgent(manager, "grandchild", "failed", "child");
    const tools = new Map<string, any>();
    (manager as any).childExtension("parent").factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });

    expect(tools.has("worktree")).toBe(true);
    await expect(tools.get("worktree").execute("merge-parent", { action: "merge", target: "parent" }))
      .rejects.toThrow("- grandchild (failed)\n- child (completed)");
  });

  test("nested agents receive the configured capacity and recursive closure guidance", () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 14 });
    addTestAgent(manager, "parent", "idle");
    const handlers = new Map<string, Function>();
    (manager as any).childExtension("parent").factory({
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool() {},
    });

    const result = handlers.get("before_agent_start")?.({ systemPrompt: "base" });
    expect(result.systemPrompt).toContain("0/14 active; 14 slots available");
    expect(result.systemPrompt).toContain("recursively merge or resolve every retained descendant");
    expect(result.systemPrompt).toContain("Before finish_subagent");
  });

  test("managed force removal cannot discard failed or unmerged work", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "failed-child", "failed");
    await expect((manager as any).worktreeAction("/tmp", "remove", "failed-child", undefined, true))
      .rejects.toThrow("Cannot force-remove managed subagent failed-child");
    expect(manager.getAgent("failed-child")).toBeDefined();
  });

  test("changes follow-up guidance at the configured capacity", () => {
    expect(buildSubagentCapacityPrompt(3, 4)).toContain("3/4 active; 1 slot available");
    expect(buildSubagentCapacityPrompt(3, 4)).toContain("Prefer spawn_subagent");
    expect(buildSubagentCapacityPrompt(4, 4)).toContain("no slots available");
    expect(buildSubagentCapacityPrompt(4, 4)).toContain("appropriate related running subagent");
    expect(buildSubagentCapacityPrompt(4, 4)).toContain("keep the work pending");
  });

  test("rejects another active subagent at a custom lower limit", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 3 });
    for (let index = 0; index < 3; index += 1) {
      addTestAgent(manager, `active-${index}`, index === 0 ? "starting" : "running");
    }
    addTestAgent(manager, "idle-retained", "idle");
    addTestAgent(manager, "completed-retained", "completed");

    expect(manager.activeCount()).toBe(3);
    await expect(manager.spawn({
      task: "Follow-up implementation",
      modelId: "mock/model",
      thinkingLevel: "off",
    })).rejects.toThrow(
      "All 3 subagent slots are active (starting or running). Queue follow-up work to an appropriate related running subagent with message_agent.",
    );
  });

  test("injects custom at-capacity guidance into the main system prompt", () => {
    const handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
    };
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 12 });
    for (let index = 0; index < 12; index += 1) {
      addTestAgent(manager, `active-${index}`, "running");
    }
    (manager.mainExtension() as { factory: (api: any) => void }).factory(pi);

    const result = handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base prompt" });
    expect(result.systemPrompt).toContain("12/12 active; no slots available");
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
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", maxActiveSubagents: 1 });
    await manager.attachMain({ appendEntry() {} } as any, {
      getSessionId: () => "main-session",
      getEntries: () => entries,
    } as any, "/repo");

    expect(manager.getAgent("child")?.parentAgentId).toBe("parent");
    expect(manager.activeCount()).toBe(0);
    expect(manager.getMaxActiveSubagents()).toBe(1);
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
    await expect((manager as any).worktreeAction("/repo", "merge", "parent"))
      .rejects.toThrow("Cannot merge worker while retained descendants remain:\n- worker (idle)");
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

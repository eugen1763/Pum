import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_COMMUNICATION_SYSTEM_PROMPT,
  SUBAGENT_COORDINATION_SYSTEM_PROMPT,
  SubagentManager,
  buildSubagentCapacityPrompt,
  countActiveSubagents,
  isAcknowledgementOnlyMessage,
  isCompletionOnlyMessage,
} from "./manager";
import { MESSAGE_CACHE_TOOLS } from "../message-cache";
import { TRIGGER_EVENT_CUSTOM_TYPE, type SubagentStatus, type TriggerEventData } from "./types";
import { SpawnPreviewManager } from "./spawn-preview";

function triggerEvent(overrides: Partial<TriggerEventData> = {}): TriggerEventData {
  return {
    id: "event",
    version: 1,
    triggerId: "trigger",
    name: "tests",
    state: "waiting",
    target: { sessionId: "main-session", agentId: null, label: "main" },
    executable: "bun",
    args: ["test"],
    at: 1,
    fireCount: 1,
    pendingCount: 1,
    coalescedCount: 0,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    manual: false,
    text: "Tests completed.",
    ...overrides,
  };
}

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
    activityGeneration: 0,
    idleNotifiedGeneration: 0,
  });
}

function processAgentEvent(manager: SubagentManager, id: string, event: any): void {
  (manager as any).processSessionEvent((manager as any).records.get(id), event);
}

function settleAgent(manager: SubagentManager, id: string): void {
  processAgentEvent(manager, id, { type: "agent_settled" });
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
    expect(definitions.get("spawn_subagent").parameters.properties.preview).toBeDefined();
    expect(definitions.get("spawn_subagent").promptGuidelines).toContain(
      "For follow-up implementation work, prefer spawn_subagent while configured capacity is available.",
    );
    expect(definitions.get("spawn_subagent").promptGuidelines).toContain(
      "At configured capacity, queue related follow-up work through message_agent instead of spawning another agent.",
    );
    expect(definitions.get("message_agent").description).toContain("durable queued message");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("Use finish_subagent as the only final completion report");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("exactly one successful finish_subagent call");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("Do not automatically reply to an acknowledgement");
    expect(SUBAGENT_COMMUNICATION_SYSTEM_PROMPT).toContain("stop the exchange immediately");
    expect(SUBAGENT_COORDINATION_SYSTEM_PROMPT).toContain("A normal 'Message from <agent>' is not a completion notification");
    expect(SUBAGENT_COORDINATION_SYSTEM_PROMPT).toContain("An idle settlement is not completion");
    expect(SUBAGENT_COORDINATION_SYSTEM_PROMPT).not.toContain("as soon as it settles");

    handlers.get("message_start")?.[0]?.({
      message: {
        role: "custom",
        customType: "pum.agent_message",
        details: { id: "message-1" },
      },
    });
    expect(events).toContainEqual({ type: "main-pending-resolve", id: "message-1" });
  });

  test("previews main and child spawns without side effects, then delivers an optional note", async () => {
    const previewManager = new SpawnPreviewManager();
    const unsubscribe = previewManager.subscribe(() => {});
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      spawnPreviewManager: previewManager,
    });
    addTestAgent(manager, "parent", "running");
    const spawned: any[] = [];
    const notes: any[] = [];
    (manager as any).attachMain = async () => {};
    (manager as any).spawn = async (options: any) => {
      spawned.push(options);
      return {
        ...((manager as any).records.get("parent").snapshot),
        id: "spawned",
        name: "spawned",
        task: options.task,
        parentAgentId: options.parentAgentId ?? null,
      };
    };
    (manager as any).sendUserMessage = async (...args: any[]) => { notes.push(args); };

    const mainTools = new Map<string, any>();
    const mainPi = { on() {}, registerTool(tool: any) { mainTools.set(tool.name, tool); } };
    (manager.mainExtension() as any).factory(mainPi);
    const mainRun = mainTools.get("spawn_subagent").execute("tool", {
      task: "Main preview task",
      preview: true,
    }, undefined, undefined, {
      sessionManager: { getSessionId: () => "main-session" },
      cwd: "/repo",
      model: { provider: "mock", id: "model" },
      thinkingLevel: "off",
    });
    await Promise.resolve();
    expect(spawned).toEqual([]);
    expect(previewManager.current()?.requester).toEqual({ sessionId: "main-session", agentId: null, name: "main" });
    previewManager.approve("Follow this note");
    await mainRun;
    expect(spawned[0].task).toBe("Main preview task");
    expect(notes).toEqual([["spawned", "Follow this note"]]);

    const childTools = new Map<string, any>();
    const childPi = { on() {}, registerTool(tool: any) { childTools.set(tool.name, tool); } };
    ((manager as any).childExtension("parent") as any).factory(childPi);
    const childRun = childTools.get("spawn_subagent").execute("tool", {
      task: "Nested preview task",
      preview: true,
    }, undefined, undefined, {
      sessionManager: { getSessionId: () => "child-session" },
    });
    await Promise.resolve();
    expect(previewManager.current()?.requester).toEqual({ sessionId: "child-session", agentId: "parent", name: "parent" });
    previewManager.cancel();
    const cancelled = await childRun;
    expect(cancelled.content[0].text).toContain("Spawn cancelled");
    expect(spawned).toHaveLength(1);
    unsubscribe();
  });

  test("checks spawn capacity only after preview approval and keeps empty notes out of delivery", async () => {
    const previewManager = new SpawnPreviewManager();
    const unsubscribe = previewManager.subscribe(() => {});
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test", spawnPreviewManager: previewManager });
    (manager as any).attachMain = async () => {};
    let spawnCalls = 0;
    (manager as any).spawn = async () => {
      spawnCalls += 1;
      throw new Error("All 1 subagent slots are active");
    };
    let noteCalls = 0;
    (manager as any).sendUserMessage = async () => { noteCalls += 1; };
    const tools = new Map<string, any>();
    (manager.mainExtension() as any).factory({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } });
    const run = tools.get("spawn_subagent").execute("tool", { task: "Wait for approval", preview: true }, undefined, undefined, {
      sessionManager: { getSessionId: () => "main-session" }, cwd: "/repo",
      model: { provider: "mock", id: "model" }, thinkingLevel: "off",
    });
    await Promise.resolve();
    expect(spawnCalls).toBe(0);
    previewManager.approve("");
    await expect(run).rejects.toThrow("All 1 subagent slots are active");
    expect(spawnCalls).toBe(1);
    expect(noteCalls).toBe(0);
    unsubscribe();
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
    await manager.deliverTriggerEvent(triggerEvent({
      id: "event-main",
      triggerId: "trigger-main",
      text: "Main tests completed.",
    }));
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
    await manager.deliverTriggerEvent(triggerEvent({
      id: "event-child",
      triggerId: "trigger-child",
      name: "build",
      target: { sessionId: "child-session", agentId: "child", label: "child" },
      text: "Child build completed.",
      at: 2,
    }));
    expect(childEntries[0].customType).toBe(TRIGGER_EVENT_CUSTOM_TYPE);
    expect(childDeliveries[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    await expect(manager.deliverTriggerEvent(triggerEvent({
      id: "wrong-session",
      triggerId: "trigger-child",
      name: "build",
      target: { sessionId: "other-session", agentId: "child", label: "child" },
      text: "Wrong target.",
      at: 3,
    }))).rejects.toThrow("unavailable");
  });

  test("invalidates exact child triggers when a retained agent stops", async () => {
    const invalidated: Array<[string, string]> = [];
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      triggerManager: {
        invalidateAgent: async (sessionId: string, agentId: string) => { invalidated.push([sessionId, agentId]); },
      } as any,
    });
    addTestAgent(manager, "stopping", "idle");
    const record = (manager as any).records.get("stopping");
    record.session = { sessionId: "stopping-session" };
    record.dispose = async () => { record.session = undefined; };

    await manager.stop("stopping");
    expect(invalidated).toEqual([["stopping-session", "stopping"]]);
  });

  test("recognizes completion-only messages without blocking actionable communication", () => {
    expect(isCompletionOnlyMessage("Completed and committed all requested work. Tests pass.")).toBe(true);
    expect(isCompletionOnlyMessage("Implemented the feature as abc123. Validation passed.")).toBe(true);
    expect(isCompletionOnlyMessage("Task complete. No remaining concerns.")).toBe(true);
    expect(isCompletionOnlyMessage("Completed the first part. Please review the conflict.")).toBe(false);
    expect(isCompletionOnlyMessage("I am blocked on the API shape." )).toBe(false);
    expect(isCompletionOnlyMessage("Can you answer a question?" )).toBe(false);
    expect(isAcknowledgementOnlyMessage("Acknowledged.")).toBe(true);
    expect(isAcknowledgementOnlyMessage("Thanks!" )).toBe(true);
    expect(isAcknowledgementOnlyMessage("Thanks, please run the tests." )).toBe(false);
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

  test("sends one initial idle notice and suppresses duplicate settles", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const deliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    };

    processAgentEvent(manager, "worker", { type: "message_start", message: { role: "user", content: "Initial task" } });
    processAgentEvent(manager, "worker", { type: "agent_end" });
    settleAgent(manager, "worker");
    settleAgent(manager, "worker");
    await Promise.resolve();

    expect(deliveries.filter((delivery) => delivery.details.kind === "idle")).toHaveLength(1);
    expect(manager.getAgent("worker")?.status).toBe("idle");
  });

  test("sends a fresh idle notice after each accepted main, sibling, or trigger cycle", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "sender", "idle");
    addTestAgent(manager, "worker", "idle");
    const mainDeliveries: any[] = [];
    const childDeliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { mainDeliveries.push(message); },
    };
    const worker = (manager as any).records.get("worker");
    worker.session = {
      sessionId: "worker-session",
      isStreaming: false,
      sessionManager: { appendCustomEntry() {} },
    };
    worker.api = {
      sendMessage(message: any) { childDeliveries.push(message); },
    };

    await manager.routeMessage("main", "worker", "Run the main-requested check.");
    processAgentEvent(manager, "worker", {
      type: "message_start",
      message: { role: "custom", ...childDeliveries.shift() },
    });
    settleAgent(manager, "worker");
    await manager.routeMessage("sender", "worker", "Run the sibling review.");
    processAgentEvent(manager, "worker", {
      type: "message_start",
      message: { role: "custom", ...childDeliveries.shift() },
    });
    settleAgent(manager, "worker");
    processAgentEvent(manager, "worker", {
      type: "message_start",
      message: {
        role: "custom",
        customType: TRIGGER_EVENT_CUSTOM_TYPE,
        details: { id: "trigger-event" },
      },
    });
    settleAgent(manager, "worker");
    await Promise.resolve();

    expect(mainDeliveries.filter((delivery) => delivery.details.kind === "idle")).toHaveLength(3);
  });

  test("routes child-woken re-idle only to the direct spawner", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "grandparent", "idle");
    addTestAgent(manager, "parent", "idle", "grandparent");
    addTestAgent(manager, "child", "idle", "parent");
    const mainDeliveries: any[] = [];
    const parentInputs: any[] = [];
    const grandparentInputs: any[] = [];
    (manager as any).mainApi = { appendEntry() {}, sendMessage(message: any) { mainDeliveries.push(message); } };
    for (const [id, inputs] of [["parent", parentInputs], ["grandparent", grandparentInputs]] as const) {
      const record = (manager as any).records.get(id);
      record.session = {
        sessionId: `${id}-session`,
        isStreaming: false,
        sessionManager: { appendCustomEntry() {} },
      };
      record.api = { sendMessage(message: any) { inputs.push(message); } };
    }

    await manager.routeMessage("child", "parent", "Inspect the child result.");
    processAgentEvent(manager, "parent", {
      type: "message_start",
      message: { role: "custom", ...parentInputs.shift() },
    });
    settleAgent(manager, "parent");
    await Promise.resolve();

    expect(grandparentInputs).toHaveLength(1);
    expect(grandparentInputs[0].details.kind).toBe("idle");
    expect(grandparentInputs[0].details.recipient).toBe("grandparent");
    expect(mainDeliveries).toEqual([]);
  });

  test("does not create cycles for failed delivery, lifecycle notices, or acknowledgements", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "sender", "idle");
    addTestAgent(manager, "worker", "idle");
    const mainDeliveries: any[] = [];
    (manager as any).mainApi = { appendEntry() {}, sendMessage(message: any) { mainDeliveries.push(message); } };
    const worker = (manager as any).records.get("worker");
    worker.session = {
      sessionId: "worker-session",
      isStreaming: false,
      sessionManager: { appendCustomEntry() {} },
    };
    worker.api = { sendMessage() { throw new Error("delivery failed"); } };

    await expect(manager.routeMessage("sender", "worker", "Do the work.")).rejects.toThrow("delivery failed");
    expect(worker.snapshot.transcript.pending).toEqual([]);
    settleAgent(manager, "worker");

    for (const kind of ["idle", "completion", "status", "acknowledgement"] as const) {
      processAgentEvent(manager, "worker", {
        type: "message_start",
        message: {
          role: "custom",
          customType: "pum.agent_message",
          details: { id: kind, kind },
        },
      });
      settleAgent(manager, "worker");
    }
    await Promise.resolve();

    expect(mainDeliveries).toEqual([]);
  });

  test("restores interrupted activity as consumed before a new cycle", async () => {
    const entries = [
      {
        type: "custom",
        customType: "pum.subagent",
        data: {
          event: "spawned",
          id: "worker",
          snapshot: {
            id: "worker",
            name: "worker",
            task: "task",
            status: "running",
            worktree: { name: "worker", path: "/tmp/worker", branch: "pum/worker", baseBranch: "main", baseCommit: "abc" },
            parentAgentId: null,
            modelId: "mock/model",
            thinkingLevel: "off",
            startedAt: 1,
            updatedAt: 1,
            usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
          },
        },
      },
      {
        type: "custom",
        customType: "pum.subagent",
        data: { event: "activity", id: "worker", activityGeneration: 3, idleNotifiedGeneration: 2 },
      },
    ];
    const deliveries: any[] = [];
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await manager.attachMain({ appendEntry() {}, sendMessage(message: any) { deliveries.push(message); } } as any, {
      getSessionId: () => "main-session",
      getEntries: () => entries,
    } as any, "/repo");

    expect(manager.getAgent("worker")?.status).toBe("interrupted");
    settleAgent(manager, "worker");
    processAgentEvent(manager, "worker", { type: "message_start", message: { role: "user", content: "Resume with new work" } });
    settleAgent(manager, "worker");
    await Promise.resolve();

    expect(deliveries.filter((delivery) => delivery.details.kind === "idle")).toHaveLength(1);
  });

  test("keeps a failed main wake unacknowledged and retries the stable message ID", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const events: any[] = [];
    const lines: any[] = [];
    manager.subscribe((event) => {
      if (event.type === "main-line") lines.push(event.line);
    });
    (manager as any).mainApi = {
      appendEntry(_type: string, event: any) { events.push(event); },
      sendMessage() { throw new Error("main wake failed"); },
    };

    processAgentEvent(manager, "worker", { type: "message_start", message: { role: "user", content: "Work" } });
    settleAgent(manager, "worker");
    await Promise.resolve();
    const unacknowledged = [...(manager as any).settlements.values()][0];
    expect(unacknowledged.acknowledgedAt).toBeUndefined();
    expect(lines).toEqual([]);

    const deliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry(_type: string, event: any) { events.push(event); },
      sendMessage(message: any) { deliveries.push(message); },
    };
    await (manager as any).retrySettlementsForParent(null);
    await (manager as any).retrySettlementsForParent(null);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].details.id).toBe(unacknowledged.messageId);
    expect(lines).toHaveLength(1);
    expect(unacknowledged.acknowledgedAt).toBeUndefined();

    (manager as any).acknowledgeSettlementMessage(unacknowledged.messageId);

    expect(events.filter((event) => event.event === "settlement").at(-1).settlement.acknowledgedAt).toBeNumber();
  });

  test("persists finish intent before finish_subagent returns and restores completion delivery", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const entries: any[] = [{
      type: "custom",
      customType: "pum.subagent",
      data: {
        event: "spawned",
        id: "worker",
        snapshot: { ...(manager.getAgent("worker") as any), transcript: undefined },
      },
    }];
    (manager as any).mainApi = {
      appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    };
    const tools = new Map<string, any>();
    (manager as any).childExtension("worker").factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });

    await tools.get("finish_subagent").execute("finish", { summary: "Persisted summary." });
    expect(entries.at(-1).data).toMatchObject({
      event: "finish",
      id: "worker",
      finishSummary: "Persisted summary.",
    });

    const deliveries: any[] = [];
    const restored = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await restored.attachMain({
      appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
      sendMessage(message: any) { deliveries.push(message); },
    } as any, {
      getSessionId: () => "main-session",
      getEntries: () => entries,
    } as any, "/repo");
    settleAgent(restored, "worker");
    await Promise.resolve();

    expect(restored.getAgent("worker")?.status).toBe("completed");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].content).toContain("summary: Persisted summary.");
    expect(entries.some((entry) => entry.data?.event === "finish" && entry.data.finishSummary === null)).toBe(true);
  });

  test("retries an unacknowledged persisted settlement and skips an acknowledged settlement", async () => {
    const baseSnapshot = {
      id: "worker",
      name: "worker",
      task: "task",
      status: "idle",
      worktree: { name: "worker", path: "/tmp/worker", branch: "pum/worker", baseBranch: "main", baseCommit: "abc" },
      parentAgentId: null,
      modelId: "mock/model",
      thinkingLevel: "off",
      startedAt: 1,
      updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
    };
    const settlement = {
      id: "worker:1:idle",
      messageId: "settlement-worker:1:idle",
      agentId: "worker",
      parentAgentId: null,
      status: "idle",
      activityGeneration: 1,
      content: "Subagent worker idle.",
      createdAt: 2,
    };
    const entries = [
      { type: "custom", customType: "pum.subagent", data: { event: "spawned", id: "worker", snapshot: baseSnapshot } },
      { type: "custom", customType: "pum.subagent", data: { event: "settlement", id: "worker", settlement } },
    ];
    const deliveries: any[] = [];
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await manager.attachMain({
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    } as any, { getSessionId: () => "main", getEntries: () => entries } as any, "/repo");
    expect(deliveries.map((delivery) => delivery.details.id)).toEqual([settlement.messageId]);

    const acknowledgedEntries = [
      ...entries,
      {
        type: "custom",
        customType: "pum.subagent",
        data: {
          event: "settlement",
          id: "worker",
          settlement: { ...settlement, acknowledgedAt: 3 },
        },
      },
    ];
    const secondDeliveries: any[] = [];
    const restored = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await restored.attachMain({
      appendEntry() {},
      sendMessage(message: any) { secondDeliveries.push(message); },
    } as any, { getSessionId: () => "main", getEntries: () => acknowledgedEntries } as any, "/repo");
    expect(secondDeliveries).toEqual([]);
  });

  test("retries a nested settlement only when the exact parent runtime accepts it", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "idle");
    addTestAgent(manager, "child", "running", "parent");
    const child = (manager as any).records.get("child");
    child.activityGeneration = 1;
    await (manager as any).recordSettlement(child, "idle");
    const settlement = [...(manager as any).settlements.values()][0];
    expect(settlement.acknowledgedAt).toBeUndefined();

    const parent = (manager as any).records.get("parent");
    const deliveries: any[] = [];
    parent.session = {
      sessionId: "parent-session",
      isStreaming: false,
      sessionManager: { getEntries: () => [], appendCustomEntry() {} },
    };
    parent.api = { sendMessage(message: any) { deliveries.push(message); } };
    await (manager as any).retrySettlementsForParent("parent");
    await (manager as any).retrySettlementsForParent("parent");

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].details.id).toBe(settlement.messageId);
    expect(settlement.acknowledgedAt).toBeUndefined();

    processAgentEvent(manager, "parent", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "pum.agent_message",
        details: deliveries[0].details,
      },
    });

    expect(settlement.acknowledgedAt).toBeNumber();
    expect(manager.getAgent("parent")?.transcript.pending).toEqual([]);
  });

  test("deduplicates a crash-window nested settlement at the recipient session boundary", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "idle");
    addTestAgent(manager, "child", "idle", "parent");
    const settlement: any = {
      id: "child:1:idle",
      messageId: "settlement-child:1:idle",
      agentId: "child",
      parentAgentId: "parent",
      status: "idle",
      activityGeneration: 1,
      content: "Subagent child idle.",
      createdAt: 2,
    };
    (manager as any).settlements.set(settlement.id, settlement);
    const sends: any[] = [];
    const parent = (manager as any).records.get("parent");
    parent.session = {
      sessionId: "parent-session",
      isStreaming: false,
      sessionManager: {
        getEntries: () => [{
          type: "custom_message",
          customType: "pum.agent_message",
          details: { id: settlement.messageId },
        }],
      },
    };
    parent.api = { sendMessage(message: any) { sends.push(message); } };

    await (manager as any).retrySettlementsForParent("parent");

    expect(sends).toEqual([]);
    expect(settlement.acknowledgedAt).toBeNumber();
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

  test("recalls the newest queued child user message and removes its pending notice", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    const steering = ["older", "newer"];
    record.session = {
      getSteeringMessages: () => steering,
      getFollowUpMessages: () => [],
      clearQueue: () => ({ steering: steering.splice(0), followUp: [] }),
      steer: async (text: string) => { steering.push(text); },
      followUp: async () => {},
    };
    record.snapshot.transcript.pending = [
      { id: "older", line: { kind: "text", role: "user", text: "older" }, deliveryText: "older" },
      { id: "newer", line: { kind: "text", role: "user", text: "newer" }, deliveryText: "newer" },
      { id: "agent", line: { kind: "agent-message", sender: "main", recipient: "worker", text: "agent" } },
    ];
    record.userInstructionNotices = new Map([["newer", "newer"]]);

    await expect(manager.recallQueuedUserMessage("worker")).resolves.toEqual({ id: "newer", text: "newer" });
    expect(steering).toEqual(["older"]);
    expect(record.snapshot.transcript.pending.map((item: any) => item.id)).toEqual(["older", "agent"]);
    expect(record.userInstructionNotices.has("newer")).toBe(false);
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

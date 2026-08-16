import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNewsItems, saveNewsItems } from "../news";
import {
  SUBAGENT_COMMUNICATION_SYSTEM_PROMPT,
  SUBAGENT_COORDINATION_SYSTEM_PROMPT,
  IDLE_OPEN_REMINDER_THRESHOLD,
  SubagentManager,
  buildSubagentCapacityPrompt,
  countActiveSubagents,
  isAcknowledgementOnlyMessage,
  isCompletionOnlyMessage,
} from "./manager";
import { MESSAGE_CACHE_TOOLS } from "../message-cache";
import { TRIGGER_EVENT_CUSTOM_TYPE, type SubagentStatus, type TriggerEventData } from "./types";
import { SpawnPreviewManager } from "./spawn-preview";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Session file in a temp directory that the afterEach hook removes. */
function temporarySessionFile(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "main.jsonl");
}

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
  test("reminds main after six settled turns and suppresses recursive duplicates", () => {
    const handlers = new Map<string, Function[]>();
    const deliveries: any[] = [];
    const events: any[] = [];
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "idle");
    manager.subscribe((event) => events.push(event));
    (manager.mainExtension() as any).factory({
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
      appendEntry() {},
      sendMessage(message: any, options: any) { deliveries.push({ message, options }); },
    });

    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD; turn += 1) {
      handlers.get("agent_settled")?.[0]?.({});
    }

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(deliveries[0].message.details.kind).toBe("reminder");
    expect(deliveries[0].message.content).toContain("worker [worker] — idle");
    expect(deliveries[0].message.content).toContain("not a request for acknowledgement");
    expect(events.filter((event) => event.type === "main-pending-add")).toHaveLength(1);

    handlers.get("agent_settled")?.[0]?.({});
    expect(deliveries).toHaveLength(1);

    handlers.get("message_start")?.[0]?.({ message: { role: "custom", ...deliveries[0].message } });
    handlers.get("agent_settled")?.[0]?.({});
    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD; turn += 1) {
      handlers.get("agent_settled")?.[0]?.({});
    }
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].message.details.id).not.toBe(deliveries[0].message.details.id);
  });

  test("resets the main idle-open count when no managed resource remains", () => {
    const handlers = new Map<string, Function[]>();
    const deliveries: any[] = [];
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "first", "idle");
    (manager.mainExtension() as any).factory({
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    });

    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD - 1; turn += 1) {
      handlers.get("agent_settled")?.[0]?.({});
    }
    (manager as any).records.delete("first");
    handlers.get("agent_settled")?.[0]?.({});
    addTestAgent(manager, "second", "idle");
    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD - 1; turn += 1) {
      handlers.get("agent_settled")?.[0]?.({});
    }
    expect(deliveries).toEqual([]);
    handlers.get("agent_settled")?.[0]?.({});
    expect(deliveries).toHaveLength(1);
  });

  test("counts an open trigger without subagents and ignores terminal trigger records", () => {
    const handlers = new Map<string, Function[]>();
    const deliveries: any[] = [];
    let triggerState = "cancelled";
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      triggerManager: {
        getTriggers: () => [{
          id: "watch",
          name: "watch build",
          state: triggerState,
          target: { sessionId: "main-session", agentId: null, label: "main" },
        }],
        markTargetSettled() {},
      } as any,
    });
    (manager.mainExtension() as any).factory({
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    });

    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD; turn += 1) {
      handlers.get("agent_settled")?.[0]?.({});
    }
    expect(deliveries).toEqual([]);

    triggerState = "paused";
    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD; turn += 1) {
      handlers.get("agent_settled")?.[0]?.({});
    }
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].content).toContain("watch build [watch] — paused; target main");
  });

  test("reminds a managed child about descendants and exact-target triggers without a new idle notice", async () => {
    const trigger = {
      id: "watch",
      name: "watch build",
      state: "paused",
      target: { sessionId: "parent-session", agentId: "parent", label: "parent" },
    };
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      triggerManager: {
        getTriggers: () => [trigger],
        markTargetSettled() {},
      } as any,
    });
    addTestAgent(manager, "parent", "running");
    addTestAgent(manager, "child", "idle", "parent");
    const mainDeliveries: any[] = [];
    const childDeliveries: any[] = [];
    (manager as any).mainApi = { appendEntry() {}, sendMessage(message: any) { mainDeliveries.push(message); } };
    const parent = (manager as any).records.get("parent");
    parent.session = {
      sessionId: "parent-session",
      isStreaming: false,
      sessionManager: { appendCustomEntry() {} },
    };
    parent.api = { sendMessage(message: any, options: any) { childDeliveries.push({ message, options }); } };

    for (let turn = 0; turn < IDLE_OPEN_REMINDER_THRESHOLD; turn += 1) {
      processAgentEvent(manager, "parent", {
        type: "message_start",
        message: { role: "user", content: `Work cycle ${turn}` },
      });
      settleAgent(manager, "parent");
    }
    await Promise.resolve();

    const reminder = childDeliveries.find((delivery) => delivery.message.details?.kind === "reminder");
    expect(reminder).toBeDefined();
    expect(reminder.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(reminder.message.content).toContain("child [child] — idle");
    expect(reminder.message.content).toContain("watch build [watch] — paused; target parent");
    const idleCount = mainDeliveries.filter((message) => message.details?.kind === "idle").length;

    processAgentEvent(manager, "parent", { type: "message_start", message: { role: "custom", ...reminder.message } });
    settleAgent(manager, "parent");
    await Promise.resolve();

    expect(mainDeliveries.filter((message) => message.details?.kind === "idle")).toHaveLength(idleCount);
  });

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
    expect(result.systemPrompt).toContain("Subagent capacity: slots are available (limit 10)");
    expect(result.systemPrompt).toContain("call enable_tools with Subagents first");
    expect(result.systemPrompt).toContain("Prefer spawn_subagent for follow-up implementation work");
    expect(definitions.get("spawn_subagent").parameters.properties.preview).toBeDefined();
    expect(definitions.get("spawn_subagent").parameters.properties.context.anyOf.map((item: any) => item.const))
      .toEqual(["fresh", "fork"]);
    expect(definitions.get("spawn_subagent").parameters.properties.readonly).toBeUndefined();
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
    expect(SUBAGENT_COORDINATION_SYSTEM_PROMPT).toContain("Never use force removal on a managed agent");
    expect(SUBAGENT_COORDINATION_SYSTEM_PROMPT).toContain("non-force worktree remove");
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

  test("exposes readonly spawn only while Sandbox is on and rejects it while Sandbox is Off", async () => {
    let sandboxMode: "auto" | "off" = "auto";
    const onManager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      sandboxModeSource: () => sandboxMode,
    });
    addTestAgent(onManager, "parent", "idle");
    const mainTools = new Map<string, any>();
    const childTools = new Map<string, any>();
    (onManager.mainExtension() as any).factory({
      on() {},
      registerTool(tool: any) { mainTools.set(tool.name, tool); },
    });
    ((onManager as any).childExtension("parent") as any).factory({
      on() {},
      registerTool(tool: any) { childTools.set(tool.name, tool); },
    });
    expect(mainTools.get("spawn_subagent").parameters.properties.readonly).toBeDefined();
    expect(childTools.get("spawn_subagent").parameters.properties.readonly).toBeDefined();
    sandboxMode = "off";
    onManager.refreshSandboxMode();
    expect(mainTools.get("spawn_subagent").parameters.properties.readonly).toBeUndefined();
    expect(childTools.get("spawn_subagent").parameters.properties.readonly).toBeUndefined();

    const offManager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      sandboxModeSource: () => "off",
    });
    await expect(offManager.spawn({
      task: "Inspect only",
      modelId: "mock/model",
      thinkingLevel: "off",
      readonly: true,
    })).rejects.toThrow("Sandbox setting");
    expect((offManager as any).records.size).toBe(0);
  });

  test("prevents readonly children from delegating mutation paths", async () => {
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      sandboxModeSource: () => "auto",
    });
    addTestAgent(manager, "readonly-parent", "idle");
    (manager as any).records.get("readonly-parent").snapshot.readonly = true;
    const tools = new Map<string, any>();
    ((manager as any).childExtension("readonly-parent") as any).factory({
      on() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });

    await expect(tools.get("spawn_subagent").execute("spawn", {
      task: "Mutate elsewhere",
    }, undefined, undefined, { sessionManager: { getSessionId: () => "child-session" } }))
      .rejects.toThrow("cannot spawn child agents");
    await expect(tools.get("worktree").execute("merge", { action: "merge", target: "peer" }))
      .rejects.toThrow("cannot run worktree merge");
    await expect((manager as any).resolveTriggerSelector("main-session", {
      kind: "subagent",
      agent: "readonly-parent",
    })).rejects.toThrow("cannot be an external trigger target");
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
      context: "fork",
    }, undefined, undefined, {
      sessionManager: {
        getSessionId: () => "main-session",
        getSessionFile: () => "/sessions/main.jsonl",
        getLeafId: () => "main-cutoff",
        getBranch: () => [{ type: "message", id: "main-cutoff", parentId: null, timestamp: "now", message: { role: "user", content: "Main prompt" } }],
      },
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
    expect(spawned[0].context).toBe("fork");
    expect(spawned[0].forkSource.origin).toEqual({
      sourceSessionId: "main-session",
      cutoffEntryId: "main-cutoff",
      sourceAgentId: null,
    });
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
    const mainEvents: any[] = [];
    manager.subscribe((event) => mainEvents.push(event));
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
    expect(mainEvents.filter((event) => event.type === "main-line")).toEqual([]);
    expect(mainEvents.filter((event) => event.type === "main-pending-add")).toHaveLength(1);

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

  test("invalidates exact child shells when a retained agent stops", async () => {
    const invalidated: any[] = [];
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      shellManager: {
        async invalidateAgent(sessionId: string, agentId: string) { invalidated.push({ sessionId, agentId }); },
        async invalidateSession() {},
      } as any,
    });
    addTestAgent(manager, "shell-owner", "idle");
    const record = (manager as any).records.get("shell-owner");
    record.session = { sessionId: "child-session" };
    record.dispose = async () => { record.session = undefined; };

    await manager.stop("shell-owner");

    expect(invalidated).toEqual([{
      sessionId: "child-session",
      agentId: "shell-owner",
    }]);
  });

  test("invalidates all session shells when the main session changes", async () => {
    const invalidated: any[] = [];
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      shellManager: {
        async invalidateAgent() {},
        async invalidateSession(sessionId: string) { invalidated.push(sessionId); },
      } as any,
    });
    const first = {
      getSessionId: () => "main-one",
      getSessionFile: () => undefined,
      getEntries: () => [],
    };
    const second = {
      getSessionId: () => "main-two",
      getSessionFile: () => undefined,
      getEntries: () => [],
    };
    const api = { appendEntry() {}, sendMessage() {} } as any;

    await manager.attachMain(api, first as any, "/repo");
    await manager.attachMain(api, second as any, "/repo");

    expect(invalidated).toEqual(["main-one"]);
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
    const sessionFile = temporarySessionFile("pum-finish-news-");
    (manager as any).mainSessionManager = { getSessionFile: () => sessionFile };

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

    (manager as any).recordSettlementResponse(
      deliveries[0].message.details.id,
      "Main integrated the child change.",
    );
    const news = loadNewsItems(sessionFile);
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      id: `subagent-finish:${deliveries[0].message.details.id}`,
      text: "Main integrated the child change.",
      completion: {
        agentId: "child",
        agentName: "child",
        requesterAgentId: null,
        requesterName: "main",
        summary: "Child work passed.",
      },
    });
    (manager as any).recordSettlementResponse(
      deliveries[0].message.details.id,
      "Main integrated the child change.",
    );
    expect(loadNewsItems(sessionFile)).toHaveLength(1);
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
    const sessionFile = temporarySessionFile("pum-nested-finish-news-");
    (manager as any).mainSessionManager = { getSessionFile: () => sessionFile };
    const parent = (manager as any).records.get("parent");
    parent.session = {
      sessionId: "parent-session",
      isStreaming: false,
      agent: { state: {} },
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

    processAgentEvent(manager, "parent", {
      type: "message_start",
      message: { role: "custom", ...parentDeliveries[0].message },
    });
    processAgentEvent(manager, "parent", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    processAgentEvent(manager, "parent", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Parent accepted the nested result." },
    });
    settleAgent(manager, "parent");

    const news = loadNewsItems(sessionFile);
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      text: "Parent accepted the nested result.",
      completion: {
        agentId: "child",
        requesterAgentId: "parent",
        requesterName: "parent",
        summary: "Nested child passed.",
      },
    });
    expect(manager.getAgent("parent")?.transcript.lines.some((line) =>
      line.kind === "text" && line.role === "assistant" && line.newsId === news[0]?.id,
    )).toBe(true);
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

  test("reconciles one completed finish News item from the registry on resume", async () => {
    const sessionFile = temporarySessionFile("pum-resume-finish-news-");
    const messageId = "settlement-worker:1:completed";
    saveNewsItems(sessionFile, [{
      id: `subagent-finish:${messageId}`,
      text: "Old response text.",
      at: 1,
      read: true,
      answered: true,
    }]);
    const entries = [{
      type: "custom",
      customType: "pum.subagent",
      data: {
        event: "settlement",
        id: "worker",
        settlement: {
          id: "worker:1:completed",
          messageId,
          agentId: "worker",
          agentName: "worker-one",
          parentAgentId: null,
          requesterName: "main",
          status: "completed",
          summary: "All tests passed.",
          activityGeneration: 1,
          content: "Subagent worker-one completed.\nsummary: All tests passed.",
          createdAt: 2,
          response: "Main merged the restored result.",
          acknowledgedAt: 3,
        },
      },
    }];
    const restored = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await restored.attachMain({ appendEntry() {}, sendMessage() {} } as any, {
      getSessionId: () => "main-session",
      getSessionFile: () => sessionFile,
      getEntries: () => entries,
    } as any, "/repo");

    const news = loadNewsItems(sessionFile);
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      id: `subagent-finish:${messageId}`,
      text: "Main merged the restored result.",
      read: true,
      answered: true,
      completion: {
        agentId: "worker",
        agentName: "worker-one",
        requesterAgentId: null,
        requesterName: "main",
      },
    });
  });

  test("restores persisted readonly state and defaults legacy snapshots to mutable", async () => {
    const base = {
      id: "readonly-worker",
      name: "readonly-worker",
      task: "inspect",
      status: "idle",
      worktree: {
        name: "readonly-worker",
        path: "/tmp/readonly-worker",
        branch: "pum/readonly-worker",
        baseBranch: "main",
        baseCommit: "abc",
      },
      parentAgentId: null,
      modelId: "mock/model",
      thinkingLevel: "off",
      startedAt: 1,
      updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
    };
    const entries = [
      {
        type: "custom",
        customType: "pum.subagent",
        data: { event: "spawned", id: "readonly-worker", snapshot: { ...base, readonly: true } },
      },
      {
        type: "custom",
        customType: "pum.subagent",
        data: { event: "spawned", id: "legacy-worker", snapshot: { ...base, id: "legacy-worker", name: "legacy-worker" } },
      },
    ];
    const restored = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    await restored.attachMain({ appendEntry() {}, sendMessage() {} } as any, {
      getSessionId: () => "main-session",
      getEntries: () => entries,
    } as any, "/repo");

    expect(restored.getAgent("readonly-worker")?.readonly).toBe(true);
    expect(restored.getAgent("legacy-worker")?.readonly).toBe(false);
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

  test("a running goal judge is never counted as a worker", () => {
    const agents = [
      { status: "running" as SubagentStatus, role: "worker" as const },
      { status: "running" as SubagentStatus, role: "judge" as const },
      { status: "starting" as SubagentStatus, role: "judge" as const },
      // Legacy snapshots carry no role and are workers.
      { status: "running" as SubagentStatus },
    ];
    expect(countActiveSubagents(agents)).toBe(2);
    expect(countActiveSubagents(agents.filter((agent) => agent.role === "judge"))).toBe(0);
  });

  test("internal judges never appear in the model-visible subagent list", () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "judge", "failed");
    (manager as any).records.get("judge").snapshot.role = "judge";

    expect((manager as any).formatAgentList()).toBe("No subagents.");

    addTestAgent(manager, "worker", "idle");
    expect((manager as any).formatAgentList()).toContain("worker  worker  idle");
    expect((manager as any).formatAgentList()).not.toContain("judge");
  });

  test("a settled judge is discarded instead of becoming idle", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "judge", "running");
    (manager as any).records.get("judge").snapshot.role = "judge";

    settleAgent(manager, "judge");
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getAgent("judge")).toBeUndefined();
  });

  test("the capacity prompt reports spare slots while only a judge runs", () => {
    const judgeOnly = [{ status: "running" as SubagentStatus, role: "judge" as const }];
    expect(buildSubagentCapacityPrompt(countActiveSubagents(judgeOnly), 1))
      .toContain("slots are available");
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

  test("rejects managed merges from every non-completed status", async () => {
    const statuses: Exclude<SubagentStatus, "completed">[] = [
      "idle",
      "failed",
      "stopped",
      "interrupted",
      "starting",
      "running",
    ];

    for (const status of statuses) {
      const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
      addTestAgent(manager, `agent-${status}`, status);
      await expect((manager as any).worktreeAction("/tmp", "merge", `agent-${status}`)).rejects.toThrow(
        `Cannot merge agent-${status} while its authoritative status is ${status}`,
      );
    }
  });

  test("rejects a completed managed merge before its completion notice arrives", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "completed-without-notice", "completed");

    await expect((manager as any).worktreeAction("/tmp", "merge", "completed-without-notice"))
      .rejects.toThrow("Cannot merge completed-without-notice before its completion notice arrives");
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
    expect(result.systemPrompt).toContain("Subagent capacity: slots are available (limit 14)");
    expect(result.systemPrompt).toContain("recursively merge or resolve every retained descendant");
    expect(result.systemPrompt).toContain("Before finish_subagent");
  });

  test("managed force removal cannot discard failed or unmerged work", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "failed-child", "failed");
    await expect((manager as any).worktreeAction("/tmp", "remove", "failed-child", undefined, true))
      .rejects.toThrow("Cannot force-remove managed subagent failed-child");
    // The rejection names the valid close path for a completed empty agent.
    await expect((manager as any).worktreeAction("/tmp", "remove", "failed-child", undefined, true))
      .rejects.toThrow("retry the remove without force");
    expect(manager.getAgent("failed-child")).toBeDefined();
  });

  test("changes follow-up guidance at the configured capacity", () => {
    expect(buildSubagentCapacityPrompt(3, 4)).toContain("slots are available (limit 4)");
    expect(buildSubagentCapacityPrompt(3, 4)).toContain("Prefer spawn_subagent");
    expect(buildSubagentCapacityPrompt(4, 4)).toContain("no slots available");
    expect(buildSubagentCapacityPrompt(4, 4)).toContain("appropriate related running subagent");
    expect(buildSubagentCapacityPrompt(4, 4)).toContain("keep the work pending");
  });

  test("keeps the capacity prompt cache-stable while slots remain available", () => {
    // Exact active counts stay out of the text so the system prompt does not
    // change on every agent transition and invalidate provider prompt caches.
    expect(buildSubagentCapacityPrompt(0, 10)).toBe(buildSubagentCapacityPrompt(9, 10));
    expect(buildSubagentCapacityPrompt(3, 4)).not.toContain("3");
    expect(buildSubagentCapacityPrompt(10, 10)).toBe(buildSubagentCapacityPrompt(12, 10));
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
    expect(result.systemPrompt).toContain("all 12 slots are active; no slots available");
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

  test("preserves cancelled queued child messages in the cache without notifying main", async () => {
    const cached: Array<{ requester: any; text: string }> = [];
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      messageCacheController: {
        add(requester: any, text: string) {
          cached.push({ requester, text });
          return { id: `cached-${cached.length}` };
        },
      } as any,
    });
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
      clearQueue: () => ({
        steering: ["First instruction.", "Attachment instruction."],
        followUp: ["Second instruction."],
      }),
      abort: async () => {},
    };
    record.snapshot.transcript.pending = [
      {
        id: "first",
        line: { kind: "text", role: "user", text: "First instruction." },
        deliveryText: "First instruction.",
      },
      {
        id: "agent",
        line: { kind: "agent-message", sender: "main", recipient: "worker", text: "Keep this notice." },
        deliveryText: "First instruction.",
      },
      {
        id: "attachment",
        line: { kind: "text", role: "user", text: "Attachment instruction." },
        deliveryText: "Attachment instruction.",
        recallable: false,
      },
      {
        id: "second",
        line: { kind: "text", role: "user", text: "Second instruction." },
        deliveryText: "Second instruction.",
      },
      {
        id: "delivered",
        line: { kind: "text", role: "user", text: "Already delivered." },
        deliveryText: "Second instruction.",
        delivered: true,
      },
    ];
    record.userInstructionNotices = new Map([
      ["first", "First instruction."],
      ["attachment", "Attachment instruction."],
      ["second", "Second instruction."],
    ]);

    await manager.abortAgent("worker");

    expect(cached).toEqual([
      {
        requester: { kind: "subagent", id: "worker", name: "worker" },
        text: "First instruction.",
      },
      {
        requester: { kind: "subagent", id: "worker", name: "worker" },
        text: "Second instruction.",
      },
    ]);
    expect(record.snapshot.transcript.pending.map((item: any) => item.id)).toEqual([
      "agent",
      "delivered",
    ]);
    expect(record.userInstructionNotices.size).toBe(0);
    expect(record.snapshot.transcript.lines).toContainEqual({
      kind: "text",
      role: "system",
      text: "cancelled; preserved 2 queued user messages in the cache",
    });
    expect(record.snapshot.transcript.lines).toContainEqual({
      kind: "text",
      role: "error",
      text: "cancelled 1 queued attachment message; attachments could not be preserved",
    });
    expect(deliveries).toEqual([]);
  });

  test("keeps cancelled user text visible when the message cache is unavailable", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    record.session = {
      clearQueue: () => ({ steering: ["Recover me."], followUp: [] }),
      abort: async () => {},
    };
    record.snapshot.transcript.pending = [{
      id: "recover",
      line: { kind: "text", role: "user", text: "Recover me." },
      deliveryText: "Recover me.",
    }];

    await manager.abortAgent("worker");

    expect(record.snapshot.transcript.pending).toEqual([]);
    expect(record.snapshot.transcript.lines).toContainEqual({
      kind: "text",
      role: "error",
      text: "cancelled queued message could not be cached; copy it to retry:\nRecover me.",
    });
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
          snapshot: {
            ...base,
            id: "child",
            parentAgentId: "parent",
            forkOrigin: {
              sourceSessionId: "parent-session",
              cutoffEntryId: "cutoff-entry",
              sourceAgentId: "parent",
            },
          },
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
    expect(manager.getAgent("child")?.forkOrigin).toEqual({
      sourceSessionId: "parent-session",
      cutoffEntryId: "cutoff-entry",
      sourceAgentId: "parent",
    });
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
    expect(manager.getAgent("legacy")?.forkOrigin).toBeUndefined();
    expect((manager as any).formatAgentList()).toContain(
      "fork source: worker · session parent-session · cutoff cutoff-entry",
    );
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

  test("prepares main stats before registering restored child files", async () => {
    const calls: string[] = [];
    const statsManager = {
      prepareMainSession(path: string) { calls.push(`prepare:${path}`); },
      registerAgentFile(id: string, path: string) { calls.push(`child:${id}:${path}`); },
    };
    const childPath = join(process.cwd(), "restored-child.jsonl");
    const entries = [{
      type: "custom",
      customType: "pum.subagent",
      data: {
        event: "spawned",
        id: "child",
        snapshot: {
          id: "child",
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
          sessionFile: childPath,
          parentAgentId: null,
          modelId: "mock/model",
          thinkingLevel: "off",
          startedAt: 1,
          updatedAt: 1,
          usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
        },
      },
    }];
    const manager = new SubagentManager({
      modelRuntime: {} as any,
      agentDir: "/tmp/pum-test",
      statsManager: statsManager as any,
    });
    await manager.attachMain({ appendEntry() {} } as any, {
      getSessionId: () => "main-session",
      getSessionFile: () => "/tmp/main.jsonl",
      getEntries: () => entries,
    } as any, "/repo");

    expect(calls).toEqual([
      "prepare:/tmp/main.jsonl",
      `child:child:${childPath}`,
    ]);
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

  test("redelivers a nested completion notice that a parent cancellation dropped", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "running");
    addTestAgent(manager, "child", "completed", "parent");
    const parent = (manager as any).records.get("parent");
    const child = (manager as any).records.get("child");
    const queued: string[] = [];
    const deliveries: any[] = [];
    parent.session = {
      sessionId: "parent-session",
      isStreaming: true,
      sessionManager: { getEntries: () => [], appendCustomEntry() {} },
      clearQueue: () => ({ steering: queued.splice(0), followUp: [] }),
      abort: async () => {},
    };
    parent.api = {
      sendMessage(message: any) {
        deliveries.push(message);
        queued.push(message.content);
      },
    };
    child.activityGeneration = 1;

    await (manager as any).recordSettlement(child, "completed", "Child work done.");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].details.kind).toBe("completion");
    expect(() => (manager as any).assertManagedMergeReady(child))
      .toThrow("before its completion notice arrives");

    // Cancelling the streaming parent discards the queued notice.
    await manager.abortAgent("parent");
    expect(queued).toEqual([deliveries[0].content]);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].details.id).toBe(deliveries[0].details.id);

    processAgentEvent(manager, "parent", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "pum.agent_message",
        details: deliveries[1].details,
      },
    });
    expect(() => (manager as any).assertManagedMergeReady(child)).not.toThrow();
  });

  test("redelivers a nested completion notice that a parent message recall dropped", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "parent", "running");
    addTestAgent(manager, "child", "completed", "parent");
    const parent = (manager as any).records.get("parent");
    const child = (manager as any).records.get("child");
    const steering: string[] = ["Recall me."];
    const deliveries: any[] = [];
    parent.session = {
      sessionId: "parent-session",
      isStreaming: true,
      sessionManager: { getEntries: () => [], appendCustomEntry() {} },
      getSteeringMessages: () => steering,
      getFollowUpMessages: () => [],
      clearQueue: () => ({ steering: steering.splice(0), followUp: [] }),
      steer: async (text: string) => { steering.push(text); },
      followUp: async () => {},
    };
    parent.api = {
      sendMessage(message: any) {
        deliveries.push(message);
        steering.push(message.content);
      },
    };
    child.activityGeneration = 1;
    await (manager as any).recordSettlement(child, "completed", "Child work done.");
    (manager as any).addPending(parent, {
      id: "recall",
      line: { kind: "text", role: "user", text: "Recall me." },
      deliveryText: "Recall me.",
    });

    expect(deliveries).toHaveLength(1);
    await expect(manager.recallQueuedUserMessage("parent"))
      .resolves.toEqual({ id: "recall", text: "Recall me." });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].details.id).toBe(deliveries[0].details.id);
  });

  test("reports a user cancellation as stopped without a failure notice", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    const deliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); },
    };
    record.activityGeneration = 1;
    record.session = {
      sessionId: "child-session",
      isStreaming: true,
      agent: { state: { errorMessage: "Request aborted" } },
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
    };

    await manager.abortAgent("worker");
    settleAgent(manager, "worker");

    expect(manager.getAgent("worker")?.status).toBe("stopped");
    expect(manager.getAgent("worker")?.summary).toBeUndefined();
    expect(deliveries).toEqual([]);
  });

  test("still reports a genuine runtime error as failed", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    const deliveries: any[] = [];
    (manager as any).mainApi = {
      appendEntry() {},
      sendMessage(message: any) { deliveries.push(message); return true; },
    };
    record.activityGeneration = 1;
    record.session = {
      sessionId: "child-session",
      isStreaming: false,
      agent: { state: { errorMessage: "Provider request failed" } },
    };

    settleAgent(manager, "worker");

    expect(manager.getAgent("worker")?.status).toBe("failed");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].details.kind).toBe("status");
    expect(deliveries[0].content).toContain("Subagent worker failed.");
  });

  test("clears a stale cancellation flag when a later turn starts", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-test" });
    addTestAgent(manager, "worker", "running");
    const record = (manager as any).records.get("worker");
    (manager as any).mainApi = { appendEntry() {}, sendMessage() { return true; } };
    record.session = {
      sessionId: "child-session",
      isStreaming: true,
      agent: { state: { errorMessage: undefined } },
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
    };

    await manager.abortAgent("worker");
    expect(record.userAborted).toBe(true);
    processAgentEvent(manager, "worker", { type: "agent_start" });
    expect(record.userAborted).toBeUndefined();
  });
});

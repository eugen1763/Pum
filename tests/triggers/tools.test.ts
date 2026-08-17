import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import {
  registerTriggerTools,
  requesterTarget,
  type TriggerRequester,
  type TriggerSnapshot,
  type TriggerToolManager,
} from "../../src/triggers/tools";

function snapshot(overrides: Partial<TriggerSnapshot> = {}): TriggerSnapshot {
  return {
    id: "trigger-1",
    name: "watch build",
    state: "idle",
    target: { sessionId: "session-1", agentId: "child-1", label: "child" },
    executable: "bun",
    args: ["test"],
    cwd: "/repo/child",
    mode: "once",
    restartDelayMs: null,
    createdAt: 1,
    expiresAt: 2,
    nextRestartAt: null,
    fireCount: 0,
    maxFires: 10,
    pendingCount: 0,
    coalescedCount: 0,
    paused: false,
    ...overrides,
  };
}

function setup(manager: TriggerToolManager, requester: TriggerRequester, audience: "main" | "subagent") {
  const tools = new Map<string, any>();
  registerTriggerTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any, manager, () => requester, {
    audience,
    resolveTarget: async (_owner, selector) => {
      if (selector.kind !== "subagent" || selector.agent !== "child") throw new Error("unknown target");
      return {
        target: { sessionId: "child-session", agentId: "child-1", label: "child" },
        cwd: "/repo/child",
      };
    },
    authorizeTarget: async (_owner, target) =>
      target.sessionId === "child-session" && target.agentId === "child-1",
  });
  return tools;
}

function managerFor(value = snapshot()): TriggerToolManager {
  return {
    async create() { return value; },
    getTriggers() { return [value]; },
    inspect() { return value; },
    async pause() { return value; },
    async resume() { return value; },
    async cancel() {},
    async invoke() { return value; },
  };
}

const context = { sessionManager: { getSessionId: () => "session-1" }, cwd: "/repo/child" } as any;

describe("trigger model tools", () => {
  test("registers seven strict tools with literal string enums", () => {
    const requester: TriggerRequester = {
      kind: "subagent",
      sessionId: "session-1",
      agentId: "child-1",
      cwd: "/repo/child",
    };
    const tools = setup(managerFor(), requester, "subagent");
    expect([...tools.keys()]).toEqual([
      "create_trigger",
      "list_triggers",
      "inspect_trigger",
      "pause_trigger",
      "resume_trigger",
      "cancel_trigger",
      "invoke_trigger",
    ]);

    const create = tools.get("create_trigger").parameters;
    const valid = {
      name: "watch",
      executable: "bun",
      args: ["test"],
      target: { kind: "self" },
      template: "Tests changed: {{output}}",
      mode: "repeat",
      startBehavior: "start",
    };
    expect(Value.Check(create, valid)).toBe(true);
    expect(Value.Check(create, { ...valid, sessionId: "forged" })).toBe(false);
    expect(Value.Check(create, { ...valid, target: { kind: "subagent", agent: "other" } })).toBe(false);
    expect(Value.Check(tools.get("invoke_trigger").parameters, { id: "one" })).toBe(true);
    expect(Value.Check(tools.get("invoke_trigger").parameters, { id: "one", mode: "run" })).toBe(false);
    expect(Value.Check(tools.get("invoke_trigger").parameters, { id: "one", mode: "fire" })).toBe(false);
    expect(Value.Check(tools.get("invoke_trigger").parameters, { id: "one", mode: "shell" })).toBe(false);
  });

  test("binds child creation to the exact requester target and cwd", async () => {
    let received: any;
    const value = snapshot();
    const manager = managerFor(value);
    manager.create = async (input, requester) => {
      received = { input, requester };
      return value;
    };
    const requester: TriggerRequester = {
      kind: "subagent",
      sessionId: "session-1",
      agentId: "child-1",
      cwd: "/repo/child",
    };
    const tool = setup(manager, requester, "subagent").get("create_trigger");
    await tool.execute("call", {
      name: "watch",
      executable: "bun",
      args: ["test", "--watch"],
      template: "{{output}}",
      mode: "repeat",
      startBehavior: "paused",
    }, undefined, undefined, context);

    expect(received.requester).toEqual(requester);
    expect(received.input.target).toEqual(requesterTarget(requester));
    expect(received.input.cwd).toBe("/repo/child");
    expect(received.input.args).toEqual(["test", "--watch"]);
  });

  test("inspects and authorizes before a child mutation", async () => {
    const calls: string[] = [];
    const requester: TriggerRequester = {
      kind: "subagent",
      sessionId: "session-1",
      agentId: "child-1",
      cwd: "/repo/child",
    };
    const manager = managerFor(snapshot({
      target: { sessionId: "session-1", agentId: "other-child", label: "other" },
    }));
    manager.inspect = (id, owner) => {
      calls.push(`inspect:${id}:${owner?.kind}`);
      return snapshot({ target: { sessionId: "session-1", agentId: "other-child", label: "other" } });
    };
    manager.pause = async () => {
      calls.push("pause");
      return snapshot();
    };

    const pause = setup(manager, requester, "subagent").get("pause_trigger");
    await expect(pause.execute("call", { id: "trigger-1" }, undefined, undefined, context))
      .rejects.toThrow("different target");
    expect(calls).toEqual(["inspect:trigger-1:subagent"]);
  });

  test("runs the configured executable without an invocation mode", async () => {
    const calls: unknown[][] = [];
    const requester: TriggerRequester = {
      kind: "subagent",
      sessionId: "session-1",
      agentId: "child-1",
      cwd: "/repo/child",
    };
    const manager = managerFor();
    manager.invoke = async (...args) => {
      calls.push(args);
      return snapshot();
    };
    const invoke = setup(manager, requester, "subagent").get("invoke_trigger");
    await invoke.execute("call", { id: "trigger-1" }, undefined, undefined, context);
    expect(calls).toEqual([["trigger-1", requester]]);
  });

  test("filters child lists even when the manager returns other targets", async () => {
    const requester: TriggerRequester = {
      kind: "subagent",
      sessionId: "session-1",
      agentId: "child-1",
      cwd: "/repo/child",
    };
    const manager = managerFor();
    manager.getTriggers = (owner) => {
      expect(owner).toEqual(requester);
      return [
        snapshot(),
        snapshot({ id: "other", target: { sessionId: "session-1", agentId: "other", label: "other" } }),
      ];
    };
    const result = await setup(manager, requester, "subagent").get("list_triggers")
      .execute("call", {}, undefined, undefined, context);
    expect(result.details.map((trigger: TriggerSnapshot) => trigger.id)).toEqual(["trigger-1"]);
  });

  test("allows main to manage only a routing-validated retained child target", async () => {
    const requester: TriggerRequester = { kind: "main", sessionId: "main-session", cwd: "/repo" };
    const child = snapshot({
      target: { sessionId: "child-session", agentId: "child-1", label: "child" },
    });
    const manager = managerFor(child);
    manager.getTriggers = () => [
      child,
      snapshot({ id: "unknown", target: { sessionId: "unknown", agentId: "unknown", label: "unknown" } }),
    ];
    const tools = setup(manager, requester, "main");
    const listed = await tools.get("list_triggers").execute(
      "list",
      {},
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "main-session" }, cwd: "/repo" },
    );
    expect(listed.details.map((trigger: TriggerSnapshot) => trigger.id)).toEqual(["trigger-1"]);
    const inspected = await tools.get("inspect_trigger").execute(
      "inspect",
      { id: "trigger-1" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "main-session" }, cwd: "/repo" },
    );
    expect(inspected.details.target).toEqual(child.target);
  });

  test("resolves a main subagent selector without exposing TriggerTarget fields", async () => {
    const requester: TriggerRequester = { kind: "main", sessionId: "main-session", cwd: "/repo" };
    const created = snapshot({
      target: { sessionId: "child-session", agentId: "child-1", label: "child" },
    });
    let input: any;
    const manager = managerFor(created);
    manager.create = async (value) => {
      input = value;
      return created;
    };
    const create = setup(manager, requester, "main").get("create_trigger");
    await create.execute("call", {
      name: "child watch",
      executable: "bun",
      args: ["test"],
      target: { kind: "subagent", agent: "child" },
      template: "{{output}}",
      mode: "once",
      startBehavior: "start",
    }, undefined, undefined, { sessionManager: { getSessionId: () => "main-session" }, cwd: "/repo" });
    expect(input.target).toEqual(created.target);
    expect(input.cwd).toBe("/repo/child");
  });
});

describe("trigger results are bounded", () => {
  test("a long snapshot is truncated and says so", async () => {
    const template = "x".repeat(20_000);
    const requester: TriggerRequester = { kind: "main", sessionId: "session-1", cwd: "/repo" };
    const tools = setup(
      {
        create: async (input: any) => snapshot({ ...input, id: "t1" } as any),
        getTriggers: () => [],
        inspect: async () => snapshot(),
        pause: async () => snapshot(),
        resume: async () => snapshot(),
        cancel: async () => snapshot(),
        invoke: async () => snapshot(),
      } as any,
      requester,
      "main",
    );

    const result = await tools.get("create_trigger").execute("call", {
      name: "big",
      executable: "gh",
      args: [],
      template,
      mode: "once",
      startBehavior: "paused",
    }, undefined, undefined, {});

    const text = result.content[0].text as string;
    expect(text.length).toBeLessThan(9_000);
    expect(text).toContain("truncated at");
  });
});

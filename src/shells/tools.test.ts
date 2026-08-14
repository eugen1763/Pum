import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import {
  DEFAULT_SHELL_OUTPUT_LINES,
  DEFAULT_SHELL_WAIT_TIMEOUT_MS,
  registerShellTools,
  requesterOwner,
  type ShellRequester,
  type ShellSnapshot,
  type ShellToolManager,
} from "./tools";

function snapshot(overrides: Partial<ShellSnapshot> = {}): ShellSnapshot {
  return {
    id: "shell-1",
    name: "dev server",
    owner: { sessionId: "session-1", agentId: "child-1", label: "child" },
    state: "running",
    executable: "bun",
    args: ["run", "dev"],
    cwd: "/repo/child",
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    exitCode: null,
    signal: null,
    output: { path: "/trusted/shell-1.log", bytes: 20, truncated: false, exists: true },
    ...overrides,
  };
}

function managerFor(value = snapshot()): ShellToolManager {
  return {
    async create() { return value; },
    list() { return [value]; },
    inspect() { return value; },
    getOutput() { return { shell: value, tail: "ready\n" }; },
    async terminate() { return { ...value, state: "killed" }; },
  };
}

function setup(manager: ShellToolManager, requester: ShellRequester, audience: "main" | "subagent") {
  const tools = new Map<string, any>();
  registerShellTools(
    { registerTool(tool: any) { tools.set(tool.name, tool); } } as any,
    manager,
    () => requester,
    {
      audience,
      resolveOwner: async (_actor, selector) => {
        if (selector.kind !== "subagent" || selector.agent !== "child") throw new Error("unknown target");
        return {
          owner: { sessionId: "child-session", agentId: "child-1", label: "child" },
          cwd: "/repo/child",
        };
      },
      authorizeOwner: async (_actor, owner) =>
        owner.sessionId === "child-session" && owner.agentId === "child-1",
    },
  );
  return tools;
}

const childRequester: ShellRequester = {
  kind: "subagent",
  sessionId: "session-1",
  agentId: "child-1",
  cwd: "/repo/child",
};
const childContext = { sessionManager: { getSessionId: () => "session-1" }, cwd: "/repo/child" } as any;
const mainContext = { sessionManager: { getSessionId: () => "main-session" }, cwd: "/repo" } as any;

describe("managed shell model tools", () => {
  test("registers five strict tools without model-authored identity fields", () => {
    const tools = setup(managerFor(), childRequester, "subagent");
    expect([...tools.keys()]).toEqual([
      "start_shell",
      "list_shells",
      "inspect_shell",
      "get_shell_output",
      "kill_shell",
    ]);

    const start = tools.get("start_shell").parameters;
    const valid = {
      name: "server",
      executable: "bun",
      args: ["run", "dev"],
      cwd: "/repo/child/app",
      env: { PORT: "3000" },
    };
    expect(Value.Check(start, valid)).toBe(true);
    expect(Value.Check(start, { ...valid, sessionId: "forged" })).toBe(false);
    expect(Value.Check(start, { ...valid, agentId: "forged" })).toBe(false);
    expect(Value.Check(start, { ...valid, command: "bun run dev" })).toBe(false);
    expect(Value.Check(tools.get("list_shells").parameters, {})).toBe(true);
    expect(Value.Check(tools.get("list_shells").parameters, { target: { kind: "main" } })).toBe(false);
  });

  test("binds start to the exact requester and defaults cwd to its worktree", async () => {
    let received: unknown;
    const manager = managerFor();
    manager.create = async (input) => {
      received = input;
      return snapshot();
    };
    const start = setup(manager, childRequester, "subagent").get("start_shell");
    await start.execute("call", {
      executable: "bun",
      args: ["run", "dev"],
      env: { PORT: "3000" },
    }, undefined, undefined, childContext);

    expect(received).toEqual({
      name: undefined,
      executable: "bun",
      args: ["run", "dev"],
      cwd: "/repo/child",
      projectCwd: "/repo/child",
      env: { PORT: "3000" },
      owner: requesterOwner(childRequester),
    });
  });

  test("rejects a manager result with a forged start owner", async () => {
    const manager = managerFor(snapshot({
      owner: { sessionId: "session-1", agentId: "other", label: "other" },
    }));
    const start = setup(manager, childRequester, "subagent").get("start_shell");
    await expect(start.execute(
      "call",
      { executable: "bun", args: ["run", "dev"] },
      undefined,
      undefined,
      childContext,
    )).rejects.toThrow("different owner");
  });

  test("filters child lists and passes an exact owner filter", async () => {
    let receivedOwner: unknown;
    const manager = managerFor();
    manager.list = (owner) => {
      receivedOwner = owner;
      return [
        snapshot(),
        snapshot({ id: "other", owner: { sessionId: "session-1", agentId: "other", label: "other" } }),
      ];
    };
    const listed = await setup(manager, childRequester, "subagent").get("list_shells")
      .execute("call", {}, undefined, undefined, childContext);
    expect(receivedOwner).toEqual(requesterOwner(childRequester));
    expect(listed.details.map((shell: ShellSnapshot) => shell.id)).toEqual(["shell-1"]);
  });

  test("authorizes inspect before output reads and kills", async () => {
    const calls: string[] = [];
    const manager = managerFor(snapshot({
      owner: { sessionId: "session-1", agentId: "other", label: "other" },
    }));
    manager.inspect = (id, owner) => {
      calls.push(`inspect:${id}:${owner?.agentId}`);
      return snapshot({ owner: { sessionId: "session-1", agentId: "other", label: "other" } });
    };
    manager.getOutput = () => {
      calls.push("output");
      return { shell: snapshot(), tail: "" };
    };
    manager.terminate = async () => {
      calls.push("terminate");
      return snapshot();
    };
    const tools = setup(manager, childRequester, "subagent");
    await expect(tools.get("get_shell_output").execute(
      "call", { id: "shell-1" }, undefined, undefined, childContext,
    )).rejects.toThrow("different owner");
    await expect(tools.get("kill_shell").execute(
      "call", { id: "shell-1" }, undefined, undefined, childContext,
    )).rejects.toThrow("different owner");
    expect(calls).toEqual([
      "inspect:shell-1:child-1",
      "inspect:shell-1:child-1",
    ]);
  });

  test("applies bounded output defaults and forwards an explicit readiness wait", async () => {
    const calls: unknown[] = [];
    const manager = managerFor();
    manager.getOutput = (_id, input, owner) => {
      calls.push({ input, owner });
      return { shell: snapshot(), tail: "ready\n", matched: true, matchingLines: ["ready"] };
    };
    const output = setup(manager, childRequester, "subagent").get("get_shell_output");
    await output.execute("call", { id: "shell-1" }, undefined, undefined, childContext);
    await output.execute("call", {
      id: "shell-1",
      lineLimit: 40,
      waitPattern: "ready",
      timeoutMs: 5_000,
    }, undefined, undefined, childContext);
    expect(calls).toEqual([
      {
        input: { lineLimit: DEFAULT_SHELL_OUTPUT_LINES, waitPattern: undefined, timeoutMs: DEFAULT_SHELL_WAIT_TIMEOUT_MS },
        owner: requesterOwner(childRequester),
      },
      {
        input: { lineLimit: 40, waitPattern: "ready", timeoutMs: 5_000 },
        owner: requesterOwner(childRequester),
      },
    ]);
    expect(Value.Check(output.parameters, { id: "shell-1", lineLimit: 201 })).toBe(false);
    expect(Value.Check(output.parameters, { id: "shell-1", timeoutMs: 120_001 })).toBe(false);
  });

  test("allows main oversight only for routing-validated retained owners", async () => {
    const requester: ShellRequester = { kind: "main", sessionId: "main-session", cwd: "/repo" };
    const child = snapshot({
      owner: { sessionId: "child-session", agentId: "child-1", label: "child" },
    });
    const unknown = snapshot({
      id: "unknown",
      owner: { sessionId: "unknown", agentId: "unknown", label: "unknown" },
    });
    const manager = managerFor(child);
    manager.list = () => [child, unknown];
    const tools = setup(manager, requester, "main");

    const listed = await tools.get("list_shells").execute(
      "list",
      { target: { kind: "subagent", agent: "child" } },
      undefined,
      undefined,
      mainContext,
    );
    expect(listed.details.map((shell: ShellSnapshot) => shell.id)).toEqual(["shell-1"]);
    const inspected = await tools.get("inspect_shell").execute(
      "inspect", { id: "shell-1" }, undefined, undefined, mainContext,
    );
    expect(inspected.details.owner).toEqual(child.owner);

    manager.inspect = () => unknown;
    await expect(tools.get("kill_shell").execute(
      "kill", { id: "unknown" }, undefined, undefined, mainContext,
    )).rejects.toThrow("different owner");
  });
});

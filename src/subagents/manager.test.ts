import { describe, expect, test } from "bun:test";
import { SubagentManager } from "./manager";

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
  });
});

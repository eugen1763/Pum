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

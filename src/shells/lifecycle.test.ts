import { describe, expect, test } from "bun:test";
import { ManagedShellLifecycleController, completionText } from "./lifecycle";
import {
  MANAGED_SHELL_COMPLETION_TYPE,
  MANAGED_SHELL_CUSTOM_TYPE,
  type ManagedShellLifecycleEvent,
} from "./types";

function exitEvent(overrides: Partial<ManagedShellLifecycleEvent> = {}): ManagedShellLifecycleEvent {
  return {
    version: 1,
    shellId: "shell-1",
    name: "dev-server",
    owner: { sessionId: "session-1", agentId: null, label: "main" },
    state: "exited",
    executable: "bun",
    args: ["run", "dev"],
    cwd: "/repo",
    at: 1_500,
    startedAt: 1_000,
    finishedAt: 1_500,
    runtimeMs: 500,
    exitCode: 1,
    signal: null,
    output: {
      path: "/tmp/pum-shells/shell-1/output.log",
      bytes: 42,
      truncated: false,
      exists: true,
      tail: "server failed",
    },
    ...overrides,
  };
}

describe("managed shell lifecycle", () => {
  test("persists an exit and wakes the owner once", async () => {
    const persisted: Array<{ customType: string; data: unknown }> = [];
    const delivered: any[] = [];
    const lifecycle = new ManagedShellLifecycleController(
      {
        append(_owner, customType, data) {
          persisted.push({ customType, data });
        },
      },
      {
        deliver(message) {
          delivered.push(message);
        },
      },
    );

    const event = exitEvent();
    await Promise.all([
      lifecycle.recordExit(event, false),
      lifecycle.recordExit(event, false),
    ]);
    await lifecycle.recordExit(event, false);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.customType).toBe(MANAGED_SHELL_CUSTOM_TYPE);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].customType).toBe(MANAGED_SHELL_COMPLETION_TYPE);
    expect(delivered[0].details.id).toBe("managed-shell-exit:shell-1");
    expect(delivered[0].content).toContain("exit code 1");
    expect(delivered[0].content).toContain("server failed");
  });

  test("retries a failed delivery without duplicating the lifecycle event", async () => {
    let attempts = 0;
    const persisted: unknown[] = [];
    const lifecycle = new ManagedShellLifecycleController(
      { append(_owner, _customType, data) { persisted.push(data); } },
      {
        deliver() {
          attempts += 1;
          if (attempts === 1) throw new Error("owner busy");
        },
      },
    );

    const event = exitEvent();
    await expect(lifecycle.recordExit(event, false)).rejects.toThrow("owner busy");
    await lifecycle.recordExit(event, false);

    expect(attempts).toBe(2);
    expect(persisted).toHaveLength(1);
  });

  test("does not wake the owner after an intentional kill", async () => {
    const persisted: unknown[] = [];
    let delivered = false;
    const lifecycle = new ManagedShellLifecycleController(
      { append(_owner, _customType, data) { persisted.push(data); } },
      { deliver() { delivered = true; } },
    );

    await lifecycle.recordExit(exitEvent({
      state: "terminated",
      exitCode: null,
      signal: "SIGTERM",
    }), true);

    expect(persisted).toHaveLength(1);
    expect(delivered).toBe(false);
  });

  test("restores delivered notice ids from durable custom messages", async () => {
    let delivered = false;
    const lifecycle = new ManagedShellLifecycleController(
      { append() {} },
      { deliver() { delivered = true; } },
    );
    lifecycle.restore([{
      type: "custom_message",
      customType: MANAGED_SHELL_COMPLETION_TYPE,
      details: { id: "managed-shell-exit:shell-1" },
    }]);

    await lifecycle.recordExit(exitEvent(), false);
    expect(delivered).toBe(false);
  });

  test("formats bounded output metadata for the durable wake-up", () => {
    expect(completionText(exitEvent())).toBe([
      "Managed shell dev-server (shell-1) exited with exit code 1.",
      "Runtime: 500 ms.",
      "Output: 42 bytes.",
      "Path: /tmp/pum-shells/shell-1/output.log",
      "Recent output:\nserver failed",
    ].join("\n"));
  });
});

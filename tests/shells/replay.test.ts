import { describe, expect, test } from "bun:test";
import { replayEntries } from "../../src/replay";
import {
  MANAGED_SHELL_COMPLETION_TYPE,
  MANAGED_SHELL_CUSTOM_TYPE,
  type ManagedShellLifecycleEvent,
} from "../../src/shells/types";

function event(state: ManagedShellLifecycleEvent["state"]): ManagedShellLifecycleEvent {
  return {
    version: 1,
    shellId: "shell-1",
    name: "watch",
    owner: { sessionId: "session-1", agentId: null, label: "main" },
    state,
    executable: "bun",
    args: ["test", "--watch"],
    cwd: "/repo",
    at: state === "started" ? 1 : 2,
    startedAt: 1,
    finishedAt: state === "started" ? null : 2,
    runtimeMs: state === "started" ? null : 1,
    exitCode: state === "exited" ? 0 : null,
    signal: state === "terminated" ? "SIGTERM" : null,
  };
}

describe("managed shell replay", () => {
  test("explains a prior start and marks a still-running shell unavailable", () => {
    const lines = replayEntries([{
      type: "custom",
      customType: MANAGED_SHELL_CUSTOM_TYPE,
      data: event("started"),
    }], "/repo", true);

    expect(lines).toEqual([
      {
        kind: "text",
        role: "system",
        text: "Managed shell watch (shell-1) started: bun test --watch",
      },
      {
        kind: "text",
        role: "system",
        text: "Managed shell watch (shell-1) is no longer available after restart.",
      },
    ]);
  });

  test("does not mark a shell unavailable after a persisted exit", () => {
    const lines = replayEntries([
      { type: "custom", customType: MANAGED_SHELL_CUSTOM_TYPE, data: event("started") },
      { type: "custom", customType: MANAGED_SHELL_CUSTOM_TYPE, data: event("exited") },
    ], "/repo", true);

    expect(lines.map((line) => line.kind === "text" ? line.text : "")).toEqual([
      "Managed shell watch (shell-1) started: bun test --watch",
      "Managed shell watch (shell-1) exited with exit code 0.",
    ]);
  });

  test("replays intentional termination without a synthetic unavailable row", () => {
    const lines = replayEntries([
      { type: "custom", customType: MANAGED_SHELL_CUSTOM_TYPE, data: event("started") },
      { type: "custom", customType: MANAGED_SHELL_CUSTOM_TYPE, data: event("terminated") },
    ], "/repo", true);

    expect(lines.at(-1)).toEqual({
      kind: "text",
      role: "system",
      text: "Managed shell watch (shell-1) was terminated intentionally.",
    });
  });

  test("restores the durable natural-exit notice once", () => {
    const details = {
      id: "managed-shell-exit:shell-1",
      shellId: "shell-1",
      name: "watch",
      owner: { sessionId: "session-1", agentId: null, label: "main" },
      text: "Managed shell watch exited.",
      at: 2,
    };
    const entry = {
      type: "custom_message",
      customType: MANAGED_SHELL_COMPLETION_TYPE,
      content: details.text,
      details,
    };
    const lines = replayEntries([entry, entry], "/repo", true);

    expect(lines).toEqual([{
      kind: "agent-message",
      sender: "shell:watch",
      recipient: "main",
      text: details.text,
      messageId: details.id,
    }]);
  });
});

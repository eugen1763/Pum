import { describe, expect, test } from "bun:test";
import { rejectedToolDetails } from "./check-mode";
import { replayEntries } from "./replay";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  AGENT_MESSAGE_DISPLAY_TYPE,
  TOOL_EVENT_CUSTOM_TYPE,
} from "./subagents/types";

describe("subagent transcript replay", () => {
  test("restores agent messages and synthetic tool state", () => {
    const message = {
      id: "message-1",
      sender: "worker-a",
      recipient: "worker-b",
      text: "Review the parser change",
      at: 1,
    };
    const lines = replayEntries([
      {
        type: "custom",
        id: "entry-1",
        customType: AGENT_MESSAGE_DISPLAY_TYPE,
        data: message,
      },
      {
        type: "custom_message",
        id: "entry-2",
        customType: AGENT_MESSAGE_CUSTOM_TYPE,
        content: "Message from worker-a:\nReview the parser change",
        details: message,
      },
      {
        type: "custom",
        id: "entry-3",
        customType: TOOL_EVENT_CUSTOM_TYPE,
        data: { id: "worktree-1", name: "worktree", arg: "create", state: "running" },
      },
      {
        type: "custom",
        id: "entry-4",
        customType: TOOL_EVENT_CUSTOM_TYPE,
        data: {
          id: "worktree-1",
          name: "worktree",
          arg: "create",
          state: "ok",
          detail: "pum/test",
        },
      },
    ], process.cwd(), true);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      kind: "agent-message",
      sender: "worker-a",
      recipient: "worker-b",
      text: "Review the parser change",
    });
    expect(lines[1]).toEqual({
      kind: "tool",
      call: {
        id: "worktree-1",
        name: "worktree",
        arg: "create",
        state: "ok",
        detail: "pum/test",
      },
    });
  });

  test("restores rejected tools as a distinct state", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "blocked-1",
            name: "bash",
            arguments: { command: "unsafe" },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "blocked-1",
          toolName: "bash",
          content: [{ type: "text", text: "blocked" }],
          details: rejectedToolDetails({}),
          isError: true,
        },
      },
    ], process.cwd(), true);

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: { id: "blocked-1", state: "rejected" },
    });
  });
});

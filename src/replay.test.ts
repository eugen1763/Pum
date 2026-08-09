import { describe, expect, test } from "bun:test";
import { rejectedToolDetails } from "./check-mode";
import { replayEntries } from "./replay";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  AGENT_MESSAGE_DISPLAY_TYPE,
  SUBAGENT_WAKE_PREFIX,
  TOOL_EVENT_CUSTOM_TYPE,
  TRIGGER_EVENT_CUSTOM_TYPE,
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
        type: "message",
        message: {
          role: "user",
          content: `${SUBAGENT_WAKE_PREFIX}\nProcess the completion notice`,
        },
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

  test("restores typed trigger deliveries", () => {
    const lines = replayEntries([{
      type: "custom",
      customType: TRIGGER_EVENT_CUSTOM_TYPE,
      data: {
        id: "event-1",
        triggerId: "trigger-1",
        name: "tests",
        target: { sessionId: "session-1", agentId: "child-1", label: "child" },
        text: "Tests completed.",
        at: 1,
      },
    }], process.cwd(), true);

    expect(lines).toEqual([{
      kind: "agent-message",
      sender: "trigger:tests",
      recipient: "child-1",
      text: "Tests completed.",
    }]);
  });

  test("restores apply_patch arguments and changed-line details", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "patch-1",
            name: "apply_patch",
            arguments: {
              patch: "*** Begin Patch\n*** Update File: src/file.ts\n@@\n-old\n+new\n*** End Patch",
            },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "patch-1",
          toolName: "apply_patch",
          content: [{ type: "text", text: "applied" }],
          details: { patch: "--- src/file.ts\n+++ src/file.ts\n@@ -1 +1 @@\n-old\n+new\n" },
          isError: false,
        },
      },
    ], process.cwd(), true);

    expect(lines[0]).toEqual({
      kind: "tool",
      call: {
        id: "patch-1",
        name: "apply_patch",
        arg: "src/file.ts",
        state: "ok",
        detail: "+1 −1",
      },
    });
  });

  test("restores read path and range arguments", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: {
              path: "/repo/src/file name.ts",
              offset: 12,
              limit: 40,
            },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        },
      },
    ], "/repo", true);

    expect(lines[0]).toEqual({
      kind: "tool",
      call: {
        id: "read-1",
        name: "read",
        arg: "src/file name.ts · offset=12 · limit=40",
        state: "ok",
      },
    });
  });

  test("restores Windows project paths with stable display separators", () => {
    const lines = replayEntries([{
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "read-windows",
          name: "read",
          arguments: { path: "C:\\work space\\repo\\src\\file name.ts", limit: 8 },
        }],
      },
    }], "C:\\work space\\repo", true);

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: { id: "read-windows", arg: "src/file name.ts · limit=8", state: "ok" },
    });
  });

  test("restores questionnaire completion details", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "questionnaire-1",
            name: "questionnaire",
            arguments: {
              questions: [{ id: "scope", label: "Scope", prompt: "Choose", options: [] }],
            },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "questionnaire-1",
          toolName: "questionnaire",
          content: [{ type: "text", text: "structured answers" }],
          details: {
            cancelled: false,
            answers: [{ questionId: "scope", value: "small", label: "Small", custom: false }],
          },
          isError: false,
        },
      },
    ], process.cwd(), true);

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: { name: "questionnaire", arg: "1 question · Scope", detail: "1 answer", state: "ok" },
    });
  });

  test("restores concise message cache action and result details", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "cache-send-1",
            name: "message_cache_send",
            arguments: { ids: ["cache-1", "cache-2"] },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "cache-send-1",
          toolName: "message_cache_send",
          content: [{ type: "text", text: "Sent cached messages" }],
          details: { action: "send", count: 2, ids: ["cache-1", "cache-2"] },
          isError: false,
        },
      },
    ], process.cwd(), true);

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: { name: "message_cache_send", arg: "send · 2 ids", detail: "2 sent", state: "ok" },
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
          details: rejectedToolDetails({}, "Verifier UNSAFE: destructive operation"),
          isError: true,
        },
      },
    ], process.cwd(), true);

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: { id: "blocked-1", state: "rejected", detail: "Verifier UNSAFE: destructive operation" },
    });
  });
});

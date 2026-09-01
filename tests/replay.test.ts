import { describe, expect, test } from "bun:test";
import { rejectedToolDetails } from "../src/check-mode";
import { replayEntries } from "../src/replay";
import { INTERRUPTED_TOOL_DETAIL } from "../src/tool-row";
import { WEB_SEARCH_CUSTOM_TYPE } from "../src/web-search";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  AGENT_MESSAGE_DISPLAY_TYPE,
  SUBAGENT_WAKE_PREFIX,
  TOOL_EVENT_CUSTOM_TYPE,
  TRIGGER_EVENT_CUSTOM_TYPE,
} from "../src/subagents/types";

describe("subagent transcript replay", () => {
  test("replays user Bash executions as Bash tool rows", () => {
    const lines = replayEntries([{
      id: "bash-entry",
      type: "message",
      message: {
        role: "bashExecution",
        command: "printf replay \\\n  && printf second",
        output: "replay",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    }], process.cwd(), false);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: {
        name: "bash",
        args: ["printf replay \\\n  && printf second"],
        state: "ok",
        output: "replay",
      },
    });
  });

  test("restores agent messages and persisted tool state", () => {
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
      messageId: "message-1",
    });
    expect(lines[1]).toEqual({
      kind: "tool",
      call: {
        id: "worktree-1",
        name: "worktree",
        args: ["create"],
        state: "ok",
        detail: "pum/test",
      },
    });
  });

  test("replays an approved spawn note as a normal child user message", () => {
    const lines = replayEntries([{
      type: "message",
      message: { role: "user", content: "Optional preview note" },
    }], process.cwd(), true);

    expect(lines).toEqual([{
      kind: "text",
      role: "user",
      text: "Optional preview note",
    }]);
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

  test("restores a durable idle-open reminder as one agent-message row", () => {
    const reminder = {
      id: "idle-open-reminder-main-1",
      sender: "pum",
      recipient: "main",
      text: "Reminder: 3 agent turns settled while managed resources remained open.",
      at: 1,
      kind: "reminder",
    };
    const lines = replayEntries([{
      type: "custom_message",
      customType: AGENT_MESSAGE_CUSTOM_TYPE,
      content: reminder.text,
      display: true,
      details: reminder,
    }], process.cwd(), true);

    expect(lines).toEqual([{
      kind: "agent-message",
      sender: "pum",
      recipient: "main",
      text: reminder.text,
      messageId: reminder.id,
      agentMessageKind: "reminder",
    }]);
  });

  test("restores the completion category for transcript visibility", () => {
    const completion = {
      id: "settlement-worker-1",
      sender: "worker",
      recipient: "main",
      text: "Subagent worker completed.",
      at: 1,
      kind: "completion",
    };
    const lines = replayEntries([{
      type: "custom_message",
      customType: AGENT_MESSAGE_CUSTOM_TYPE,
      content: completion.text,
      display: true,
      details: completion,
    }], process.cwd(), true);

    expect(lines).toEqual([{
      kind: "agent-message",
      sender: "worker",
      recipient: "main",
      text: completion.text,
      messageId: completion.id,
      agentMessageKind: "completion",
    }]);
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

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: {
        id: "read-1",
        name: "read",
        args: ["src/file name.ts", "offset=12", "limit=40"],
        state: "ok",
        input: {
          path: "/repo/src/file name.ts",
          offset: 12,
          limit: 40,
        },
        result: {
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        },
      },
    });
  });

  test("restores the Bash exit code without settled output", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "bash-1",
            name: "bash",
            arguments: { command: "printf first; printf last; exit 7" },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: "bash",
          content: [{ type: "text", text: "first\nlast\n\nCommand exited with code 7" }],
          isError: true,
        },
      },
    ], process.cwd(), true);

    expect(lines[0]).toMatchObject({
      kind: "tool",
      call: {
        id: "bash-1",
        name: "bash",
        args: ["printf first; printf last; exit 7"],
        state: "error",
        exitCode: 7,
      },
    });
  });

  test("restores the best persisted web search argument", () => {
    const lines = replayEntries([
      {
        type: "custom",
        customType: WEB_SEARCH_CUSTOM_TYPE,
        data: { id: "search-1", query: "", state: "running" },
      },
      {
        type: "custom",
        customType: WEB_SEARCH_CUSTOM_TYPE,
        data: { id: "search-1", query: "release date", state: "ok" },
      },
      {
        type: "custom",
        customType: WEB_SEARCH_CUSTOM_TYPE,
        data: { id: "search-1", query: "", state: "ok" },
      },
    ], process.cwd(), true);

    expect(lines).toEqual([{
      kind: "tool",
      call: {
        id: "search-1",
        name: "web_search",
        args: ["release date"],
        state: "ok",
      },
    }]);
  });

  test("replays a call with no persisted result as interrupted", () => {
    const lines = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "done", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "cut-short", name: "bash", arguments: { command: "sleep 30" } },
          ],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "done", isError: false, content: "ok" },
      },
    ], "/repo", true);

    expect(lines).toMatchObject([
      { kind: "tool", call: { id: "done", state: "ok", detail: undefined } },
      { kind: "tool", call: { id: "cut-short", state: "error", detail: INTERRUPTED_TOOL_DETAIL } },
    ]);
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
      // No persisted result: the call is interrupted, not successful.
      call: { id: "read-windows", args: ["src/file name.ts", "limit=8"], state: "error" },
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
      call: { name: "questionnaire", args: ["1 question", "Scope"], detail: "1 answer", state: "ok" },
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
      call: { name: "message_cache_send", args: ["send", "2 ids"], detail: "2 sent", state: "ok" },
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

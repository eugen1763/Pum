import { describe, expect, test } from "bun:test";
import { interruptedToolCall, settledToolCall, startedToolCall } from "./tool-row";
import { replayEntries } from "./replay";
import type { ToolCall } from "./tool-line";

/**
 * The same call, built the two ways PUM builds one: from live events, and from
 * a resumed session's entries. They have to agree, or a session reads one way
 * before a reload and another way after it.
 */

const cwd = "/repo";

const patch = [
  "*** Begin Patch",
  "*** Update File: src/value.ts",
  "@@",
  "-const value = 1;",
  "+const value = 2;",
  "*** End Patch",
].join("\n");

/** What the live event handlers do: start a row, then settle it on the result. */
function liveCall(name: string, args: unknown, result: unknown, isError = false): ToolCall {
  const call = startedToolCall({ id: "call-1", name, args }, cwd);
  delete call.startedAt;
  return { ...call, ...settledToolCall({ name, result, isError }) } as ToolCall;
}

/** What replay does with the entries pi persisted for that same call. */
function replayedCall(name: string, args: unknown, result: unknown, isError = false): ToolCall {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolCallId: "call-1", toolName: name, isError, ...(result as object) },
    },
  ];
  const lines = replayEntries(entries, cwd, true);
  const line = lines.find((item) => item.kind === "tool");
  if (line?.kind !== "tool") throw new Error("replay produced no tool row");
  return line.call;
}

describe("a settled call reads the same live and replayed", () => {
  const cases: Array<{ name: string; args: unknown; result: Record<string, unknown> }> = [
    {
      name: "apply_patch",
      args: { patch },
      result: { content: [{ type: "text", text: "Applied patch" }], details: { patch } },
    },
    {
      name: "read",
      args: { path: "/repo/src/value.ts", offset: 2, limit: 8 },
      result: { content: [{ type: "text", text: "const value = 2;" }], details: { lines: 1 } },
    },
    {
      name: "bash",
      args: { command: "bun test" },
      result: { content: [{ type: "text", text: "1486 pass" }], details: { exitCode: 0 } },
    },
    {
      name: "questionnaire",
      args: { questions: [] },
      result: { content: [{ type: "text", text: "answered" }], details: {} },
    },
  ];

  for (const item of cases) {
    test(`${item.name} builds one row both ways`, () => {
      const live = liveCall(item.name, item.args, item.result);
      const replayed = replayedCall(item.name, item.args, item.result);
      // The retained result differs by the envelope pi persists around it, and
      // the row never renders that envelope, so compare everything else.
      const { result: liveResult, ...liveRow } = live;
      const { result: replayedResult, ...replayedRow } = replayed;
      expect(replayedRow).toEqual(liveRow);
      expect(liveResult).toBeDefined();
      expect(replayedResult).toBeDefined();
    });
  }

  test("a mutation keeps its diff preview through a reload", () => {
    // Without this the same edit shows its diff live and nothing at all after
    // the session is loaded from history.
    const replayed = replayedCall("apply_patch", { patch }, {
      content: [{ type: "text", text: "Applied patch" }],
      details: { patch },
    });
    expect(replayed.preview?.kind).toBe("diff");
    expect(replayed.detail).toBe("+1 −1");
  });

  test("a failed call reads the same both ways", () => {
    const result = { content: [{ type: "text", text: "no such file" }], details: {} };
    const live = liveCall("read", { path: "/repo/missing.ts" }, result, true);
    const replayed = replayedCall("read", { path: "/repo/missing.ts" }, result, true);
    expect(replayed.state).toBe("error");
    expect(replayed.state).toBe(live.state);
    expect(replayed.isError).toBe(live.isError!);
  });
});

describe("a call whose turn ended without a result", () => {
  test("is interrupted, not running", () => {
    const running = startedToolCall({ id: "c", name: "bash", args: { command: "sleep 100" } }, cwd);
    const settled = interruptedToolCall({ ...running, output: "partial" });
    expect(settled.state).toBe("error");
    expect(settled.detail).toBe("interrupted");
    // The live output goes with the turn that was producing it.
    expect(settled.output).toBeUndefined();
  });

  test("reads the same as replay shows it", () => {
    const entries = [{
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "sleep 100" } }],
      },
    }];
    const lines = replayEntries(entries, cwd, true);
    const line = lines[0];
    if (line?.kind !== "tool") throw new Error("replay produced no tool row");

    const live = interruptedToolCall(
      startedToolCall({ id: "c", name: "bash", args: { command: "sleep 100" } }, cwd),
    );
    delete live.startedAt;
    expect(line.call).toEqual(live);
  });
});

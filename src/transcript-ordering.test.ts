import { describe, expect, test } from "bun:test";
import {
  resolvePendingDelivery,
  settleTranscriptMessage,
  transcriptForThinkingVisibility,
  type PendingTranscriptState,
} from "./transcript";

describe("inter-agent transcript ordering", () => {
  test("does not split streamed output when an agent message arrives", () => {
    const state: PendingTranscriptState = {
      lines: [],
      stream: { kind: "assistant", text: "touched src/app.ts" },
      pending: [{
        id: "peer-message",
        line: {
          kind: "agent-message",
          sender: "worker",
          recipient: "main",
          text: "finished the related task",
        },
      }],
    };

    const delivered = resolvePendingDelivery(state, "peer-message");
    expect(delivered.lines).toEqual([]);
    expect(delivered.stream?.text).toBe("touched src/app.ts");
    expect(delivered.pending[0]?.delivered).toBe(true);

    const completed = settleTranscriptMessage({
      ...delivered,
      stream: {
        kind: "assistant",
        text: "touched src/app.ts and help-popup.ts",
      },
    });
    expect(completed.lines).toEqual([
      { kind: "text", role: "assistant", text: "touched src/app.ts and help-popup.ts" },
      {
        kind: "agent-message",
        sender: "worker",
        recipient: "main",
        text: "finished the related task",
      },
    ]);
    expect(completed.pending).toEqual([]);
    expect(completed.stream).toBeNull();
  });

  test("inserts delivered messages immediately when no output is streaming", () => {
    const state: PendingTranscriptState = {
      lines: [],
      stream: null,
      pending: [{
        id: "idle-message",
        line: { kind: "agent-message", sender: "alpha", recipient: "beta", text: "ready" },
      }],
    };
    const completed = resolvePendingDelivery(state, "idle-message");

    expect(completed.lines).toEqual([
      { kind: "agent-message", sender: "alpha", recipient: "beta", text: "ready" },
    ]);
    expect(completed.pending).toEqual([]);
  });

  test("hides retained thinking lines and streams without mutating transcript state", () => {
    const state: PendingTranscriptState = {
      lines: [
        { kind: "text", role: "thinking", text: "private reasoning" },
        { kind: "text", role: "assistant", text: "visible answer" },
      ],
      stream: { kind: "thinking", text: "live reasoning" },
      pending: [],
    };

    const hidden = transcriptForThinkingVisibility(state, false);

    expect(hidden.lines).toEqual([
      { kind: "text", role: "assistant", text: "visible answer" },
    ]);
    expect(hidden.stream).toBeNull();
    expect(state.lines).toHaveLength(2);
    expect(state.stream?.text).toBe("live reasoning");
    expect(transcriptForThinkingVisibility(state, true)).toBe(state);
  });
});

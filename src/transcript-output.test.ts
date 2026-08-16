import { describe, expect, test } from "bun:test";
import { replayEntries } from "./replay";
import {
  projectPendingTranscriptLines,
  projectTranscriptLines,
  transcriptOutputMode,
} from "./transcript-output";

describe("transcript output projection", () => {
  test("defaults to Normal and migrates every legacy persisted mode", () => {
    expect(transcriptOutputMode({})).toBe("normal");
    expect(transcriptOutputMode({ outputMode: "minimal" })).toBe("quiet");
    expect(transcriptOutputMode({ outputMode: "default" })).toBe("normal");
    expect(transcriptOutputMode({ outputMode: "detailed" })).toBe("verbose");
    expect(transcriptOutputMode({ outputMode: "quiet" })).toBe("quiet");
    expect(transcriptOutputMode({ outputMode: "normal" })).toBe("normal");
    expect(transcriptOutputMode({ outputMode: "verbose" })).toBe("verbose");
    expect(transcriptOutputMode({ outputMode: "unknown" })).toBe("normal");
  });

  test("reprojects one canonical replay immediately without mutating it", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
            { type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/b.ts" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "alpha" }],
          details: { source: "a" },
          isError: false,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-2",
          toolName: "read",
          content: [{ type: "text", text: "beta" }],
          details: { source: "b" },
          isError: false,
        },
      },
    ];
    const canonical = replayEntries(entries, process.cwd(), false);

    const normalLines = projectTranscriptLines(canonical, "normal");
    const quietLines = projectTranscriptLines(canonical, "quiet");
    const verboseLines = projectTranscriptLines(canonical, "verbose");

    expect(normalLines).toHaveLength(1);
    expect(verboseLines).toHaveLength(2);
    expect(quietLines).toEqual([{
      kind: "tool-summary",
      text: "Read 2 files.",
      calls: expect.any(Array),
    }]);
    expect(canonical).toHaveLength(2);
    expect(canonical[0]).toMatchObject({
      kind: "tool",
      call: {
        id: "read-1",
        input: { path: "src/a.ts" },
        result: { toolCallId: "read-1", isError: false },
        isError: false,
      },
    });
  });

  test("a non-tool replay row terminates a minimal success run", () => {
    const canonical = replayEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-1",
          content: [{ type: "text", text: "a" }],
          isError: false,
        },
      },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "b" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "read-2",
          content: [{ type: "text", text: "b" }],
          isError: false,
        },
      },
    ], process.cwd(), false);

    expect(projectTranscriptLines(canonical, "quiet").map((line) => line.kind)).toEqual([
      "tool-summary",
      "text",
      "tool-summary",
    ]);
  });

  test("Quiet hides agent messages while Normal and Verbose preserve canonical rows", () => {
    const canonical = [
      { kind: "text", role: "assistant", text: "Before" },
      { kind: "agent-message", sender: "worker", recipient: "main", text: "Update", messageId: "m1" },
      { kind: "text", role: "assistant", text: "After" },
    ] as const;

    expect(projectTranscriptLines(canonical, "quiet").map((line) => line.kind)).toEqual(["text", "text"]);
    expect(projectTranscriptLines(canonical, "normal").map((line) => line.kind)).toEqual([
      "text", "agent-message", "text",
    ]);
    expect(projectTranscriptLines(canonical, "verbose").map((line) => line.kind)).toEqual([
      "text", "agent-message", "text",
    ]);
    expect(canonical[1].kind).toBe("agent-message");
  });

  test("Quiet hides queued agent messages without mutating pending delivery state", () => {
    const pending = [
      {
        id: "agent",
        line: { kind: "agent-message", sender: "worker", recipient: "main", text: "queued" },
        delivered: false,
      },
      {
        id: "user",
        line: { kind: "text", role: "user", text: "queued prompt" },
        delivered: false,
      },
    ] as const;

    expect(projectPendingTranscriptLines(pending, "quiet").map((item) => item.id)).toEqual(["user"]);
    expect(projectPendingTranscriptLines(pending, "normal").map((item) => item.id)).toEqual(["agent", "user"]);
    expect(projectPendingTranscriptLines(pending, "verbose").map((item) => item.id)).toEqual(["agent", "user"]);
    expect(pending[0].delivered).toBe(false);
  });
});

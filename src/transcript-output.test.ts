import { describe, expect, test } from "bun:test";
import { replayEntries } from "./replay";
import {
  projectTranscriptLines,
  transcriptOutputMode,
} from "./transcript-output";

describe("transcript output projection", () => {
  test("defaults legacy settings to default and accepts every persisted mode", () => {
    expect(transcriptOutputMode({})).toBe("default");
    expect(transcriptOutputMode({ outputMode: "minimal" })).toBe("minimal");
    expect(transcriptOutputMode({ outputMode: "default" })).toBe("default");
    expect(transcriptOutputMode({ outputMode: "detailed" })).toBe("detailed");
    expect(transcriptOutputMode({ outputMode: "unknown" })).toBe("default");
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

    const defaultLines = projectTranscriptLines(canonical, "default");
    const minimalLines = projectTranscriptLines(canonical, "minimal");
    const detailedLines = projectTranscriptLines(canonical, "detailed");

    expect(defaultLines).toHaveLength(2);
    expect(detailedLines).toHaveLength(2);
    expect(minimalLines).toEqual([{
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

    expect(projectTranscriptLines(canonical, "minimal").map((line) => line.kind)).toEqual([
      "tool-summary",
      "text",
      "tool-summary",
    ]);
  });
});

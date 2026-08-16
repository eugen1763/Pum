import { describe, expect, test } from "bun:test";
import { replayEntries } from "./replay";
import {
  projectPendingTranscriptLines,
  projectTranscriptLines,
  transcriptOutputMode,
} from "./transcript-output";
import { needsTranscriptGap, topAnchorScrollTop, type Line } from "./transcript";
import type { MinimalToolSummaryLine } from "./output-minimal";

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

describe("blank lines around grouped activity", () => {
  const text = (role: "user" | "assistant"): Line => ({ kind: "text", role, text: "x" });
  const toolRow: Line = {
    kind: "tool",
    call: { id: "t", name: "read", args: ["a.ts"], state: "ok" },
  };
  const summary: MinimalToolSummaryLine = {
    kind: "tool-summary",
    text: "Read 1 file.",
    calls: [toolRow.kind === "tool" ? toolRow.call : ({} as never)],
  };

  test("a summary row stands alone between any two neighbours", () => {
    expect(needsTranscriptGap(text("assistant"), summary)).toBe(true);
    expect(needsTranscriptGap(summary, text("assistant"))).toBe(true);
    expect(needsTranscriptGap(toolRow, summary)).toBe(true);
    expect(needsTranscriptGap(summary, toolRow)).toBe(true);
    // Nothing precedes the first row, so it opens without a leading blank.
    expect(needsTranscriptGap(undefined, summary)).toBe(false);
  });

  test("consecutive tool rows still have no gap between them", () => {
    expect(needsTranscriptGap(toolRow, toolRow)).toBe(false);
  });

  test("Quiet projects one summary, so its neighbours both gain a gap", () => {
    const lines: Line[] = [text("user"), toolRow, toolRow, text("assistant")];
    const projected = projectTranscriptLines(lines, "quiet");

    expect(projected.map((line) => line.kind)).toEqual(["text", "tool-summary", "text"]);
    expect(needsTranscriptGap(projected[0], projected[1]!)).toBe(true);
    expect(needsTranscriptGap(projected[1], projected[2]!)).toBe(true);
  });
});

describe("anchoring a revealed row", () => {
  test("puts the row's first line at the top of the viewport", () => {
    expect(topAnchorScrollTop(40, 200, 20)).toBe(40);
  });

  test("never scrolls past the end, so a row near the bottom stops short", () => {
    expect(topAnchorScrollTop(195, 200, 20)).toBe(180);
    expect(topAnchorScrollTop(400, 200, 20)).toBe(180);
  });

  test("never scrolls above the start", () => {
    expect(topAnchorScrollTop(-5, 200, 20)).toBe(0);
    expect(topAnchorScrollTop(0, 200, 20)).toBe(0);
  });

  test("stays at the start when everything already fits", () => {
    expect(topAnchorScrollTop(5, 12, 20)).toBe(0);
  });
});

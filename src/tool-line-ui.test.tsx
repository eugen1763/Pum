import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes, parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { rejectedToolDetails } from "./check-mode";
import { replayEntries } from "./replay";
import { ToolLine, toolStateGlyph } from "./transcript";
import { loadTheme } from "./theme";
import type { ToolCall } from "./tool-line";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.renderOnce();
  await setup.flush();
}

function rejectedReplayCall(): ToolCall {
  const lines = replayEntries([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "replayed",
          name: "bash",
          arguments: { command: "replayed command" },
        }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "replayed",
        toolName: "bash",
        content: [{ type: "text", text: "blocked" }],
        details: rejectedToolDetails({}, "Check mode hard block: command writes outside the project"),
        isError: true,
      },
    },
  ], process.cwd(), false);
  return (lines[0] as Extract<(typeof lines)[number], { kind: "tool" }>).call;
}

function replayedReadCall(): ToolCall {
  const lines = replayEntries([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "replayed-read",
          name: "read",
          arguments: { path: "/repo/file name.ts", offset: 2, limit: 8 },
        }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "replayed-read",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
      },
    },
  ], "/repo", false);
  return (lines[0] as Extract<(typeof lines)[number], { kind: "tool" }>).call;
}

describe("tool line state", () => {
  test("uses a distinct marker for rejected calls", () => {
    expect(toolStateGlyph("rejected")).toBe("!");
    expect(toolStateGlyph("error")).toBe("✗");
    expect(toolStateGlyph("ok")).toBe("✓");
  });

  test("uses one rejection style for live, settled, wrapped, and replayed rows", async () => {
    const setup = await createTestRenderer({ width: 34, height: 20 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const calls: Array<{ call: ToolCall; workingCaret?: boolean }> = [
      { call: { id: "live", name: "bash", arg: "live command", state: "rejected" }, workingCaret: true },
      { call: { id: "settled", name: "edit", arg: "settled.ts", state: "rejected" } },
      { call: { id: "wrapped", name: "bash", arg: "wrapped command with enough text to use another terminal row", state: "rejected" } },
      { call: rejectedReplayCall() },
    ];

    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        {calls.map(({ call, workingCaret }) => (
          <ToolLine key={call.id} theme={theme} call={call} workingCaret={workingCaret} />
        ))}
      </box>,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame.match(/!/g)).toHaveLength(4);
    expect(frame).toContain("another terminal");
    expect(frame).toContain("replayed command");
    const frameLines = frame.split("\n");
    const commandRow = frameLines.findIndex((line) => line.includes("replayed command"));
    const reasonRow = frameLines.findIndex((line) => line.includes("Check mode hard block:"));
    expect(reasonRow).toBe(commandRow + 1);

    const rejection = parseColor(theme.rejection);
    const rejectionBg = parseColor(theme.rejectionBg);
    const capturedLines = setup.captureSpans().lines;
    const spans = capturedLines.flatMap((line) => line.spans);
    const styledText = spans.filter((span) =>
      ["live command", "settled.ts", "wrapped command", "replayed command"].some((text) => span.text.includes(text))
    );
    expect(styledText).toHaveLength(4);
    expect(styledText.every((span) => span.fg.equals(rejection))).toBe(true);
    expect(styledText.every((span) => span.bg.equals(rejectionBg))).toBe(true);

    const markers = spans.filter((span) => span.text === "!");
    expect(markers).toHaveLength(4);
    expect(markers.every((span) => span.fg.equals(rejection))).toBe(true);
    expect(markers.every((span) => span.bg.equals(rejectionBg))).toBe(true);

    const reasonPrefix = spans.find((span) => span.text === "Check mode hard block:");
    expect(reasonPrefix?.fg.equals(rejection)).toBe(true);
    expect(reasonPrefix?.bg.equals(rejectionBg)).toBe(true);
    expect(reasonPrefix?.attributes).toBe(TextAttributes.BOLD);

    const reasonSpans = capturedLines.slice(reasonRow).flatMap((line) => line.spans)
      .filter((span) => span.text.trim());
    expect(reasonSpans.map((span) => span.text).join("")).toContain("command writes outside the project");
    expect(reasonSpans.every((span) => span.fg.equals(rejection))).toBe(true);
    expect(reasonSpans.every((span) => span.bg.equals(rejectionBg))).toBe(true);
  });

  test("preserves failure and success styles", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <ToolLine theme={theme} call={{ id: "failed", name: "bash", arg: "failed command", state: "error" }} />
        <ToolLine theme={theme} call={{ id: "ok", name: "bash", arg: "successful command", state: "ok" }} />
      </box>,
    );
    await settle(setup);

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const failed = spans.find((span) => span.text.includes("failed command"));
    const failedMarker = spans.find((span) => span.text === "✗");
    const successMarker = spans.find((span) => span.text === "✓");
    expect(failed?.fg.equals(parseColor(theme.error))).toBe(true);
    expect(failedMarker?.fg.equals(parseColor(theme.error))).toBe(true);
    expect(successMarker?.fg.equals(parseColor(theme.success))).toBe(true);
    expect(failed?.bg.equals(parseColor(theme.rejectionBg))).toBe(false);
  });

  test("shows identical read arguments for every tool-row state", async () => {
    const setup = await createTestRenderer({ width: 52, height: 12 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const arg = "file name.ts · offset=2 · limit=8";
    const calls: Array<{ call: ToolCall; workingCaret?: boolean }> = [
      { call: { id: "live", name: "read", arg, state: "running" }, workingCaret: true },
      { call: { id: "settled", name: "read", arg, state: "ok" } },
      { call: { id: "rejected", name: "read", arg, state: "rejected" } },
      { call: { id: "failed", name: "read", arg, state: "error" } },
      { call: replayedReadCall() },
    ];

    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        {calls.map(({ call, workingCaret }) => (
          <ToolLine key={call.id} theme={theme} call={call} workingCaret={workingCaret} />
        ))}
      </box>,
    );
    await settle(setup);

    expect(setup.captureCharFrame().match(/file name\.ts · offset=2 · limit=8/g)).toHaveLength(5);
  });

  test("wraps bash commands one column earlier inside the transcript scrollbox", async () => {
    const setup = await createTestRenderer({ width: 28, height: 4 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const arg = "abcdefghijklmno";

    createRoot(setup.renderer).render(
      <scrollbox
        style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <ToolLine theme={theme} call={{ id: "bash", name: "bash", arg, state: "ok" }} />
        <ToolLine theme={theme} call={{ id: "read", name: "read", arg, state: "ok" }} />
      </scrollbox>,
    );
    await settle(setup);

    const frameLines = setup.captureCharFrame().trimEnd().split("\n");
    expect(frameLines.every((line) => line.length === 28)).toBe(true);
    expect(frameLines.every((line) => line.endsWith("█"))).toBe(true);
    const lines = frameLines.map((line) => line.slice(0, -2).trimEnd()).filter((line) => line.trim());
    expect(lines).toEqual([
      "   bash · abcdefghijklmn ✓",
      "          o",
      "   read · abcdefghijklmno✓",
    ]);
  });

  test("aligns wrapped read ranges under the path argument", async () => {
    const setup = await createTestRenderer({ width: 28, height: 6 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        call={{
          id: "read-wrap",
          name: "read",
          arg: "folder/file name.ts · offset=12 · limit=40",
          state: "ok",
        }}
      />,
    );
    await settle(setup);

    const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.search(/\S/) === "  read · ".length)).toBe(true);
    expect(lines.join(" ")).toContain("offset=12");
    expect(lines.join(" ")).toContain("limit=40");
  });

  test("updates rejection colors after a theme change", async () => {
    const setup = await createTestRenderer({ width: 40, height: 6 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const call: ToolCall = { id: "switch", name: "bash", arg: "switch command", state: "rejected" };
    const firstTheme = loadTheme("tokyonight");

    root.render(<ToolLine theme={firstTheme} call={call} />);
    await settle(setup);
    let span = setup.captureSpans().lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes("switch command"));
    expect(span?.fg.equals(parseColor(firstTheme.rejection))).toBe(true);
    expect(span?.bg.equals(parseColor(firstTheme.rejectionBg))).toBe(true);

    const nextTheme = loadTheme("gruvbox");
    root.render(<ToolLine theme={nextTheme} call={call} />);
    await settle(setup);
    span = setup.captureSpans().lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes("switch command"));
    expect(span?.fg.equals(parseColor(nextTheme.rejection))).toBe(true);
    expect(span?.bg.equals(parseColor(nextTheme.rejectionBg))).toBe(true);
    expect(nextTheme.rejection).not.toBe(firstTheme.rejection);
    expect(nextTheme.rejectionBg).not.toBe(firstTheme.rejectionBg);
  });
});

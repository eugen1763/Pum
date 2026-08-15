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

  test("uses orange foreground without a special background for live, settled, wrapped, and replayed rows", async () => {
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
        <ToolLine
          theme={theme}
          call={{ id: "normal", name: "bash", arg: "normal command", state: "ok" }}
        />
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
    const normalRow = frameLines.findIndex((line) => line.includes("normal command"));
    const commandRow = frameLines.findIndex((line) => line.includes("replayed command"));
    const reasonRow = frameLines.findIndex((line) => line.includes("Check mode hard block:"));
    expect(reasonRow).toBe(commandRow + 1);

    const rejection = parseColor(theme.rejection);
    const rejectionBg = parseColor(theme.rejectionBg);
    const capturedLines = setup.captureSpans().lines;
    const spans = capturedLines.flatMap((line) => line.spans);
    const normalSpan = capturedLines[normalRow]?.spans.find((span) => span.text.includes("normal command"));
    expect(normalSpan).toBeDefined();

    const rejectedSpans = capturedLines.slice(normalRow + 1).flatMap((line) => line.spans)
      .filter((span) => span.text.trim());
    expect(rejectedSpans.length).toBeGreaterThan(0);
    expect(rejectedSpans.every((span) => span.fg.equals(rejection))).toBe(true);
    expect(rejectedSpans.every((span) => span.bg.equals(normalSpan!.bg))).toBe(true);
    expect(rejectedSpans.every((span) => !span.bg.equals(rejectionBg))).toBe(true);

    const markers = spans.filter((span) => span.text === "!");
    expect(markers).toHaveLength(4);
    expect(markers.every((span) => span.fg.equals(rejection))).toBe(true);
    expect(markers.every((span) => span.bg.equals(normalSpan!.bg))).toBe(true);

    const reasonPrefix = spans.find((span) => span.text === "Check mode hard block:");
    expect(reasonPrefix?.fg.equals(rejection)).toBe(true);
    expect(reasonPrefix?.bg.equals(normalSpan!.bg)).toBe(true);
    expect(reasonPrefix!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);

    const reasonSpans = capturedLines.slice(reasonRow).flatMap((line) => line.spans)
      .filter((span) => span.text.trim());
    expect(reasonSpans.map((span) => span.text).join("")).toContain("command writes outside the project");
    expect(reasonSpans.every((span) => span.fg.equals(rejection))).toBe(true);
    expect(reasonSpans.every((span) => span.bg.equals(normalSpan!.bg))).toBe(true);
    const reasonSuffix = reasonSpans.filter((span) => span !== reasonPrefix);
    expect(reasonSuffix.length).toBeGreaterThan(0);
    expect(reasonSuffix.every((span) => (span.attributes & TextAttributes.BOLD) === 0)).toBe(true);
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

  test("shows read and command results with the same detailed line limit", async () => {
    const setup = await createTestRenderer({ width: 52, height: 16 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <ToolLine
          theme={theme}
          call={{
            id: "read-output",
            name: "read",
            arg: "file.ts",
            state: "ok",
            output: "read one\nread two\nread three",
          }}
          outputLines={2}
        />
        <ToolLine
          theme={theme}
          call={{
            id: "bash-output",
            name: "bash",
            arg: "printf output",
            state: "ok",
            output: "bash one\nbash two\nbash three",
          }}
          outputLines={2}
        />
        <ToolLine
          theme={theme}
          call={{
            id: "hidden-output",
            name: "read",
            arg: "hidden.ts",
            state: "ok",
            output: "hidden result",
          }}
        />
      </box>,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("read one");
    expect(frame).toContain("read two");
    expect(frame).not.toContain("read three");
    expect(frame).toContain("bash one");
    expect(frame).toContain("bash two");
    expect(frame).not.toContain("bash three");
    expect(frame.match(/… 1 more line/g)).toHaveLength(2);
    expect(frame).not.toContain("hidden result");
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
    const setup = await createTestRenderer({ width: 48, height: 8 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const call: ToolCall = {
      id: "switch",
      name: "bash",
      arg: "switch command",
      state: "rejected",
      detail: "Check mode hard block: switch reason",
    };
    const firstTheme = loadTheme("tokyonight");

    root.render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <ToolLine
          theme={firstTheme}
          call={{ id: "normal", name: "bash", arg: "normal command", state: "ok" }}
        />
        <ToolLine theme={firstTheme} call={call} />
      </box>,
    );
    await settle(setup);
    let spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    let normal = spans.find((item) => item.text.includes("normal command"));
    let command = spans.find((item) => item.text.includes("switch command"));
    let prefix = spans.find((item) => item.text === "Check mode hard block:");
    let suffix = spans.find((item) => item.text.includes("switch reason"));
    expect(command?.fg.equals(parseColor(firstTheme.rejection))).toBe(true);
    expect(prefix?.fg.equals(parseColor(firstTheme.rejection))).toBe(true);
    expect(suffix?.fg.equals(parseColor(firstTheme.rejection))).toBe(true);
    expect(command?.bg.equals(normal!.bg)).toBe(true);
    expect(prefix!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);

    const nextTheme = loadTheme("gruvbox");
    root.render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <ToolLine
          theme={nextTheme}
          call={{ id: "normal", name: "bash", arg: "normal command", state: "ok" }}
        />
        <ToolLine theme={nextTheme} call={call} />
      </box>,
    );
    await settle(setup);
    spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    normal = spans.find((item) => item.text.includes("normal command"));
    command = spans.find((item) => item.text.includes("switch command"));
    prefix = spans.find((item) => item.text === "Check mode hard block:");
    suffix = spans.find((item) => item.text.includes("switch reason"));
    expect(command?.fg.equals(parseColor(nextTheme.rejection))).toBe(true);
    expect(prefix?.fg.equals(parseColor(nextTheme.rejection))).toBe(true);
    expect(suffix?.fg.equals(parseColor(nextTheme.rejection))).toBe(true);
    expect(command?.bg.equals(normal!.bg)).toBe(true);
    expect(command?.bg.equals(parseColor(nextTheme.rejectionBg))).toBe(false);
    expect(prefix!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD);
    expect(nextTheme.rejection).not.toBe(firstTheme.rejection);
  });
});

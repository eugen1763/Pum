import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes, parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { rejectedToolDetails } from "../src/check-mode";
import { replayEntries } from "../src/replay";
import { ToolLine, TOOL_DETAIL_INDENT, toolStateGlyph } from "../src/transcript";
import { loadTheme } from "../src/theme";
import { bashOutput, bashOutputWindow, bashResultDisplay, type ToolCall } from "../src/tool-line";

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
  test("extracts cumulative Bash progress and keeps the newest four logical lines", () => {
    const output = bashOutput({
      content: [
        { type: "text", text: "one\r\ntwo\n" },
        { type: "image", data: "ignored" },
        { type: "text", text: "three\rfour\nfive\n" },
      ],
    });
    expect(output).toBe("one\r\ntwo\nthree\rfour\nfive\n");
    expect(bashOutputWindow(output!)).toEqual({
      hidden: 1,
      lines: ["two", "three", "four", "five"],
    });
    expect(bashResultDisplay({
      content: [{ type: "text", text: "first\nlast output\n\nCommand exited with code 7" }],
    })).toEqual({ exitCode: 7 });
    expect(bashResultDisplay({
      content: [{ type: "text", text: "first\nlast output\n" }],
    })).toEqual({});
  });

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
      { call: { id: "live", name: "bash", args: ["live command"], state: "rejected" }, workingCaret: true },
      { call: { id: "settled", name: "edit", args: ["settled.ts"], state: "rejected" } },
      { call: { id: "wrapped", name: "bash", args: ["wrapped command with enough text to use another terminal row"], state: "rejected" } },
      { call: rejectedReplayCall() },
    ];

    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <ToolLine
          theme={theme}
          call={{ id: "normal", name: "bash", args: ["normal command"], state: "ok" }}
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
        <ToolLine theme={theme} call={{ id: "failed", name: "bash", args: ["failed command"], state: "error" }} />
        <ToolLine theme={theme} call={{ id: "ok", name: "bash", args: ["successful command"], state: "ok" }} />
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
    const args = ["file name.ts", "offset=2", "limit=8"];
    const calls: Array<{ call: ToolCall; workingCaret?: boolean }> = [
      { call: { id: "live", name: "read", args, state: "running" }, workingCaret: true },
      { call: { id: "settled", name: "read", args, state: "ok" } },
      { call: { id: "rejected", name: "read", args, state: "rejected" } },
      { call: { id: "failed", name: "read", args, state: "error" } },
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

    expect(setup.captureCharFrame().match(/read\(file name\.ts, offset=2, limit=8\)/g))
      .toHaveLength(5);
  });

  test("wraps bash commands one column earlier inside the transcript scrollbox", async () => {
    const setup = await createTestRenderer({ width: 28, height: 4 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    // Long enough that the extra column bash reserves changes where it breaks.
    const args = ["abcdefghijklmnopq"];

    createRoot(setup.renderer).render(
      <scrollbox
        style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <ToolLine theme={theme} call={{ id: "bash", name: "bash", args, state: "ok" }} />
        <ToolLine theme={theme} call={{ id: "read", name: "read", args, state: "ok" }} />
      </scrollbox>,
    );
    await settle(setup);

    const frameLines = setup.captureCharFrame().trimEnd().split("\n");
    expect(frameLines.every((line) => line.length === 28)).toBe(true);
    expect(frameLines.every((line) => line.endsWith("█"))).toBe(true);
    const lines = frameLines.map((line) => line.slice(0, -2).trimEnd()).filter((line) => line.trim());
    // bash breaks one character earlier than read, and both continuations line
    // up under the opening bracket rather than under the tool name.
    expect(lines).toEqual([
      "   bash(abcdefghijklmnop ✓",
      "        q)",
      "   read(abcdefghijklmnopq✓",
      "        )",
    ]);
  });

  test("renders every line of a multiline Bash command", async () => {
    const setup = await createTestRenderer({ width: 40, height: 6 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        call={{
          id: "multiline-bash",
          name: "bash",
          args: ["printf one \\\n  && printf two"],
          state: "ok",
        }}
      />,
    );
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("bash(printf one \\");
    expect(frame).toContain("&& printf two)");
  });

  test("shows the newest four running Bash output lines below and aligned with the command", async () => {
    const setup = await createTestRenderer({ width: 34, height: 12 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        call={{
          id: "streaming-bash",
          name: "bash",
          args: ["a command that wraps automatically"],
          state: "running",
          output: "old one\nold two\nnew three\nnew four\nnew five\na newest output line that also wraps\n",
        }}
      />,
    );
    await settle(setup);

    const frameLines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
    expect(frameLines.some((line) => line.includes("... 2 more lines"))).toBe(true);
    expect(frameLines.some((line) => line.includes("old one"))).toBe(false);
    expect(frameLines.some((line) => line.includes("old two"))).toBe(false);
    expect(frameLines.some((line) => line.includes("new three"))).toBe(true);
    expect(frameLines.some((line) => line.includes("new four"))).toBe(true);
    expect(frameLines.some((line) => line.includes("new five"))).toBe(true);
    expect(frameLines.some((line) => line.includes("a newest output"))).toBe(true);

    // Every tool-related row shares one indent, whatever the tool is called.
    const commandColumn = frameLines.find((line) => line.includes("bash("))!.search(/\S/);
    const outputRows = frameLines.filter((line) =>
      line.includes("more lines") || line.includes("new three") || line.includes("that also wraps")
    );
    expect(outputRows.every((line) => line.search(/\S/) === commandColumn + TOOL_DETAIL_INDENT))
      .toBe(true);

    const outputSpans = setup.captureSpans().lines.flatMap((line) => line.spans)
      .filter((span) => span.text.includes("more lines") || span.text.includes("new three"));
    expect(outputSpans.length).toBeGreaterThan(0);
    expect(outputSpans.every((span) => span.fg.equals(parseColor(theme.bashOutput)))).toBe(true);
  });

  test("Quiet hides the live Bash tail while Normal shows it", async () => {
    const setup = await createTestRenderer({ width: 50, height: 10 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const root = createRoot(setup.renderer);
    const call: ToolCall = {
      id: "mode-bash",
      name: "bash",
      args: ["slow command"],
      state: "running",
      output: "live command output",
    };

    root.render(<ToolLine theme={theme} outputMode="quiet" call={call} />);
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("live command output");

    root.render(<ToolLine theme={theme} outputMode="normal" call={call} />);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("live command output");
  });

  test("renders whatever live output it is handed, settled or not", async () => {
    // Whether the period is open is decided once, in the dwell layer, so this
    // row has no timing of its own to get wrong on a remount.
    const setup = await createTestRenderer({ width: 40, height: 8 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const root = createRoot(setup.renderer);

    root.render(
      <ToolLine
        theme={theme}
        call={{ id: "settled-bash", name: "bash", args: ["done"], state: "ok", output: "last output" }}
      />,
    );
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("last output");

    root.render(
      <ToolLine
        theme={theme}
        call={{ id: "settled-bash", name: "bash", args: ["done"], state: "ok" }}
      />,
    );
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("last output");
  });

  test("shows a failed Bash exit code after a dot separator", async () => {
    const setup = await createTestRenderer({ width: 48, height: 8 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        call={{
          id: "failed-bash",
          name: "bash",
          args: ["failing command"],
          state: "error",
          exitCode: 7,
        }}
      />,
    );
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("bash(failing command) · exit 7");
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
          args: ["folder/file name.ts", "offset=12", "limit=40"],
          state: "ok",
        }}
      />,
    );
    await settle(setup);

    const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.search(/\S/) === "  read(".length)).toBe(true);
    expect(lines.join(" ")).toContain("offset=12");
    expect(lines.join(" ")).toContain("limit=40");
  });

  test("renders a call as tool(first, second) with muted brackets", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");

    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        call={{ id: "read", name: "read", args: ["src/a.ts", "offset=2"], state: "ok" }}
      />,
    );
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("read(src/a.ts, offset=2)");

    const spans = setup.captureSpans().lines[0]!.spans.filter((span) => span.text.trim());
    const colorOf = (needle: string) =>
      spans.find((span) => span.text.includes(needle))!.fg;
    // The name, the brackets and the comma recede; only the arguments carry the
    // accent, and no signal colour appears anywhere but the state marker.
    expect(colorOf("read(").equals(parseColor(theme.tool))).toBe(true);
    expect(colorOf("src/a.ts").equals(parseColor(theme.toolArg))).toBe(true);
    expect(colorOf(",").equals(parseColor(theme.tool))).toBe(true);
    expect(colorOf("✓").equals(parseColor(theme.success))).toBe(true);
    for (const span of spans) {
      if (span.text.includes("✓")) continue;
      expect(span.fg.equals(parseColor(theme.error))).toBe(false);
      expect(span.fg.equals(parseColor(theme.success))).toBe(false);
      expect(span.fg.equals(parseColor(theme.rejection))).toBe(false);
    }
  });

  test("renders a call with no arguments as empty brackets", async () => {
    const setup = await createTestRenderer({ width: 40, height: 3 });
    destroy = () => setup.renderer.destroy();

    createRoot(setup.renderer).render(
      <ToolLine
        theme={loadTheme("tokyonight")}
        call={{ id: "l", name: "list_subagents", args: [], state: "ok" }}
      />,
    );
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("list_subagents()");
  });

  test("updates rejection colors after a theme change", async () => {
    const setup = await createTestRenderer({ width: 48, height: 8 });
    destroy = () => setup.renderer.destroy();
    const root = createRoot(setup.renderer);
    const call: ToolCall = {
      id: "switch",
      name: "bash",
      args: ["switch command"],
      state: "rejected",
      detail: "Check mode hard block: switch reason",
    };
    const firstTheme = loadTheme("tokyonight");

    root.render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <ToolLine
          theme={firstTheme}
          call={{ id: "normal", name: "bash", args: ["normal command"], state: "ok" }}
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
          call={{ id: "normal", name: "bash", args: ["normal command"], state: "ok" }}
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

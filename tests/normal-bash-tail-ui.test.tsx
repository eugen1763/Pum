import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { ToolLine, rawToolText } from "../src/transcript";
import { loadTheme } from "../src/theme";
import type { ToolCall } from "../src/tool-line";
import type { TranscriptOutputMode } from "../src/transcript-output";
import { replayEntries } from "../src/replay";
import { startedToolCall, settledToolCall } from "../src/tool-row";

let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); });

async function renderTail(output: string, width = 24, mode: TranscriptOutputMode = "normal", state: ToolCall["state"] = "ok") {
  const setup = await createTestRenderer({ width, height: 25 });
  destroy = () => setup.renderer.destroy();
  const root = createRoot(setup.renderer);
  const call: ToolCall = { id: "tail", name: "bash", args: ["cmd"], state, result: { content: [{ type: "text", text: output }] }, ...(state === "running" ? { output } : {}) };
  const wheelEvents = { count: 0 };
  const render = () => root.render(<box onMouseScroll={() => { wheelEvents.count++; }} style={{ width: "100%", flexDirection: "column" }}><ToolLine theme={loadTheme("tokyonight")} call={call} outputMode={mode} /><text content="END" /></box>);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    await setup.flush();
  };
  render();
  await settle();
  return { ...setup, call, render, settle, wheelEvents, rows: () => setup.captureCharFrame().split("\n").map((row) => row.trimEnd()) };
}

test("Normal caps a single wrapped line at five visual rows and keeps its final text", async () => {
  const output = "A".repeat(120) + "TAIL";
  const setup = await renderTail(output);
  const rows = setup.rows();
  expect(rows.indexOf("END")).toBe(6);
  expect(rows[5]).toContain("TAIL");
  expect(rows.slice(1, 6).every((row) => row.startsWith("    "))).toBe(true);
  expect(rawToolText(setup.call)).toContain(output);
});

test("short output and trailing newline do not reserve five rows", async () => {
  const setup = await renderTail("one\r\ntwo\n");
  expect(setup.rows().slice(1, 4)).toEqual(["    one", "    two", "END"]);
});

test("Normal shows only the last five logical rows when no wrapping is needed", async () => {
  const setup = await renderTail("one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  expect(setup.rows().slice(1, 7)).toEqual(["    three", "    four", "    five", "    six", "    seven", "END"]);
});

test("running Normal output uses the same visual cap", async () => {
  const setup = await renderTail("X".repeat(120) + "TAIL", 24, "normal", "running");
  expect(setup.rows().indexOf("END")).toBe(6);
  expect(setup.rows()[5]).toContain("TAIL");
});

test("resize rewraps the native viewport and retains the last five rows", async () => {
  const setup = await renderTail("界e\u0301👩‍💻 ".repeat(35) + "TAIL", 44);
  expect(setup.rows().indexOf("END")).toBe(6);
  setup.resize(14, 25);
  await setup.settle();
  expect(setup.rows().indexOf("END")).toBe(6);
  expect(setup.rows()[5]).toContain("TAIL");
  expect(setup.rows().slice(1, 6).every((row) => Bun.stringWidth(row) <= 14)).toBe(true);
  setup.resize(90, 25);
  await setup.settle();
  expect(setup.rows().indexOf("END")).toBeLessThanOrEqual(6);
  expect(setup.captureCharFrame()).toContain("TAIL");
});

test("new output follows the tail even when the viewport height stays unchanged", async () => {
  const setup = await renderTail("old\n".repeat(20), 24, "normal", "running");
  setup.call.output = "new\n".repeat(30) + "FINAL";
  setup.render();
  await setup.settle();
  expect(setup.rows().indexOf("END")).toBe(6);
  expect(setup.rows()[5]).toContain("FINAL");
});

test("empty output reserves no detail rows and internal blank lines are retained", async () => {
  const setup = await renderTail("");
  expect(setup.rows().indexOf("END")).toBe(1);
  setup.call.result = "one\n\ntwo\n\n";
  setup.render();
  await setup.settle();
  expect(setup.rows().slice(1, 6)).toEqual(["    one", "", "    two", "", "END"]);
});

test("wheel input reaches the transcript without scrolling away from the tail", async () => {
  const setup = await renderTail("old\n".repeat(20) + "FINAL");
  const before = setup.captureCharFrame();
  await setup.mockMouse.scroll(6, 3, "up");
  await setup.settle();
  expect(setup.captureCharFrame()).toBe(before);
  expect(setup.wheelEvents.count).toBeGreaterThan(0);
});

test("Quiet hides the automatic tail", async () => {
  const setup = await renderTail("TAIL", 24, "quiet");
  expect(setup.rows().indexOf("END")).toBe(1);
  expect(setup.captureCharFrame()).not.toContain("TAIL");
});

test("main/child shared settlement and replay render the same final Bash tail", async () => {
  const output = "first\nsecond\nthird\nfourth\nfifth\nsixth\nFINAL\n";
  const setup = await renderTail(output);
  const result = { content: [{ type: "text", text: output }], isError: false };
  const input = { command: "cmd" };
  const live = { ...startedToolCall({ id: "tail", name: "bash", args: input }, process.cwd()), ...settledToolCall({ name: "bash", result }) };
  Object.assign(setup.call, live);
  setup.render();
  await setup.settle();
  const liveFrame = setup.captureCharFrame();
  const replayed = replayEntries([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tail", name: "bash", arguments: input }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "tail", toolName: "bash", ...result } },
  ], process.cwd(), false);
  const row = replayed.find((line) => line.kind === "tool");
  if (!row || row.kind !== "tool") throw new Error("Missing replayed Bash row");
  Object.assign(setup.call, row.call);
  setup.render();
  await setup.settle();
  expect(setup.captureCharFrame()).toBe(liveFrame);
  expect(setup.rows().indexOf("END")).toBe(6);
  expect(setup.rows()[5]).toContain("FINAL");
});

test("failed Bash retains its marker and exit status alongside the capped tail", async () => {
  const setup = await renderTail("error\n".repeat(9) + "FINAL", 40, "normal", "error");
  setup.call.exitCode = 7;
  setup.render();
  await setup.settle();
  expect(setup.rows()[0]).toContain("✗");
  expect(setup.rows()[0]).toContain("exit 7");
  expect(setup.rows().indexOf("END")).toBe(6);
  expect(setup.rows()[5]).toContain("FINAL");
});

test("Verbose retains the raw result rather than the automatic tail", async () => {
  const setup = await renderTail("TAIL", 60, "verbose");
  expect(setup.captureCharFrame()).toContain("result:");
  expect(setup.captureCharFrame()).toContain('"text": "TAIL"');
});

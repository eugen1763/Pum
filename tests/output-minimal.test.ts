import { describe, expect, test } from "bun:test";
import {
  minimalToolPhrase,
  minimalTranscriptLines,
  summarizeSuccessfulToolCalls,
} from "../src/output-minimal";
import type { Line } from "../src/transcript";
import type { ToolCall } from "../src/tool-line";

const call = (
  id: string,
  name: string,
  state: ToolCall["state"] = "ok",
  detail?: string,
): ToolCall => ({ id, name, state, args: [`private argument for ${id}`], detail });

const tool = (value: ToolCall): Line => ({ kind: "tool", call: value });
const text = (value: string): Line => ({ kind: "text", role: "assistant", text: value });

describe("minimal tool phrases", () => {
  test("uses correct singular and plural grammar for core tools", () => {
    expect(minimalToolPhrase("read", 1)).toBe("Read 1 file");
    expect(minimalToolPhrase("read", 3)).toBe("Read 3 files");
    expect(minimalToolPhrase("write", 2)).toBe("Wrote 2 files");
    expect(minimalToolPhrase("edit", 2)).toBe("Edited 2 files");
    expect(minimalToolPhrase("apply_patch", 2)).toBe("Applied 2 patches");
    expect(minimalToolPhrase("apply_path", 2)).toBe("Applied 2 patches");
    expect(minimalToolPhrase("bash", 2)).toBe("Ran 2 commands");
    expect(minimalToolPhrase("web_search", 2)).toBe("Ran 2 web searches");
    expect(minimalToolPhrase("questionnaire", 2)).toBe("Asked 2 questionnaires");
    expect(minimalToolPhrase("enable_tools", 2)).toBe("Enabled 2 tool groups");
  });

  test("covers subagent, worktree, trigger, cache, and shell tools", () => {
    const expected: Record<string, [string, string]> = {
      spawn_subagent: ["Spawned 1 subagent", "Spawned 2 subagents"],
      message_agent: ["Sent 1 agent message", "Sent 2 agent messages"],
      list_subagents: ["Listed subagents", "Listed subagents 2 times"],
      stop_subagent: ["Stopped 1 subagent", "Stopped 2 subagents"],
      finish_subagent: ["Finished 1 subagent task", "Finished 2 subagent tasks"],
      worktree: ["Ran 1 worktree operation", "Ran 2 worktree operations"],
      create_trigger: ["Created 1 trigger", "Created 2 triggers"],
      list_triggers: ["Listed triggers", "Listed triggers 2 times"],
      inspect_trigger: ["Inspected 1 trigger", "Inspected 2 triggers"],
      pause_trigger: ["Paused 1 trigger", "Paused 2 triggers"],
      resume_trigger: ["Resumed 1 trigger", "Resumed 2 triggers"],
      cancel_trigger: ["Cancelled 1 trigger", "Cancelled 2 triggers"],
      invoke_trigger: ["Ran 1 trigger", "Ran 2 triggers"],
      message_cache_list: ["Listed the message cache", "Listed the message cache 2 times"],
      message_cache_read: ["Read 1 cached message", "Read 2 cached messages"],
      message_cache_add: ["Added 1 cached message", "Added 2 cached messages"],
      message_cache_delete: ["Deleted 1 cached message", "Deleted 2 cached messages"],
      message_cache_send: ["Sent 1 cached task batch", "Sent 2 cached task batches"],
      start_shell: ["Started 1 shell", "Started 2 shells"],
      list_shells: ["Listed shells", "Listed shells 2 times"],
      inspect_shell: ["Inspected 1 shell", "Inspected 2 shells"],
      get_shell_output: ["Read shell output", "Read shell output 2 times"],
      kill_shell: ["Killed 1 shell", "Killed 2 shells"],
    };

    for (const [name, [singular, plural]] of Object.entries(expected)) {
      expect(minimalToolPhrase(name, 1)).toBe(singular);
      expect(minimalToolPhrase(name, 2)).toBe(plural);
    }
  });

  test("uses a safe fallback for future tools and validates counts", () => {
    expect(minimalToolPhrase("custom_tool", 1)).toBe("Completed 1 custom tool call");
    expect(minimalToolPhrase("custom_tool", 2)).toBe("Completed 2 custom tool calls");
    expect(() => minimalToolPhrase("read", 0)).toThrow("positive integer");
  });
});

describe("minimal transcript transformation", () => {
  test("groups routine calls but keeps successful commands and mutations visible", () => {
    const lines: Line[] = [
      tool(call("r1", "read")),
      tool(call("b1", "bash")),
      tool(call("r2", "read")),
      tool(call("e1", "edit")),
    ];

    const result = minimalTranscriptLines(lines);
    expect(result.map((line) => line.kind === "tool-summary"
      ? line.text
      : line.kind === "tool" ? line.call.id : line.kind)).toEqual([
      "Read 1 file.",
      "b1",
      "Read 1 file.",
      "e1",
    ]);
    if (result[0]?.kind === "tool-summary") {
      expect(result[0].calls.map((item) => item.id)).toEqual(["r1"]);
      expect(result[0].text).not.toContain("private argument");
    }
  });

  test("Quiet folds commands and mutations into the run as well", () => {
    const lines: Line[] = [
      tool(call("r1", "read")),
      tool(call("b1", "bash")),
      tool(call("r2", "read")),
      tool(call("e1", "edit")),
    ];

    const result = minimalTranscriptLines(lines, true);
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("tool-summary");
    if (result[0]?.kind !== "tool-summary") throw new Error("Expected one summary");
    expect(result[0].text).toBe("Read 2 files, ran 1 command, and edited 1 file.");
    expect(result[0].calls.map((item) => item.id)).toEqual(["r1", "b1", "r2", "e1"]);
    expect(result[0].text).not.toContain("private argument");
  });

  test("a failure still breaks a Quiet run in two", () => {
    const lines: Line[] = [
      tool(call("b1", "bash")),
      tool(call("b2", "bash", "error", "exit 1")),
      tool(call("b3", "bash")),
    ];

    expect(minimalTranscriptLines(lines, true).map((line) => line.kind === "tool-summary"
      ? line.text
      : line.kind === "tool" ? line.call.id : line.kind)).toEqual([
      "Ran 1 command.",
      "b2",
      "Ran 1 command.",
    ]);
  });

  test("reads as one sentence, so only the first phrase keeps its capital", () => {
    const summary = summarizeSuccessfulToolCalls([
      call("r1", "read"), call("b1", "bash"), call("e1", "edit"), call("w1", "write"),
    ]);
    expect(summary.text).toBe("Read 1 file, ran 1 command, edited 1 file, and wrote 1 file.");

    expect(summarizeSuccessfulToolCalls([call("r1", "read"), call("b1", "bash")]).text)
      .toBe("Read 1 file and ran 1 command.");
    expect(summarizeSuccessfulToolCalls([call("r1", "read")]).text).toBe("Read 1 file.");
  });

  test("summarizes an isolated success without its argument", () => {
    expect(minimalTranscriptLines([tool(call("r1", "read"))])).toEqual([{
      kind: "tool-summary",
      text: "Read 1 file.",
      calls: [{
        id: "r1",
        name: "read",
        state: "ok",
        args: ["private argument for r1"],
        detail: undefined,
      }],
    }]);
  });

  test("ends runs at every non-tool line", () => {
    const result = minimalTranscriptLines([
      tool(call("r1", "read")),
      text("Between runs"),
      tool(call("r2", "read")),
    ]);
    expect(result.map((line) => line.kind === "tool-summary" ? line.text : line.kind)).toEqual([
      "Read 1 file.",
      "text",
      "Read 1 file.",
    ]);
  });

  test("keeps running, failed, and rejected calls individual with details", () => {
    const running = tool(call("b1", "bash", "running", "live output"));
    const failed = tool(call("b2", "bash", "error", "exit 2"));
    const rejected = tool(call("b3", "bash", "rejected", "hard block"));
    const result = minimalTranscriptLines([
      tool(call("r1", "read")),
      running,
      tool(call("r2", "read")),
      failed,
      rejected,
      tool(call("r3", "read")),
    ]);

    expect(result).toEqual([
      expect.objectContaining({ kind: "tool-summary", text: "Read 1 file." }),
      running,
      expect.objectContaining({ kind: "tool-summary", text: "Read 1 file." }),
      failed,
      rejected,
      expect.objectContaining({ kind: "tool-summary", text: "Read 1 file." }),
    ]);
  });

  test("does not mutate source lines or calls", () => {
    const originalCall = call("r1", "read");
    const lines = [tool(originalCall)];
    const result = minimalTranscriptLines(lines);
    if (result[0]?.kind !== "tool-summary") throw new Error("Expected summary");
    result[0].calls[0]!.args = ["changed"];
    expect(originalCall.args).toEqual(["private argument for r1"]);
    expect(lines[0]).toEqual(tool(originalCall));
  });

  test("rejects invalid direct summary input", () => {
    expect(() => summarizeSuccessfulToolCalls([])).toThrow("one or more successful");
    expect(() => summarizeSuccessfulToolCalls([call("bad", "read", "error")]))
      .toThrow("one or more successful");
  });
});

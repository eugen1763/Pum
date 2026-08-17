import { describe, expect, test } from "bun:test";
import {
  heldTranscriptLines,
  LIVE_OUTPUT_DELAY_MS,
  MIN_VISIBLE_MS,
  YOUNG_ROW_MS,
  type DwellMemory,
} from "../src/transcript-dwell";
import type { Line } from "../src/transcript";
import type { ToolCall } from "../src/tool-line";

const call = (state: ToolCall["state"], id = "call-1"): Line => ({
  kind: "tool",
  call: { id, name: "read", args: ["src/app.tsx"], state },
});

const text: Line = { kind: "text", role: "assistant", text: "done" };

const empty = (): DwellMemory => new Map();

describe("the young-row rule", () => {
  test("a running row younger than the window is not drawn", () => {
    const first = heldTranscriptLines([call("running")], empty(), 1_000);
    expect(first.lines).toEqual([]);
    expect(first.nextDeadline).toBe(1_000 + YOUNG_ROW_MS);
  });

  test("a row that settles while young appears already settled", () => {
    const first = heldTranscriptLines([call("running")], empty(), 1_000);
    const settled = heldTranscriptLines([call("ok")], first.memory, 1_050);
    // No running form was ever on screen, so there is nothing to flicker: the
    // row is drawn settled and groups immediately.
    expect(settled.lines).toEqual([call("ok")]);
    expect(settled.nextDeadline).toBeUndefined();
  });

  test("a row still running past the window is drawn", () => {
    const first = heldTranscriptLines([call("running")], empty(), 1_000);
    const shown = heldTranscriptLines([call("running")], first.memory, 1_000 + YOUNG_ROW_MS);
    expect(shown.lines).toEqual([call("running")]);
  });
});

describe("the minimum-visible rule", () => {
  const drawn = () => {
    const first = heldTranscriptLines([call("running")], empty(), 0);
    return heldTranscriptLines([call("running")], first.memory, YOUNG_ROW_MS);
  };

  test("a drawn row keeps its form until it has had its time", () => {
    const shown = drawn();
    const early = heldTranscriptLines([call("ok")], shown.memory, YOUNG_ROW_MS + 10);
    expect(early.lines).toEqual([call("running")]);
    expect(early.nextDeadline).toBe(YOUNG_ROW_MS + MIN_VISIBLE_MS);
  });

  test("the canonical form is adopted once the dwell expires", () => {
    const shown = drawn();
    const early = heldTranscriptLines([call("ok")], shown.memory, YOUNG_ROW_MS + 10);
    const late = heldTranscriptLines(
      [call("ok")],
      early.memory,
      YOUNG_ROW_MS + MIN_VISIBLE_MS,
    );
    expect(late.lines).toEqual([call("ok")]);
    expect(late.nextDeadline).toBeUndefined();
  });

  test("each new form earns its own dwell, so two changes cannot stack up", () => {
    const shown = drawn();
    const settled = heldTranscriptLines(
      [call("ok")],
      shown.memory,
      YOUNG_ROW_MS + MIN_VISIBLE_MS,
    );
    const changedAgain = heldTranscriptLines(
      [call("error")],
      settled.memory,
      YOUNG_ROW_MS + MIN_VISIBLE_MS + 10,
    );
    expect(changedAgain.lines).toEqual([call("ok")]);
    expect(changedAgain.nextDeadline).toBe(YOUNG_ROW_MS + 2 * MIN_VISIBLE_MS);
  });

  test("live text is not a change of form, so output is never stuttered", () => {
    const shown = drawn();
    const streaming: Line = {
      kind: "tool",
      call: { id: "call-1", name: "read", args: ["src/app.tsx"], state: "running", detail: "+3 −1" },
    };
    const next = heldTranscriptLines([streaming], shown.memory, YOUNG_ROW_MS + 10);
    expect(next.lines).toEqual([streaming]);
    expect(next.nextDeadline).toBeUndefined();
  });
});

describe("rows that never change", () => {
  test("text rows pass through untouched and unremembered", () => {
    const result = heldTranscriptLines([text], empty(), 1_000);
    expect(result.lines).toEqual([text]);
    expect(result.memory.size).toBe(0);
  });

  test("a goal review obeys the same rules as a tool row", () => {
    const reviewing: Line = { kind: "goal-review", id: "judge-1", status: "reviewing" };
    const completed: Line = { kind: "goal-review", id: "judge-1", status: "completed", body: "done" };
    const first = heldTranscriptLines([reviewing], empty(), 0);
    const shown = heldTranscriptLines([reviewing], first.memory, YOUNG_ROW_MS);
    const early = heldTranscriptLines([completed], shown.memory, YOUNG_ROW_MS + 10);
    // The summary arrives with the verdict, so the whole row is held. Showing
    // the new body under the old status would read as a finished review that
    // still calls itself running.
    expect(early.lines).toEqual([reviewing]);
    const late = heldTranscriptLines(
      [completed],
      early.memory,
      YOUNG_ROW_MS + MIN_VISIBLE_MS,
    );
    expect(late.lines).toEqual([completed]);
  });
});

describe("memory", () => {
  test("a row that leaves the transcript is forgotten", () => {
    const first = heldTranscriptLines([call("ok")], empty(), 0);
    expect(first.memory.size).toBe(1);
    const cleared = heldTranscriptLines([text], first.memory, 10);
    expect(cleared.memory.size).toBe(0);
  });

  test("the earliest deadline of many rows is the one returned", () => {
    const a = heldTranscriptLines([call("running", "a")], empty(), 0);
    const b = heldTranscriptLines(
      [call("running", "a"), call("running", "b")],
      a.memory,
      100,
    );
    expect(b.nextDeadline).toBe(YOUNG_ROW_MS);
  });

  test("the input is never mutated", () => {
    const memory = empty();
    const lines = [call("running")];
    heldTranscriptLines(lines, memory, 0);
    expect(memory.size).toBe(0);
    expect(lines).toEqual([call("running")]);
  });
});

describe("live command output", () => {
  const bash = (state: ToolCall["state"], output?: string, startedAt = 0): Line => ({
    kind: "tool",
    call: {
      id: "bash-1",
      name: "bash",
      args: ["bun test"],
      state,
      startedAt,
      ...(output ? { output } : {}),
    },
  });

  const shownOutput = (line: Line | undefined) =>
    line?.kind === "tool" ? line.call.output : undefined;

  test("output waits for the delay, so a fast command never flashes one", () => {
    const early = heldTranscriptLines([bash("running", "1486 pass")], empty(), 100);
    // The row itself is still too young to draw, so that is the nearer deadline.
    expect(early.lines).toEqual([]);
    expect(early.nextDeadline).toBe(YOUNG_ROW_MS);

    const drawn = heldTranscriptLines([bash("running", "1486 pass")], early.memory, YOUNG_ROW_MS);
    expect(shownOutput(drawn.lines[0])).toBeUndefined();
    expect(drawn.nextDeadline).toBe(LIVE_OUTPUT_DELAY_MS);

    const settled = heldTranscriptLines([bash("ok", "1486 pass")], drawn.memory, 450);
    expect(shownOutput(settled.lines[0])).toBeUndefined();
    // Closed for good, so no later render can reopen it.
    expect(settled.memory.get("tool:bash-1")?.outputDone).toBe(true);
  });

  test("a slow command streams its output while it runs", () => {
    const running = heldTranscriptLines([bash("running", "compiling")], empty(), 600);
    expect(shownOutput(running.lines[0])).toBe("compiling");
    const more = heldTranscriptLines(
      [bash("running", "compiling\nlinking")],
      running.memory,
      5_000,
    );
    expect(shownOutput(more.lines[0])).toBe("compiling\nlinking");
  });

  test("output closes once what is on screen has had its time", () => {
    const running = heldTranscriptLines([bash("running", "compiling")], empty(), 600);
    const justSettled = heldTranscriptLines([bash("ok", "compiling")], running.memory, 1_000);
    expect(shownOutput(justSettled.lines[0])).toBe("compiling");
    expect(justSettled.nextDeadline).toBe(600 + MIN_VISIBLE_MS);

    const later = heldTranscriptLines(
      [bash("ok", "compiling")],
      justSettled.memory,
      600 + MIN_VISIBLE_MS,
    );
    expect(shownOutput(later.lines[0])).toBeUndefined();
  });

  test("switching agents does not replay output that already ended", () => {
    // Every row remounts on a view switch, but the period belongs to the call,
    // so coming back to an agent cannot restart output the user watched end.
    let state = heldTranscriptLines([bash("running", "compiling")], empty(), 600);
    state = heldTranscriptLines([bash("ok", "compiling")], state.memory, 600 + MIN_VISIBLE_MS);
    expect(shownOutput(state.lines[0])).toBeUndefined();

    const afterSwitchBack = heldTranscriptLines([bash("ok", "compiling")], state.memory, 60_000);
    expect(shownOutput(afterSwitchBack.lines[0])).toBeUndefined();
    expect(afterSwitchBack.nextDeadline).toBeUndefined();
  });

  test("a resumed transcript shows no live output at all", () => {
    const resumed = heldTranscriptLines([bash("ok", "compiling")], empty(), 60_000);
    expect(shownOutput(resumed.lines[0])).toBeUndefined();
  });

  test("withholding output leaves the canonical line untouched", () => {
    const lines = [bash("ok", "compiling")];
    heldTranscriptLines(lines, empty(), 60_000);
    expect(shownOutput(lines[0])).toBe("compiling");
  });
});

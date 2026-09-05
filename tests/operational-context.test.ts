import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationalContextProjection, OPERATIONAL_OBSERVATION_MAX_CHARS } from "../src/operational-context";
import { MemoryContextProjection } from "../src/memory-context";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (stopReason = "toolUse"): AgentMessage => ({
  role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
  stopReason, timestamp: 2,
} as AgentMessage);
const result: AgentMessage = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };

describe("operational state projection", () => {
  test("full/available transitions append, unchanged requests and retries deduplicate", () => {
    const projection = new OperationalContextProjection("pum.capacity");
    const source = [user("work")];
    const first = projection.project(source, "available limit 1", "window");
    expect(projection.project(structuredClone(source), "available limit 1", "window")).toEqual(first);
    const full = projection.project(source, "full limit 1", "window");
    expect(full.slice(0, first.length)).toEqual(first);
    expect(full.at(-1)).toMatchObject({ customType: "pum.capacity" });
    const available = projection.project(source, "available limit 1", "window");
    expect(available.slice(0, full.length)).toEqual(full);
    expect(projection.project(source, "available limit 1", "window")).toEqual(available);
    expect(source).toEqual([user("work")]);
  });

  test("never inserts a changed observation inside an incomplete tool block", () => {
    const projection = new OperationalContextProjection("pum.capacity");
    const source = [user("work")];
    const initial = projection.project(source, "available", "window");
    const incomplete = [...source, assistant()];
    expect(projection.project(incomplete, "full", "window")).toEqual([...initial, assistant()]);
    const complete = projection.project([...incomplete, result], "full", "window");
    expect(complete.at(-2)).toEqual(result);
    expect(complete.at(-1)).toMatchObject({ customType: "pum.capacity" });
    expect(JSON.stringify(complete.at(-1))).toContain("full");
  });

  test("aborted/error requests do not defer revocations forever", () => {
    for (const reason of ["aborted", "error"]) {
      const projection = new OperationalContextProjection("pum.policy");
      projection.project([user("work")], "off", "window");
      const projected = projection.project([user("work"), assistant(reason)], "on", "window");
      expect(JSON.stringify(projected.at(-1))).toContain("on");
    }
  });

  test("rollover, branch replacement and fresh runtime consolidate without summaries", () => {
    const projection = new OperationalContextProjection("pum.capacity");
    const source = [user("work")];
    projection.project(source, "available", "window");
    projection.project(source, "full", "window");
    const fresh = projection.project([user("literal handoff")], "full", "next-window");
    expect(fresh).toHaveLength(2);
    expect(JSON.stringify(fresh)).not.toContain("available");
    expect(JSON.stringify(fresh)).not.toContain("work");
    expect(projection.project([user("branch")], "available", "next-window")).toHaveLength(2);
    projection.reset();
    expect(projection.project(source, "full", "next-window")).toHaveLength(2);
  });

  test("composes append-only with memory before and after operational observations", () => {
    const memory = new MemoryContextProjection();
    const policy = new OperationalContextProjection("pum.policy");
    const capacity = new OperationalContextProjection("pum.capacity");
    const source = [user("work")];
    const snapshot = (revision: string) => ({ revision, content: revision, bytes: 1, lines: 1 });
    const project = (revision: string, state: string) => capacity.project(
      memory.project(policy.project(source, state, "window"), snapshot(revision), "window"), state, "window",
    );
    const first = project("a", "available");
    const second = project("a", "full");
    expect(second.slice(0, first.length)).toEqual(first);
    const third = project("b", "full");
    expect(third.slice(0, second.length)).toEqual(second);
    expect(project("b", "full")).toEqual(third);
  });

  test("rejects oversized observations rather than silently truncating policy", () => {
    const projection = new OperationalContextProjection("pum.policy");
    expect(() => projection.project([], "x".repeat(OPERATIONAL_OBSERVATION_MAX_CHARS + 1), "window")).toThrow("bounded size");
  });
});

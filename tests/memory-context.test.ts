import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MemoryContextProjection } from "../src/memory-context";
import { validateMemoryContent } from "../src/memory";

const user = (content: string, timestamp = 1): AgentMessage => ({ role: "user", content, timestamp });
const memory = validateMemoryContent;
const prefix = (previous: AgentMessage[], next: AgentMessage[]) => expect(next.slice(0, previous.length)).toEqual(previous);

describe("runtime-private memory context projection", () => {
  test("retains a snapshot and appends only changed observations at fixed boundaries", () => {
    const projection = new MemoryContextProjection();
    const source = [user("first")];
    const first = projection.project(source, memory("alpha"), "window");
    const unchanged = projection.project(structuredClone(source), memory("alpha"), "window");
    expect(unchanged).toEqual(first);
    source.push(user("second"));
    const second = projection.project(source, memory("beta"), "window");
    prefix(first, second);
    expect(second.at(-1)).toMatchObject({ role: "custom", timestamp: 0 });
    expect(JSON.stringify(second.at(-1))).toContain("replaces all earlier");
    const retry = projection.project(structuredClone(source), memory("beta"), "window");
    expect(retry).toEqual(second);
    const third = projection.project(source, memory("gamma"), "window");
    prefix(second, third);
    source.push(user("third"));
    const fourth = projection.project(source, memory("gamma"), "window");
    prefix(third, fourth);
    expect(fourth.at(-1)).toEqual(source.at(-1));
    expect(source).toEqual([user("first"), user("second"), user("third")]);
  });

  test("empty, creation, deletion, unavailable and recovery are distinct append-only observations", () => {
    const projection = new MemoryContextProjection();
    const source = [user("first")];
    let previous: AgentMessage[] = [];
    for (const observation of [memory(""), memory("created"), memory(""), undefined, undefined, memory("recovered")]) {
      const next = projection.project(source, observation, "window");
      prefix(previous, next);
      expect(projection.project(source, observation, "window")).toEqual(next);
      previous = next;
    }
    expect(previous.filter((entry) => entry.role === "custom")).toHaveLength(5);
    expect(JSON.stringify(previous)).toContain("No earlier project memory facts remain current");
    expect(JSON.stringify(previous)).toContain("Earlier memory is not authoritative");
  });

  test("does not split a multi-tool call/result block, even across incomplete requests", () => {
    const projection = new MemoryContextProjection();
    const source: AgentMessage[] = [user("first")];
    const initial = projection.project(source, memory("alpha"), "window");
    source.push({ role: "assistant", content: [
      { type: "toolCall", id: "a", name: "read", arguments: {} },
      { type: "toolCall", id: "b", name: "read", arguments: {} },
    ], timestamp: 2 } as AgentMessage);
    source.push({ role: "toolResult", toolCallId: "b", toolName: "read", content: [], isError: false, timestamp: 3 });
    const incomplete = projection.project(source, memory("beta"), "window");
    prefix(initial, incomplete);
    expect(incomplete.filter((entry) => entry.role === "custom")).toHaveLength(1);
    source.push({ role: "toolResult", toolCallId: "a", toolName: "read", content: [], isError: false, timestamp: 4 });
    const complete = projection.project(source, memory("latest"), "window");
    prefix(incomplete, complete);
    expect(complete.slice(2, 5).map((entry) => entry.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(JSON.stringify(complete.at(-1))).toContain("latest");
    expect(JSON.stringify(complete)).not.toContain("beta");
  });

  test("aborted partial calls and earlier orphaned blocks do not suppress later updates", () => {
    for (const stopReason of ["aborted", "error", "toolUse"] as const) {
      const projection = new MemoryContextProjection();
      const source = [user("first")];
      projection.project(source, memory("alpha"), "window");
      source.push({ role: "assistant", content: [{ type: "toolCall", id: "partial", name: "read", arguments: {} }],
        stopReason, timestamp: 2 } as AgentMessage);
      // An older orphan is already interrupted by this source user message.
      // pi repairs that old block; memory must not create or move tool results.
      if (stopReason === "toolUse") source.push(user("continue"));
      const next = projection.project(source, memory("beta"), "window");
      expect(next.filter((entry) => entry.role === "custom")).toHaveLength(2);
      expect(JSON.stringify(next.at(-1))).toContain("beta");
      expect(next.filter((entry) => entry.role === "toolResult")).toHaveLength(0);
    }
  });

  test("window changes and non-append branch changes consolidate deliberately", () => {
    const projection = new MemoryContextProjection();
    const source = [user("first")];
    projection.project(source, memory("alpha"), "one");
    projection.project(source, memory("beta"), "one");
    const fresh = projection.project(source, memory("gamma"), "two");
    expect(fresh).toHaveLength(2);
    expect(JSON.stringify(fresh)).not.toContain("alpha");
    expect(JSON.stringify(fresh)).not.toContain("beta");
    projection.project(source, memory("delta"), "two");
    const branch = projection.project([user("different branch")], memory("epsilon"), "two");
    expect(branch).toHaveLength(2);
    expect(JSON.stringify(branch)).not.toContain("delta");
    projection.reset();
    expect(projection.project(source, undefined, "two")).toHaveLength(2);
  });

  test("timestamp-only changes do not replace the memory projection", () => {
    const projection = new MemoryContextProjection();
    projection.project([user("same", 1)], memory("alpha"), "window");
    const changed = projection.project([user("same", 2)], memory("beta"), "window");
    expect(changed).toHaveLength(3);
    expect(JSON.stringify(changed[0])).toContain("alpha");
    expect(changed.filter((entry) => entry.role === "custom").every((entry) => entry.timestamp === 0)).toBe(true);
  });
});

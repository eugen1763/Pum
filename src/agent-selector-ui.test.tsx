import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { AgentSelectorPopup, type AgentTreeRow } from "./agent-selector";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

async function renderSelector(width: number, rows: AgentTreeRow[], cursor: number) {
  const setup = await createTestRenderer({ width, height: 18 });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <AgentSelectorPopup
      theme={loadTheme("tokyonight")}
      cursor={cursor}
      rows={rows}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

const metadata = (
  branch: string,
  outgoingTokens: number,
  incomingTokens: number,
  cacheReadTokens: number,
  cost: number,
  contextPct: number | null,
) => ({ branch, outgoingTokens, incomingTokens, cacheReadTokens, cost, contextPct });

describe("agent selector layout", () => {
  test("shows distinct metadata from each subagent snapshot", async () => {
    const frame = await renderSelector(160, [
      { id: null, name: "main", depth: 0 },
      {
        id: "first",
        name: "first-worker",
        status: "idle",
        depth: 1,
        metadata: metadata("pum/first", 1200, 45, 0, 0.125, 80),
      },
      {
        id: "second",
        name: "second-worker",
        status: "completed",
        depth: 1,
        metadata: metadata("topic/second", 8, 900, 2400, 2.5, 20),
      },
    ], 0);

    const firstLine = frame.split("\n").find((line) => line.includes("first-worker"))!;
    const secondLine = frame.split("\n").find((line) => line.includes("second-worker"))!;
    expect(firstLine).toContain("pum/first · ↑ 1.2k · ↓ 45 · $0.125 · 80%");
    expect(secondLine).toContain("topic/second · ↑ 8 · ↓ 900 · ↺ 2.4k · $2.50 · 20%");
    expect(firstLine).not.toContain("topic/second");
    expect(secondLine).not.toContain("pum/first");
  });

  test("preserves nested indentation and keeps highlighted metadata on one row", async () => {
    const frame = await renderSelector(160, [
      { id: null, name: "main", depth: 0 },
      {
        id: "parent",
        name: "parent-worker",
        status: "idle",
        depth: 1,
        metadata: metadata("pum/parent", 10, 20, 30, 0.01, 25),
      },
      {
        id: "child",
        name: "child-worker",
        status: "running",
        depth: 2,
        metadata: metadata("pum/child", 4000, 500, 6000, 1.25, 90),
      },
    ], 2);

    const lines = frame.split("\n");
    const parentLine = lines.find((line) => line.includes("parent-worker"))!;
    const childLine = lines.find((line) => line.includes("child-worker"))!;
    expect(childLine.indexOf("child-worker") - parentLine.indexOf("parent-worker")).toBe(2);
    expect(childLine).toContain("›");
    expect(childLine).toContain("pum/child · ↑ 4.0k · ↓ 500 · ↺ 6.0k · $1.25 · 90%");
    expect(lines.filter((line) => line.includes("child-worker"))).toHaveLength(1);
  });

  test("clips a deep long label before metadata without overflow or wrapping", async () => {
    const frame = await renderSelector(24, [
      { id: null, name: "main", depth: 0 },
      {
        id: "deep",
        name: "very-long-agent-label-suffix",
        status: "running",
        depth: 6,
        metadata: metadata("pum/deep", 1200, 345, 2400, 0.25, 88),
      },
    ], 1);
    const lines = frame.split("\n");
    const selectedLine = lines.find((line) => line.includes("very-"))!;

    expect(selectedLine).toContain("›");
    expect(selectedLine).not.toContain("suffix");
    expect(selectedLine).not.toMatch(/[↑↓↺$%]/);
    expect(lines.filter((line) => line.includes("very-")).length).toBe(1);
    expect(lines.every((line) => line.length <= 24)).toBe(true);
  });
});

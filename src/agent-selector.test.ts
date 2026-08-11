import { describe, expect, test } from "bun:test";
import {
  agentSelectorRowLayout,
  buildAgentTree,
  moveAgentSelection,
} from "./agent-selector";
import type { SubagentSnapshot } from "./subagents/types";

function agent(id: string, parentAgentId: string | null, startedAt: number): SubagentSnapshot {
  return {
    id,
    name: id,
    task: id,
    status: "idle",
    worktree: {
      name: id,
      path: `/tmp/${id}`,
      branch: `pum/${id}`,
      baseBranch: "main",
      baseCommit: "abc",
    },
    parentAgentId,
    modelId: "mock/model",
    thinkingLevel: "off",
    transcript: { lines: [], stream: null, pending: [] },
    startedAt,
    updatedAt: startedAt,
    usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
  };
}

describe("agent selector tree", () => {
  test("places children below their spawner in creation order", () => {
    const rows = buildAgentTree([
      agent("peer", null, 2),
      agent("grandchild", "child", 4),
      agent("child", "parent", 3),
      agent("parent", null, 1),
    ]);

    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      [null, 0],
      ["parent", 1],
      ["child", 2],
      ["grandchild", 3],
      ["peer", 1],
    ]);
  });

  test("uses each snapshot's branch and usage", () => {
    const first = agent("first", null, 1);
    first.usage = { outgoing: 1200, incoming: 45, cacheRead: 0, cost: 0.125, contextPct: 80 };
    const second = agent("second", null, 2);
    second.worktree.branch = "topic/second";
    second.usage = { outgoing: 8, incoming: 900, cacheRead: 2400, cost: 2.5, contextPct: 20 };

    const rows = buildAgentTree([first, second]);
    expect(rows[1]?.metadata).toEqual({
      branch: "pum/first",
      outgoingTokens: 1200,
      incomingTokens: 45,
      cacheReadTokens: 0,
      cost: 0.125,
      contextPct: 80,
    });
    expect(rows[2]?.metadata).toEqual({
      branch: "topic/second",
      outgoingTokens: 8,
      incomingTokens: 900,
      cacheReadTokens: 2400,
      cost: 2.5,
      contextPct: 20,
    });
  });

  test("marks readonly children in selector labels", () => {
    const readonly = agent("reviewer", null, 1);
    readonly.readonly = true;
    const layout = agentSelectorRowLayout(buildAgentTree([readonly])[1]!, 80);
    expect(layout.label).toBe("reviewer · readonly · idle");
  });

  test("normalizes legacy usage and omits zero values from row metadata", () => {
    const legacy = agent("legacy", null, 1);
    legacy.usage = { tokens: 700, cost: 0.2, contextPct: 35 } as any;
    const row = buildAgentTree([legacy])[1]!;
    const layout = agentSelectorRowLayout(row, 80);

    expect(row.metadata).toEqual({
      branch: "pum/legacy",
      outgoingTokens: 700,
      incomingTokens: 0,
      cacheReadTokens: 0,
      cost: 0.2,
      contextPct: 35,
    });
    expect(layout.metadata.map((item) => item.key)).toEqual([
      "branch",
      "outgoing",
      "cost",
      "context",
    ]);
  });

  test("preserves label space and progressively removes metadata", () => {
    const row = buildAgentTree([agent("nested-worker", null, 1)])[1]!;
    row.metadata = {
      branch: "pum/nested-worker",
      outgoingTokens: 1200,
      incomingTokens: 345,
      cacheReadTokens: 2400,
      cost: 0.25,
      contextPct: 88,
    };

    const wide = agentSelectorRowLayout(row, 100);
    const medium = agentSelectorRowLayout(row, 45);
    const narrow = agentSelectorRowLayout(row, 18);

    expect(wide.metadata.length).toBeGreaterThan(medium.metadata.length);
    expect(medium.metadata.length).toBeGreaterThan(narrow.metadata.length);
    expect(narrow.metadata.map((item) => item.key)).toEqual(["context"]);
    expect(narrow.labelWidth).toBeGreaterThan(0);
  });

  test("wraps navigation at both ends", () => {
    expect(moveAgentSelection(0, 4, -1)).toBe(3);
    expect(moveAgentSelection(3, 4, 1)).toBe(0);
  });
});

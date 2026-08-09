import { describe, expect, test } from "bun:test";
import { buildAgentTree, moveAgentSelection } from "./agent-selector";
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
    usage: { tokens: 0, cost: 0, contextPct: null },
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

  test("wraps navigation at both ends", () => {
    expect(moveAgentSelection(0, 4, -1)).toBe(3);
    expect(moveAgentSelection(3, 4, 1)).toBe(0);
  });
});

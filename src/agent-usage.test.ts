import { describe, expect, test } from "bun:test";
import { addTurnUsage, emptyAgentUsage, usageFromEntries } from "./agent-usage";

describe("per-agent usage", () => {
  test("accumulates tokens and cost while keeping the latest context percentage", () => {
    const first = addTurnUsage(emptyAgentUsage(), {
      input: 200,
      cacheRead: 100,
      totalTokens: 350,
      cost: { total: 0.1 },
    }, 1_000);
    const second = addTurnUsage(first, {
      input: 600,
      cacheRead: 200,
      totalTokens: 900,
      cost: { total: 0.3 },
    }, 1_000);

    expect(second).toEqual({ tokens: 1250, cost: 0.4, contextPct: 80 });
  });

  test("restores usage from persisted assistant entries", () => {
    expect(usageFromEntries([
      { type: "message", message: { role: "assistant", usage: {
        input: 400,
        cacheRead: 100,
        totalTokens: 550,
        cost: { total: 0.2 },
      } } },
      { type: "message", message: { role: "user" } },
    ], 1_000)).toEqual({ tokens: 550, cost: 0.2, contextPct: 50 });
  });
});

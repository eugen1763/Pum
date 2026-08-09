import { describe, expect, test } from "bun:test";
import {
  addTurnUsage,
  emptyAgentUsage,
  normalizeAgentUsage,
  usageFromEntries,
} from "./agent-usage";

describe("per-agent usage", () => {
  test("accumulates outgoing, incoming, cache-read, cost, and latest context", () => {
    const first = addTurnUsage(emptyAgentUsage(), {
      input: 200,
      output: 50,
      cacheRead: 100,
      cacheWrite: 25,
      cost: { total: 0.1 },
    }, 1_000);
    const second = addTurnUsage(first, {
      input: 600,
      output: 100,
      cacheRead: 200,
      cacheWrite: 50,
      cost: { total: 0.3 },
    }, 1_000);

    expect(second).toEqual({
      outgoing: 875,
      incoming: 150,
      cacheRead: 300,
      cost: 0.4,
      contextPct: 85,
    });
  });

  test("restores usage from persisted assistant and summary entries", () => {
    expect(usageFromEntries([
      { type: "message", message: { role: "assistant", usage: {
        input: 400,
        output: 50,
        cacheRead: 100,
        cacheWrite: 25,
        cost: { total: 0.2 },
      } } },
      { type: "compaction", usage: {
        input: 20,
        output: 10,
        cacheRead: 5,
        cacheWrite: 0,
        cost: { total: 0.01 },
      } },
      { type: "message", message: { role: "user" } },
    ], 1_000)).toEqual({
      outgoing: 445,
      incoming: 60,
      cacheRead: 105,
      cost: 0.21000000000000002,
      contextPct: 3,
    });
  });

  test("migrates a retained total-token record", () => {
    expect(normalizeAgentUsage({
      tokens: 700,
      cost: 0.2,
      contextPct: 35,
    })).toEqual({
      outgoing: 700,
      incoming: 0,
      cacheRead: 0,
      cost: 0.2,
      contextPct: 35,
    });
  });
});

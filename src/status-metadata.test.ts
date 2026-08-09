import { describe, expect, test } from "bun:test";
import {
  fitStatusMetadata,
  statusMetadataItems,
  statusMetadataWidth,
} from "./status-metadata";

const values = {
  branch: "pum/worker",
  outgoingTokens: 1200,
  incomingTokens: 345,
  cacheReadTokens: 2400,
  cost: 0.25,
  contextPct: 88,
};

describe("status metadata formatting", () => {
  test("matches StatusBar compact values and marks warning context", () => {
    const items = statusMetadataItems(values);
    expect(items.map((item) => item.text)).toEqual([
      "pum/worker",
      "↑ 1.2k",
      "↓ 345",
      "↺ 2.4k",
      "$0.250",
      "88%",
    ]);
    expect(items.at(-1)?.tone).toBe("warn");
  });

  test("omits zero metrics but preserves a zero context percentage", () => {
    const items = statusMetadataItems({
      branch: null,
      outgoingTokens: 0,
      incomingTokens: 0,
      cacheReadTokens: 0,
      cost: 0,
      contextPct: 0,
    });
    expect(items.map((item) => item.text)).toEqual(["0%"]);
    expect(items[0]?.tone).toBe("dim");
  });

  test("fits high-priority values without changing display order", () => {
    const items = statusMetadataItems(values);
    const fitted = fitStatusMetadata(items, 24);
    expect(statusMetadataWidth(fitted)).toBeLessThanOrEqual(24);
    expect(fitted.map((item) => item.key)).toEqual(["branch", "incoming", "context"]);
  });
});

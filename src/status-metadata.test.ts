import { describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import {
  fitStatusMetadata,
  formatWorkingDirectory,
  statusMetadataChunks,
  statusMetadataItems,
  statusMetadataWidth,
} from "./status-metadata";
import { loadTheme } from "./theme";

const values = {
  cwd: "/repo/worker",
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
      "worker",
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
    const fitted = fitStatusMetadata(items, 30);
    expect(statusMetadataWidth(fitted)).toBeLessThanOrEqual(30);
    expect(fitted.map((item) => item.key)).toEqual(["cwd", "branch", "context"]);
  });

  test("formats POSIX, Windows, root, and Unicode working directories", () => {
    expect(formatWorkingDirectory("/repo/feature")).toBe("feature");
    expect(formatWorkingDirectory("C:\\dev\\Pum\\")).toBe("Pum");
    expect(formatWorkingDirectory("C:\\")).toBe("C:\\");
    expect(formatWorkingDirectory("/")).toBe("/");
    expect(formatWorkingDirectory("C:\\开发\\界面")).toBe("界面");
  });

  test("uses the semantic cwd color token", () => {
    const theme = loadTheme("tokyonight");
    const chunks = statusMetadataChunks(statusMetadataItems(values), theme);
    expect(chunks[0]?.text).toBe("worker");
    expect(chunks[0]!.fg!.equals(parseColor(theme.statusCwd))).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatLatestUserTime,
  formatSessionBytes,
  knownTokensFromUsage,
  SessionHistoryIndex,
  sortSessionHistory,
  sweepOrphanedCompanions,
  type SessionHistoryItem,
} from "./session-history-metadata";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pum-session-history-"));
  roots.push(root);
  return root;
}

function info(path: string, created = "2026-08-08T00:00:00.000Z"): SessionInfo {
  return {
    path,
    id: path,
    cwd: "/fixture/project",
    created: new Date(created),
    modified: new Date(created),
    messageCount: 0,
    firstMessage: "Fixture session",
    allMessagesText: "",
  };
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe("session history metadata", () => {
  test("reads the latest sent user time, file bytes, and all documented usage sites", async () => {
    const root = await tempRoot();
    const path = join(root, "usage.jsonl");
    const content = [
      line({ type: "session", version: 3, id: "fixture", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/fixture/project" }),
      line({ type: "message", timestamp: "2026-08-08T09:00:00.000Z", message: { role: "user", content: "first", timestamp: Date.parse("2026-08-08T10:00:00.000Z") } }),
      line({ type: "message", timestamp: "2026-08-08T11:00:00.000Z", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 5 } } }),
      line({ type: "message", timestamp: "2026-08-08T12:00:00.000Z", message: { role: "toolResult", usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1 } } }),
      line({ type: "compaction", usage: { tokens: 7 } }),
      line({ type: "branch_summary", usage: { totalTokens: 999 } }),
      line({ type: "message", timestamp: "2026-08-09T14:30:00.000Z", message: { role: "user", content: "latest" } }),
      "{partial",
    ].join("\r\n");
    await writeFile(path, content);

    const [item] = await new SessionHistoryIndex().load([info(path)]);

    expect(item!.historyMetadata.latestUserMessageAt?.toISOString()).toBe("2026-08-09T14:30:00.000Z");
    expect(item!.historyMetadata.fileBytes).toBe(Buffer.byteLength(content));
    expect(item!.historyMetadata.tokens).toEqual({
      outgoing: 123,
      incoming: 23,
      cacheRead: 42,
    });
  });

  test("handles corrupt, partial, empty, and missing files without failure", async () => {
    const root = await tempRoot();
    const corrupt = join(root, "corrupt.jsonl");
    const empty = join(root, "empty.jsonl");
    const missing = join(root, "missing.jsonl");
    const corruptContent = "not json\r\n{\"type\":\"message\",\"message\":";
    await writeFile(corrupt, corruptContent);
    await writeFile(empty, "");

    const items = await new SessionHistoryIndex().load([
      info(corrupt),
      info(empty),
      info(missing),
    ]);
    const byPath = new Map(items.map((item) => [item.path, item.historyMetadata]));

    expect(byPath.get(corrupt)).toEqual({
      latestUserMessageAt: null,
      fileBytes: Buffer.byteLength(corruptContent),
      tokens: {},
    });
    expect(byPath.get(empty)).toEqual({ latestUserMessageAt: null, fileBytes: 0, tokens: {} });
    expect(byPath.get(missing)).toEqual({ latestUserMessageAt: null, fileBytes: null, tokens: {} });
  });

  test("handles Windows paths and treats Windows-looking characters opaquely", async () => {
    const root = await tempRoot();
    const path = process.platform === "win32"
      ? join(root, "work", "session.jsonl")
      : join(root, "C:\\work\\session.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      line({ type: "session", id: "windows" }),
      line({ type: "message", timestamp: "2026-08-09T12:00:00.000Z", message: { role: "user" } }),
    ].join("\r\n"));

    const [item] = await new SessionHistoryIndex().load([info(path)]);
    expect(item!.historyMetadata.latestUserMessageAt?.toISOString()).toBe("2026-08-09T12:00:00.000Z");
  });

  test("reuses unchanged metadata and invalidates the cache after an append", async () => {
    const root = await tempRoot();
    const path = join(root, "cached.jsonl");
    await writeFile(path, `${line({ type: "session", id: "cached" })}\n`);
    const index = new SessionHistoryIndex();

    const first = (await index.load([info(path)]))[0]!.historyMetadata;
    const second = (await index.load([info(path)]))[0]!.historyMetadata;
    expect(second).toBe(first);

    await Bun.write(path, `${line({ type: "session", id: "cached" })}\n${line({
      type: "message",
      timestamp: "2026-08-09T13:00:00.000Z",
      message: { role: "user" },
    })}\n`);
    const third = (await index.load([info(path)]))[0]!.historyMetadata;
    expect(third).not.toBe(first);
    expect(third.latestUserMessageAt?.toISOString()).toBe("2026-08-09T13:00:00.000Z");
  });

  test("sorts by latest sent user time and uses created time plus path as the fallback", () => {
    const item = (
      path: string,
      latest: string | null,
      created: string,
    ): SessionHistoryItem => ({
      ...info(path, created),
      historyMetadata: {
        latestUserMessageAt: latest ? new Date(latest) : null,
        fileBytes: 0,
        tokens: {},
      },
    });
    const sorted = sortSessionHistory([
      item("/z", null, "2026-08-07T00:00:00.000Z"),
      item("/old", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"),
      item("/new", "2026-08-09T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
      item("/a", null, "2026-08-07T00:00:00.000Z"),
    ]);
    expect(sorted.map((session) => session.path)).toEqual(["/new", "/old", "/a", "/z"]);
  });

  test("shows only known token fields and keeps the PUM legacy token meaning", () => {
    expect(knownTokensFromUsage({ input: 10, cacheWrite: 2, output: 3, cacheRead: 4 })).toEqual({
      outgoing: 12,
      incoming: 3,
      cacheRead: 4,
    });
    expect(knownTokensFromUsage({ tokens: 70, totalTokens: 90 })).toEqual({ outgoing: 70 });
    expect(knownTokensFromUsage({ totalTokens: 90 })).toEqual({});
    expect(knownTokensFromUsage({ input: -1, output: Number.NaN })).toEqual({});
  });

  test("formats local timestamps and documents compact on-disk bytes", () => {
    expect(formatLatestUserTime(null, "en-US", { timeZone: "UTC" })).toBe("no user message");
    expect(formatLatestUserTime(new Date("2026-08-09T15:04:00.000Z"), "en-US", { timeZone: "UTC" }))
      .toBe("Aug 9, 2026, 3:04 PM");
    expect(formatSessionBytes(null)).toBe("size ?");
    expect(formatSessionBytes(0)).toBe("0 B");
    expect(formatSessionBytes(1536)).toBe("1.5 KiB");
    expect(formatSessionBytes(12 * 1024)).toBe("12 KiB");
  });
});

describe("orphaned session companions", () => {
  test("removes companions of deleted sessions and keeps live ones", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "live.jsonl"), "");
    for (const suffix of [".news.json", ".stats.json", ".tool-groups.json"]) {
      await writeFile(join(root, `live${suffix}`), "{}");
      await writeFile(join(root, `gone${suffix}`), "{}");
    }
    await writeFile(join(root, "notes.json"), "{}");

    const removed = await sweepOrphanedCompanions(root);

    expect(removed.sort()).toEqual(["gone.news.json", "gone.stats.json", "gone.tool-groups.json"]);
    expect((await readdir(root)).sort()).toEqual([
      "live.jsonl",
      "live.news.json",
      "live.stats.json",
      "live.tool-groups.json",
      "notes.json",
    ]);
  });

  test("stays silent when the directory cannot be read", async () => {
    const root = await tempRoot();
    expect(await sweepOrphanedCompanions(join(root, "missing"))).toEqual([]);
  });

  test("sweeps the session directory once while listing sessions", async () => {
    const root = await tempRoot();
    const path = join(root, "live.jsonl");
    await writeFile(path, `${line({ type: "session", id: "live" })}\n`);
    await writeFile(join(root, "live.stats.json"), "{}");
    await writeFile(join(root, "gone.stats.json"), "{}");
    const index = new SessionHistoryIndex();

    await index.load([info(path)]);
    expect((await readdir(root)).sort()).toEqual(["live.jsonl", "live.stats.json"]);

    await writeFile(join(root, "later.news.json"), "{}");
    await index.load([info(path)]);
    expect(await readdir(root)).toContain("later.news.json");
  });
});

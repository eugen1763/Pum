import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  NEWS_CAPACITY,
  formatAge,
  loadNewsItems,
  mergeNewsItems,
  newsFileFor,
  newsItemFromFinishSettlement,
  saveNewsItems,
  tagNewsLines,
  type NewsItem,
} from "../src/news";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pum-news-"));
  temporaryDirectories.push(dir);
  return join(dir, "session-id.jsonl");
}

function item(text: string, partial: Partial<NewsItem> = {}): NewsItem {
  return {
    id: partial.id ?? `id-${text.slice(0, 4)}`,
    text,
    at: partial.at ?? 1_700_000_000_000,
    read: partial.read ?? false,
    answered: partial.answered ?? false,
  };
}

describe("news persistence", () => {
  test("writes no companion file for an empty list", () => {
    const sessionFile = tempSessionFile();
    saveNewsItems(sessionFile, []);
    expect(existsSync(newsFileFor(sessionFile))).toBe(false);
    expect(readdirSync(dirname(sessionFile))).toEqual([]);
    expect(loadNewsItems(sessionFile)).toEqual([]);
  });

  test("still clears an existing companion file", () => {
    const sessionFile = tempSessionFile();
    saveNewsItems(sessionFile, [item("first answer")]);
    saveNewsItems(sessionFile, []);
    expect(existsSync(newsFileFor(sessionFile))).toBe(true);
    expect(loadNewsItems(sessionFile)).toEqual([]);
  });

  test("does not use a fixed temp name another process could be writing", () => {
    const sessionFile = tempSessionFile();
    const fixed = `${newsFileFor(sessionFile)}.tmp`;
    // Stand in for a second PUM process mid-write. A shared temp name would
    // clobber this file and rename a half-written list into place.
    writeFileSync(fixed, "another process is writing here", "utf8");
    saveNewsItems(sessionFile, [item("first answer")]);
    expect(readFileSync(fixed, "utf8")).toBe("another process is writing here");
    expect(loadNewsItems(sessionFile)).toEqual([item("first answer")]);
    expect(readdirSync(dirname(sessionFile)).filter((name) => name.endsWith(".tmp")))
      .toEqual([basename(fixed)]);
  });

  test("round trips through the companion file", () => {
    const sessionFile = tempSessionFile();
    const items = [item("first answer"), item("second answer", { read: true })];
    saveNewsItems(sessionFile, items);
    expect(loadNewsItems(sessionFile)).toEqual(items);
    expect(readFileSync(newsFileFor(sessionFile), "utf8")).toContain("second answer");
  });

  test("caps the stored list at NEWS_CAPACITY", () => {
    const sessionFile = tempSessionFile();
    // The list is newest first, so build it that way.
    const items = Array.from({ length: NEWS_CAPACITY + 5 }, (_, index) =>
      item(`answer ${index}`),
    ).reverse();
    saveNewsItems(sessionFile, items);
    const loaded = loadNewsItems(sessionFile);
    expect(loaded).toHaveLength(NEWS_CAPACITY);
    expect(loaded[0]!.text).toBe("answer 24");
  });

  test("ignores a missing or corrupt file", () => {
    const sessionFile = tempSessionFile();
    expect(loadNewsItems(sessionFile)).toEqual([]);
    writeFileSync(newsFileFor(sessionFile), "not json", "utf8");
    expect(loadNewsItems(sessionFile)).toEqual([]);
  });

  test("skips malformed entries", () => {
    const sessionFile = tempSessionFile();
    saveNewsItems(sessionFile, [item("good")]);
    writeFileSync(
      newsFileFor(sessionFile),
      JSON.stringify([{ id: 1, text: "bad" }, item("good")]),
      "utf8",
    );
    expect(loadNewsItems(sessionFile)).toEqual([item("good")]);
  });

  test("round trips answer prompts through the companion file", () => {
    const sessionFile = tempSessionFile();
    const items = [{
      ...item("answer with prompts"),
      prompts: [
        { text: "first question", steer: false },
        { text: "keep going", steer: true },
      ],
    }];
    saveNewsItems(sessionFile, items);
    expect(loadNewsItems(sessionFile)).toEqual(items);
  });

  test("skips entries with malformed prompts", () => {
    const sessionFile = tempSessionFile();
    saveNewsItems(sessionFile, [item("good")]);
    writeFileSync(
      newsFileFor(sessionFile),
      JSON.stringify([
        { ...item("bad steers"), prompts: [{ text: "missing steer" }] },
        { ...item("bad prompts"), prompts: "nope" },
        item("good"),
      ]),
      "utf8",
    );
    expect(loadNewsItems(sessionFile)).toEqual([item("good")]);
  });

  test("round trips managed completion identity and rejects malformed identity", () => {
    const sessionFile = tempSessionFile();
    const completion = {
      ...item("Requester final response", { id: "subagent-finish:settlement-child:1:completed" }),
      prompts: [{ text: "summary: Child work passed.", steer: false }],
      completion: {
        settlementId: "child:1:completed",
        messageId: "settlement-child:1:completed",
        agentId: "child",
        agentName: "worker",
        requesterAgentId: "parent",
        requesterName: "reviewer",
        summary: "Child work passed.",
      },
    };
    saveNewsItems(sessionFile, [completion]);
    expect(loadNewsItems(sessionFile)).toEqual([completion]);
    writeFileSync(newsFileFor(sessionFile), JSON.stringify([
      { ...completion, completion: { ...completion.completion, requesterAgentId: 42 } },
      completion,
    ]));
    expect(loadNewsItems(sessionFile)).toEqual([completion]);
  });

  test("projects only completed finishes and deduplicates without losing user state", () => {
    const projected = newsItemFromFinishSettlement({
      id: "child:1:completed",
      messageId: "settlement-child:1:completed",
      agentId: "child",
      agentName: "worker",
      parentAgentId: null,
      requesterName: "main",
      status: "completed",
      summary: "Tests passed.",
      content: "Subagent worker completed.\nsummary: Tests passed.",
      createdAt: 200,
      response: "Merged the worker change.",
    });
    expect(projected?.id).toBe("subagent-finish:settlement-child:1:completed");
    expect(projected?.text).toBe("Merged the worker change.");
    expect(projected?.prompts?.[0]?.text).toContain("summary: Tests passed.");
    expect(newsItemFromFinishSettlement({
      id: "child:1:idle",
      messageId: "settlement-child:1:idle",
      agentId: "child",
      agentName: "worker",
      parentAgentId: null,
      requesterName: "main",
      status: "idle",
      content: "idle",
      createdAt: 100,
      response: "Useful response.",
    })).toBeUndefined();
    expect(newsItemFromFinishSettlement({
      id: "child:2:completed",
      messageId: "settlement-child:2:completed",
      agentId: "child",
      agentName: "worker",
      parentAgentId: null,
      requesterName: "main",
      status: "completed",
      content: "completed",
      createdAt: 101,
      response: "Acknowledged.",
    })).toBeUndefined();

    const existing = [{ ...projected!, read: true, answered: true }];
    const merged = mergeNewsItems(existing, [projected!, projected!]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.read).toBe(true);
    expect(merged[0]?.answered).toBe(true);
  });
});

describe("tagNewsLines", () => {
  const line = (kind: string, role: string, text: string) =>
    ({ kind, role, text, newsId: undefined as string | undefined });

  test("tags exact matching assistant lines newest first skipped when claimed", () => {
    const lines = [
      line("text", "user", "question one"),
      line("text", "assistant", "answer one"),
      line("text", "user", "question two"),
      line("text", "assistant", "answer two"),
    ];
    const items = [item("answer two"), item("answer one")];
    const tagged = tagNewsLines(lines, items);
    expect(tagged[1]!.newsId).toBe("id-answ");
    expect(tagged[3]!.newsId).toBe("id-answ");
  });

  test("never tags an already claimed line twice", () => {
    const lines = [
      line("text", "assistant", "same text"),
      line("text", "assistant", "same text"),
    ];
    const items = [item("same text"), item("same text")];
    const tagged = tagNewsLines(lines, items);
    expect(tagged[0]!.newsId).toBe("id-same");
    expect(tagged[1]!.newsId).toBe("id-same");
  });

  test("leaves non-matching and non-assistant lines alone", () => {
    const lines = [
      line("text", "user", "answer one"),
      line("tool", "", "answer one"),
      line("text", "assistant", "something else"),
    ];
    const items = [item("answer one")];
    const tagged = tagNewsLines(lines, items);
    expect(tagged[0]!.newsId).toBeUndefined();
    expect(tagged[1]!.newsId).toBeUndefined();
    expect(tagged[2]!.newsId).toBeUndefined();
  });

  test("is a no-op for an empty list or empty lines", () => {
    expect(tagNewsLines([], [item("x")])).toEqual([]);
    const lines = [line("text", "assistant", "x")];
    expect(tagNewsLines(lines, [])).toEqual(lines);
  });
});

describe("formatAge", () => {
  const now = 1_700_000_000_000;
  test("renders compact relative ages", () => {
    expect(formatAge(now - 10_000, now)).toBe("now");
    expect(formatAge(now - 60_000, now)).toBe("1m ago");
    expect(formatAge(now - 3_600_000, now)).toBe("1h ago");
    expect(formatAge(now - 86_400_000, now)).toBe("1d ago");
  });

  test("never reports a future age as negative", () => {
    expect(formatAge(now + 5_000, now)).toBe("now");
  });
});

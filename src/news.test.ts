import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEWS_CAPACITY,
  formatAge,
  loadNewsItems,
  newsFileFor,
  saveNewsItems,
  tagNewsLines,
  type NewsItem,
} from "./news";

function tempSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pum-news-"));
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

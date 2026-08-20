import { describe, expect, test } from "bun:test";
import { textColumns, wrapAtSpaces } from "../src/text-wrap";

const rows = (text: string, width: number) => wrapAtSpaces(text, width).split("\n");

describe("textColumns", () => {
  test("counts a tab as the two columns OpenTUI paints", () => {
    expect(textColumns("x\ty")).toBe(4);
    expect(textColumns("ab")).toBe(2);
    expect(textColumns("日本")).toBe(4);
  });
});

describe("wrapAtSpaces", () => {
  test("keeps a token with punctuation whole", () => {
    expect(rows("read the auth.json file", 12)).toEqual(["read the", "auth.json", "file"]);
    expect(rows("open src/app.tsx now", 12)).toEqual(["open", "src/app.tsx", "now"]);
    expect(rows("the check-mode flag", 10)).toEqual(["the", "check-mode", "flag"]);
  });

  test("fills every row up to the width", () => {
    expect(rows("aaa bbb ccc ddd", 7)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  test("keeps existing line breaks and leading indentation", () => {
    expect(rows("import (\n\tfoo bar baz\n)", 8)).toEqual(["import (", "\tfoo", "bar baz", ")"]);
  });

  test("splits a word that cannot fit any row", () => {
    expect(rows("aa bbbbbbbb cc", 4)).toEqual(["aa", "bbbb", "bbbb", "cc"]);
  });

  test("returns the text unchanged when the width is unusable", () => {
    expect(wrapAtSpaces("aaa bbb", 0)).toBe("aaa bbb");
    expect(wrapAtSpaces("aaa bbb", -3)).toBe("aaa bbb");
  });

  test("never produces a row wider than the width", () => {
    const text = "Check `src/check-mode.ts`, then auth.json, then the check-approvals.ts helper (twice).";
    for (let width = 6; width <= 40; width++) {
      for (const row of rows(text, width)) expect(textColumns(row)).toBeLessThanOrEqual(width);
    }
  });

  test("loses no word once every token fits a row", () => {
    const text = "Read src/app.tsx and auth.json, then run bun test (all of it).";
    for (let width = 12; width <= 40; width++) {
      expect(wrapAtSpaces(text, width).split(/\s+/).filter(Boolean))
        .toEqual(text.split(/\s+/).filter(Boolean));
    }
  });
});

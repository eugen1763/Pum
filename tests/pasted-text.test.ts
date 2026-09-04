import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expandPastedTexts, MAX_PASTED_TEXT_BYTES, MAX_PASTED_TEXT_LINES, shouldStagePastedText, stagePastedText } from "../src/pasted-text";

function item(id: number, text: string, start = 0) {
  const marker = `[Pasted text #${id}]`;
  return { id, marker, start, end: start + marker.length, ...stagePastedText(text) };
}

describe("in-memory pasted text", () => {
  test("keeps exact text and byte size without creating temp files", () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("pum-pasted-text-"));
    const text = "é".repeat(20_000);
    expect(stagePastedText(text)).toEqual({ text, bytes: 40_000 });
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("pum-pasted-text-"))).toEqual(before);
  });

  test("expands original spans once with literal payloads", () => {
    const first = item(1, "  $& $` $' $$ [Pasted text #2] [Image #1]\n");
    const second = item(2, "second", first.end + 1);
    expect(expandPastedTexts(`${first.marker} ${second.marker}`, [second, first]))
      .toBe(`${first.text} second`);
  });

  test("does not replace an untracked matching spelling", () => {
    const literal = "[Pasted text #1] ";
    const paste = item(1, "payload", literal.length);
    expect(expandPastedTexts(literal + paste.marker, [paste])).toBe(literal + "payload");
  });

  test("ignores missing or edited marker spans", () => {
    expect(expandPastedTexts("edited draft", [item(1, "payload")])).toBe("edited draft");
  });
});

describe("threshold", () => {
  test("keeps the existing 16 KiB byte limit", () => {
    expect(MAX_PASTED_TEXT_BYTES).toBe(16 * 1024);
    expect(shouldStagePastedText("x".repeat(MAX_PASTED_TEXT_BYTES))).toBe(false);
    expect(shouldStagePastedText("x".repeat(MAX_PASTED_TEXT_BYTES + 1))).toBe(true);
    expect(shouldStagePastedText("é".repeat(MAX_PASTED_TEXT_BYTES / 2 + 1))).toBe(true);
  });
  test("stages a paste after three logical lines", () => {
    expect(MAX_PASTED_TEXT_LINES).toBe(3);
    expect(shouldStagePastedText("one\ntwo\nthree")).toBe(false);
    expect(shouldStagePastedText("one\ntwo\nthree\nfour")).toBe(true);
  });
  test("counts CRLF and bare carriage returns as one line break each", () => {
    expect(shouldStagePastedText("one\r\ntwo\r\nthree")).toBe(false);
    expect(shouldStagePastedText("one\rtwo\rthree\rfour")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildToolDetailModel,
  TOOL_DETAIL_MAX_LINE_CHARACTERS,
  TOOL_DETAIL_MAX_ROWS,
  TOOL_DETAIL_MAX_SECTION_ROWS,
  TOOL_DETAIL_MAX_TEXT_LINES,
  toolResultText,
} from "./tool-detail-model";

describe("structured tool detail model", () => {
  test("formats object fields, nested fields, and list rows", () => {
    const model = buildToolDetailModel("read", {
      path: "src/app.tsx",
      offset: 12,
      tags: ["source", "ui"],
      options: { encoding: "utf8" },
    }, undefined);

    expect(model.tool).toBe("read");
    expect(model.sections).toEqual([{
      title: "input",
      tone: "normal",
      rows: [
        { kind: "field", key: "path", value: "src/app.tsx" },
        { kind: "field", key: "offset", value: "12" },
        { kind: "list", key: "tags", index: 0, value: "source" },
        { kind: "list", key: "tags", index: 1, value: "ui" },
        { kind: "field", key: "options.encoding", value: "utf8" },
      ],
      hiddenRows: 0,
    }]);
  });

  test("uses scalar and root list rows without synthetic object keys", () => {
    expect(buildToolDetailModel("one", true, undefined).sections[0]!.rows)
      .toEqual([{ kind: "value", value: "true" }]);
    expect(buildToolDetailModel("many", ["a", 2], undefined).sections[0]!.rows)
      .toEqual([
        { kind: "list", index: 0, value: "a" },
        { kind: "list", index: 1, value: "2" },
      ]);
  });

  test("extracts text blocks from common pi results and retains details", () => {
    const result = {
      content: [
        { type: "text", text: "first\nsecond" },
        { type: "image", data: "ignored" },
        { type: "text", text: "third" },
      ],
      details: { count: 3, route: "main" },
    };

    expect(toolResultText(result)).toBe("first\nsecond\nthird");
    expect(buildToolDetailModel("message_cache_send", {}, result).sections[1]).toEqual({
      title: "result",
      tone: "muted",
      rows: [
        {
          kind: "text",
          key: "output",
          lines: ["first", "second", "third"],
          hiddenLines: 0,
        },
        { kind: "field", key: "details.count", value: "3" },
        { kind: "field", key: "details.route", value: "main" },
      ],
      hiddenRows: 0,
    });
  });

  test("marks a failed result as an error section", () => {
    const section = buildToolDetailModel("bash", { command: "false" }, {
      content: [{ type: "text", text: "Command exited with code 1" }],
    }, true).sections[1];

    expect(section?.title).toBe("error");
    expect(section?.tone).toBe("error");
  });

  test("bounds multiline blocks by lines and line characters", () => {
    const text = ["x".repeat(300), ...Array.from({ length: 19 }, (_, index) => `line ${index + 2}`)]
      .join("\n");
    const row = buildToolDetailModel("bash", undefined, {
      content: [{ type: "text", text }],
    }).sections[0]!.rows[0];

    expect(row?.kind).toBe("text");
    if (row?.kind !== "text") throw new Error("expected text row");
    expect(row.lines).toHaveLength(TOOL_DETAIL_MAX_TEXT_LINES);
    expect(row.lines[0]).toHaveLength(TOOL_DETAIL_MAX_LINE_CHARACTERS);
    expect(row.lines[0]?.endsWith("…")).toBe(true);
    expect(row.hiddenLines).toBe(4);
  });

  test("bounds section rows and the total row budget", () => {
    const input = Array.from({ length: 50 }, (_, index) => `item-${index}`);
    const result = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, index]));
    const model = buildToolDetailModel("large", input, result);

    expect(model.sections[0]?.rows).toHaveLength(TOOL_DETAIL_MAX_SECTION_ROWS);
    expect(model.sections[0]?.hiddenRows).toBe(30);
    expect(model.sections[1]?.rows).toHaveLength(TOOL_DETAIL_MAX_ROWS - TOOL_DETAIL_MAX_SECTION_ROWS);
    expect(model.sections[1]?.hiddenRows).toBe(8);
    expect(model.sections.reduce((count, section) => count + section.rows.length, 0))
      .toBe(TOOL_DETAIL_MAX_ROWS);
    expect(model.hiddenRows).toBe(38);
  });

  test("summarizes nested collection values without serializing full data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rows = buildToolDetailModel("nested", {
      items: [{ id: 1, payload: "large" }],
      deep: { one: { circular } },
    }, undefined).sections[0]!.rows;

    expect(rows).toContainEqual({ kind: "list", key: "items", index: 0, value: "{2 fields}" });
    expect(rows).toContainEqual({ kind: "field", key: "deep.one", value: "{1 field}" });
  });

  test("provides a concise fallback when no canonical data exists", () => {
    expect(buildToolDetailModel("unknown", undefined, undefined)).toEqual({
      tool: "unknown",
      sections: [{
        title: "details",
        tone: "muted",
        rows: [{ kind: "value", value: "No retained details." }],
        hiddenRows: 0,
      }],
      hiddenRows: 0,
    });
  });
});

export const TOOL_DETAIL_MAX_SECTIONS = 2;
export const TOOL_DETAIL_MAX_ROWS = 32;
export const TOOL_DETAIL_MAX_SECTION_ROWS = 20;
export const TOOL_DETAIL_MAX_TEXT_LINES = 16;
export const TOOL_DETAIL_MAX_LINE_CHARACTERS = 240;
export const TOOL_DETAIL_MAX_VALUE_CHARACTERS = 320;
const TOOL_DETAIL_MAX_DEPTH = 2;

export type ToolDetailTone = "normal" | "muted" | "error";

export type ToolDetailRow =
  | { kind: "field"; key: string; value: string }
  | { kind: "list"; key?: string; index: number; value: string }
  | { kind: "value"; value: string }
  | {
    kind: "text";
    key?: string;
    lines: string[];
    hiddenLines: number;
  };

export type ToolDetailSection = {
  title: "input" | "result" | "error" | "details";
  tone: ToolDetailTone;
  rows: ToolDetailRow[];
  hiddenRows: number;
};

export type ToolDetailModel = {
  tool: string;
  sections: ToolDetailSection[];
  hiddenRows: number;
};

type RowBudget = {
  remaining: number;
  hidden: number;
};

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeLines(value: string): string[] {
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return clip(value.replaceAll(/\s+/g, " ").trim(), TOOL_DETAIL_MAX_VALUE_CHARACTERS);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "symbol") return value.description ? `Symbol(${value.description})` : "Symbol";
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return `{${count} field${count === 1 ? "" : "s"}}`;
  }
  return clip(String(value), TOOL_DETAIL_MAX_VALUE_CHARACTERS);
}

function addRow(rows: ToolDetailRow[], row: ToolDetailRow, budget: RowBudget): void {
  if (rows.length >= TOOL_DETAIL_MAX_SECTION_ROWS || budget.remaining <= 0) {
    budget.hidden++;
    return;
  }
  rows.push(row);
  budget.remaining--;
}

function textRow(value: string, key?: string): ToolDetailRow {
  const lines = normalizeLines(value);
  const visible = lines.slice(0, TOOL_DETAIL_MAX_TEXT_LINES)
    .map((line) => clip(line, TOOL_DETAIL_MAX_LINE_CHARACTERS));
  return {
    kind: "text",
    ...(key ? { key } : {}),
    lines: visible,
    hiddenLines: Math.max(0, lines.length - visible.length),
  };
}

function appendValue(
  rows: ToolDetailRow[],
  value: unknown,
  budget: RowBudget,
  key?: string,
  depth = 0,
): void {
  if (typeof value === "string" && value.includes("\n")) {
    addRow(rows, textRow(value, key), budget);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      addRow(rows, key ? { kind: "field", key, value: "[]" } : { kind: "value", value: "[]" }, budget);
      return;
    }
    for (let index = 0; index < value.length; index++) {
      if (rows.length >= TOOL_DETAIL_MAX_SECTION_ROWS || budget.remaining <= 0) {
        budget.hidden += value.length - index;
        break;
      }
      addRow(rows, {
        kind: "list",
        ...(key ? { key } : {}),
        index,
        value: scalarText(value[index]),
      }, budget);
    }
    return;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      addRow(rows, key ? { kind: "field", key, value: "{}" } : { kind: "value", value: "{}" }, budget);
      return;
    }
    if (depth >= TOOL_DETAIL_MAX_DEPTH) {
      addRow(rows, key
        ? { kind: "field", key, value: scalarText(value) }
        : { kind: "value", value: scalarText(value) }, budget);
      return;
    }
    for (let index = 0; index < entries.length; index++) {
      if (rows.length >= TOOL_DETAIL_MAX_SECTION_ROWS || budget.remaining <= 0) {
        budget.hidden += entries.length - index;
        break;
      }
      const [childKey, child] = entries[index]!;
      appendValue(rows, child, budget, key ? `${key}.${childKey}` : childKey, depth + 1);
    }
    return;
  }

  addRow(rows, key
    ? { kind: "field", key, value: scalarText(value) }
    : { kind: "value", value: scalarText(value) }, budget);
}

/** Extract the visible text blocks from a common pi tool result. */
export function toolResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const text = result.content
    .filter((block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return text || undefined;
}

function buildSection(
  title: ToolDetailSection["title"],
  tone: ToolDetailTone,
  value: unknown,
  budget: RowBudget,
  resultText?: string,
): ToolDetailSection {
  const rows: ToolDetailRow[] = [];
  const hiddenBefore = budget.hidden;

  if (resultText !== undefined) {
    addRow(rows, textRow(resultText, "output"), budget);
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key !== "content") appendValue(rows, child, budget, key);
      }
    }
  } else {
    appendValue(rows, value, budget);
  }

  return {
    title,
    tone,
    rows,
    hiddenRows: budget.hidden - hiddenBefore,
  };
}

/**
 * Build bounded display data for expanded regular-mode tool details.
 *
 * The caller keeps the canonical input and result for complete clipboard copy.
 * This model is display-only and can safely omit excess rows and text lines.
 */
export function buildToolDetailModel(
  tool: string,
  input: unknown,
  result: unknown,
  isError = false,
): ToolDetailModel {
  const budget: RowBudget = { remaining: TOOL_DETAIL_MAX_ROWS, hidden: 0 };
  const sections: ToolDetailSection[] = [];

  if (input !== undefined && sections.length < TOOL_DETAIL_MAX_SECTIONS) {
    sections.push(buildSection("input", "normal", input, budget));
  }
  if (result !== undefined && sections.length < TOOL_DETAIL_MAX_SECTIONS) {
    sections.push(buildSection(
      isError ? "error" : "result",
      isError ? "error" : "muted",
      result,
      budget,
      toolResultText(result),
    ));
  }
  if (sections.length === 0) {
    sections.push(buildSection("details", isError ? "error" : "muted", "No retained details.", budget));
  }

  return { tool, sections, hiddenRows: budget.hidden };
}

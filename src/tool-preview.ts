import { extname } from "node:path";
import { bashOutput } from "./tool-line";

export const DETAILED_BASH_LINE_LIMIT = 5;
export const DETAILED_WRITE_LINE_LIMIT = 30;

export type PreviewLanguage = "javascript" | "typescript" | "markdown" | "zig";

export type PreviewWindow = {
  lines: string[];
  hidden: number;
};

export type DiffPreviewLine = {
  kind: "add" | "remove" | "context" | "header";
  text: string;
  source: string;
  language?: PreviewLanguage;
};

export type ToolResultPreview =
  | { kind: "bash"; window: PreviewWindow }
  | { kind: "write"; path: string; language?: PreviewLanguage; window: PreviewWindow }
  | { kind: "diff"; lines: DiffPreviewLine[] };

function logicalLines(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function previewWindow(
  text: string,
  limit: number,
  edge: "start" | "end",
): PreviewWindow {
  const lines = logicalLines(text);
  const visible = Math.max(0, limit);
  return {
    lines: visible === 0
      ? []
      : edge === "start"
        ? lines.slice(0, visible)
        : lines.slice(-visible),
    hidden: Math.max(0, lines.length - visible),
  };
}

/** Return a bundled tree-sitter parser name for a source path. */
export function previewLanguage(path: string): PreviewLanguage | undefined {
  switch (extname(path).toLowerCase()) {
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".zig":
      return "zig";
    default:
      return undefined;
  }
}

function diffPath(line: string): string | undefined {
  const codex = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
  if (codex) return codex[1]!.trim();
  const moved = line.match(/^\*\*\* Move to: (.+)$/);
  if (moved) return moved[1]!.trim();
  const unified = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
  if (unified && unified[1] !== "/dev/null") return unified[1]!.trim();
  const git = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
  return git?.[2]?.trim();
}

/** Parse every patch line without truncation. */
export function diffPreview(patch: string): ToolResultPreview {
  let language: PreviewLanguage | undefined;
  const lines = logicalLines(patch).map((text): DiffPreviewLine => {
    const path = diffPath(text);
    if (path) language = previewLanguage(path);
    if (text.startsWith("+") && !text.startsWith("+++")) {
      return { kind: "add", text, source: text.slice(1), language };
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      return { kind: "remove", text, source: text.slice(1), language };
    }
    if (text.startsWith(" ")) {
      return { kind: "context", text, source: text.slice(1), language };
    }
    return { kind: "header", text, source: text, language };
  });
  return { kind: "diff", lines };
}

/** Capture input-backed previews without changing tool execution data. */
export function toolPreviewFromStart(name: string, args: unknown): ToolResultPreview | undefined {
  if (name !== "write" || !args || typeof args !== "object") return undefined;
  const input = args as { path?: unknown; content?: unknown };
  if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
  return {
    kind: "write",
    path: input.path,
    language: previewLanguage(input.path),
    window: previewWindow(input.content, DETAILED_WRITE_LINE_LIMIT, "start"),
  };
}

/** Capture final result previews without changing the result sent to the model. */
export function toolPreviewFromResult(
  name: string,
  result: unknown,
  existing?: ToolResultPreview,
): ToolResultPreview | undefined {
  if (name === "bash") {
    const output = bashOutput(result);
    return output === undefined
      ? undefined
      : { kind: "bash", window: previewWindow(output, DETAILED_BASH_LINE_LIMIT, "end") };
  }
  if (name === "edit" || name === "apply_patch") {
    const patch = (result as { details?: { patch?: unknown } } | null)?.details?.patch;
    return typeof patch === "string" ? diffPreview(patch) : undefined;
  }
  return name === "write" ? existing : undefined;
}

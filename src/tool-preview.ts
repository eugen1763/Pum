import { extname } from "node:path";
import { bashOutput } from "./tool-line";

export const DETAILED_BASH_LINE_LIMIT = 5;
/** Changed lines an inline diff shows before it collapses to a count. */
export const INLINE_DIFF_CHANGED_LINES = 20;

export type PreviewLanguage =
  | "javascript"
  | "typescript"
  | "markdown"
  | "zig"
  | "python"
  | "json"
  | "bash"
  | "rust"
  | "go";

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
    case ".py":
    case ".pyi":
      return "python";
    case ".json":
    case ".jsonc":
      return "json";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "bash";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
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

/**
 * A written file is a diff whose every line is an addition.
 *
 * One shape for every mutation keeps the transcript consistent: a new file and
 * an edited one are read the same way, with the same markers and backgrounds.
 */
export function writePreview(path: string, content: string): ToolResultPreview {
  return {
    kind: "diff",
    lines: logicalLines(content).map((source) => ({
      kind: "add",
      text: `+${source}`,
      source,
      ...(previewLanguage(path) ? { language: previewLanguage(path) } : {}),
    })),
  };
}

const ENVELOPE = /^(\*\*\* (Begin Patch|End Patch|Move to:)|@@|diff --git |--- |\+\+\+ )/;

/**
 * Strip patch ceremony from a diff meant to be read inline.
 *
 * `*** Begin Patch`, `@@` and `--- a/file` are how a patch is transmitted, not
 * what changed. The tool row already names the file, so a single-file diff
 * needs no header at all; only a patch touching several files keeps one per
 * file, to say which hunk belongs where.
 */
export function inlineDiffLines(lines: readonly DiffPreviewLine[]): DiffPreviewLine[] {
  const paths: string[] = [];
  for (const line of lines) {
    if (line.kind !== "header") continue;
    const path = diffFilePath(line.text);
    if (path && !paths.includes(path)) paths.push(path);
  }

  const result: DiffPreviewLine[] = [];
  for (const line of lines) {
    if (line.kind !== "header") {
      result.push(line);
      continue;
    }
    const path = diffFilePath(line.text);
    if (path) {
      if (paths.length < 2) continue;
      // One quiet heading a file, and never two in a row for the same one.
      const heading = { ...line, text: path, source: path };
      if (result.at(-1)?.text !== path) result.push(heading);
      continue;
    }
    if (!ENVELOPE.test(line.text) && line.text.trim()) result.push(line);
  }
  return result;
}

/** The file a patch header names, if it names one. */
function diffFilePath(text: string): string | undefined {
  const codex = text.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
  if (codex) return codex[1]!.trim();
  const git = text.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
  if (git) return git[2]!.trim();
  const unified = text.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
  return unified && unified[1] !== "/dev/null" ? unified[1]!.trim() : undefined;
}

/** Capture input-backed previews without changing tool execution data. */
export function toolPreviewFromStart(name: string, args: unknown): ToolResultPreview | undefined {
  if (name !== "write" || !args || typeof args !== "object") return undefined;
  const input = args as { path?: unknown; content?: unknown };
  if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
  return writePreview(input.path, input.content);
}

export type DiffPreviewWindow = {
  lines: DiffPreviewLine[];
  hidden: number;
};

/**
 * Keep the first `changedLimit` added or removed lines, with their context.
 *
 * A large refactor otherwise buries the conversation under its own diff. The
 * count is of changed lines, not of rows, so a hunk's context never eats the
 * budget that the changes themselves need.
 */
export function clipDiffPreview(
  lines: readonly DiffPreviewLine[],
  changedLimit: number,
): DiffPreviewWindow {
  if (changedLimit <= 0) return { lines: [], hidden: lines.length };
  let changed = 0;
  for (let index = 0; index < lines.length; index++) {
    const kind = lines[index]!.kind;
    if (kind !== "add" && kind !== "remove") continue;
    changed++;
    if (changed <= changedLimit) continue;
    return { lines: lines.slice(0, index), hidden: lines.length - index };
  }
  return { lines: [...lines], hidden: 0 };
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
  if (name === "edit") {
    const patch = (result as { details?: { patch?: unknown } } | null)?.details?.patch;
    return typeof patch === "string" ? diffPreview(patch) : undefined;
  }
  return name === "write" ? existing : undefined;
}

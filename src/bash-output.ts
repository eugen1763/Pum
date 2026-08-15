/**
 * Bash output summarization: keep model context small without losing raw output.
 *
 * PUM owns a trusted per-call capture file. The summarizer never reads a path
 * parsed from command output. When output is changed or elided, the result
 * points at that capture file so the complete stream stays recoverable.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashTool,
  createLocalBashOperations,
  formatSize,
  truncateHead,
  truncateTail,
  type BashOperations,
  type BashToolOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSandboxTempReadRoot, unregisterSandboxTempReadRoot } from "./filesystem-sandbox";

export type BashCutStrategy = "headTail" | "sample" | "tail" | "head" | "summary";

export type BashOutputSettings = {
  enabled: boolean;
  strategy: BashCutStrategy;
  maxBytes: number;
  headLines: number;
  tailLines: number;
  sampleCount: number;
  filterAnsi: boolean;
  dropNoise: boolean;
  compressRepeats: boolean;
  collapseSimilar: boolean;
  keepImportant: boolean;
  tailOnError: boolean;
  alwaysShowMarker: boolean;
};

export const DEFAULT_BASH_OUTPUT: BashOutputSettings = {
  enabled: true,
  strategy: "headTail",
  maxBytes: 3 * 1024,
  headLines: 30,
  tailLines: 40,
  sampleCount: 20,
  filterAnsi: true,
  dropNoise: true,
  compressRepeats: true,
  collapseSimilar: true,
  keepImportant: true,
  tailOnError: true,
  alwaysShowMarker: false,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function normalizeBashOutput(value: unknown): BashOutputSettings {
  const d = DEFAULT_BASH_OUTPUT;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...d };
  const s = value as Partial<BashOutputSettings>;
  const strategies = new Set<BashCutStrategy>(["headTail", "sample", "tail", "head", "summary"]);
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
    strategy: s.strategy && strategies.has(s.strategy) ? s.strategy : d.strategy,
    maxBytes: clampInt(s.maxBytes, d.maxBytes, 256, 50 * 1024),
    headLines: clampInt(s.headLines, d.headLines, 1, 500),
    tailLines: clampInt(s.tailLines, d.tailLines, 1, 500),
    sampleCount: clampInt(s.sampleCount, d.sampleCount, 1, 200),
    filterAnsi: typeof s.filterAnsi === "boolean" ? s.filterAnsi : d.filterAnsi,
    dropNoise: typeof s.dropNoise === "boolean" ? s.dropNoise : d.dropNoise,
    compressRepeats: typeof s.compressRepeats === "boolean" ? s.compressRepeats : d.compressRepeats,
    collapseSimilar: typeof s.collapseSimilar === "boolean" ? s.collapseSimilar : d.collapseSimilar,
    keepImportant: typeof s.keepImportant === "boolean" ? s.keepImportant : d.keepImportant,
    tailOnError: typeof s.tailOnError === "boolean" ? s.tailOnError : d.tailOnError,
    alwaysShowMarker: typeof s.alwaysShowMarker === "boolean" ? s.alwaysShowMarker : d.alwaysShowMarker,
  };
}

let current = { ...DEFAULT_BASH_OUTPUT };

export function setBashOutputSettings(settings: BashOutputSettings): void {
  current = settings;
}

export function setBashOutputSettingsIfPresent(settings: BashOutputSettings | undefined): void {
  current = settings ? { ...settings } : { ...DEFAULT_BASH_OUTPUT };
}

export function getBashOutputSettings(): BashOutputSettings {
  return current;
}

// ---------------------------------------------------------------------------
// Trusted full-output capture
// ---------------------------------------------------------------------------

export type BashOutputCapture = {
  path: string;
  operations: BashOperations;
  read(): Promise<string | undefined>;
  remove(): Promise<void>;
};

let captureDirectory: Promise<string> | null = null;
let captureDirectoryPath: string | null = null;

/**
 * One private per-process directory holds every capture. The agent is told to
 * read a capture path, and the filesystem sandbox allows only the project and
 * configured roots, so this exact directory - created by PUM, never supplied by
 * a model - is registered as a read-only sandbox root. It is created on the
 * first capture, so a run that never captures output creates no directory.
 */
function ensureCaptureDirectory(): Promise<string> {
  captureDirectory ??= mkdtemp(join(tmpdir(), "pum-bash-output-"))
    .then((created) => {
      // The canonical spelling, not mkdtemp's: on a Windows account with an
      // 8.3 alias the agent would otherwise get a path the sandbox refuses.
      const canonical = registerSandboxTempReadRoot(created);
      captureDirectoryPath = canonical;
      return canonical;
    })
    .catch((error) => {
      captureDirectory = null;
      throw error;
    });
  return captureDirectory;
}

function removeCaptureDirectory(path: string): void {
  unregisterSandboxTempReadRoot(path);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Capture cleanup must not break shutdown.
  }
}

/**
 * Withdraw the sandbox read root and remove the private capture directory.
 * Safe to call twice, and safe when no capture ever ran. A directory still
 * being created is cleaned up as soon as it exists.
 */
export function cleanupBashOutputCaptures(): void {
  const pending = captureDirectory;
  const path = captureDirectoryPath;
  captureDirectory = null;
  captureDirectoryPath = null;
  if (path) removeCaptureDirectory(path);
  else if (pending) void pending.then(removeCaptureDirectory).catch(() => {});
}

/** Tee the exact process stream to a PUM-owned private temp file. */
export async function createBashOutputCapture(inner: BashOperations): Promise<BashOutputCapture> {
  const path = join(await ensureCaptureDirectory(), `pum-bash-${randomBytes(8).toString("hex")}.log`);
  const handle = await open(path, "wx", 0o600);
  let writes: Promise<void> = Promise.resolve();
  let failed = false;
  let closed = false;

  const append = (data: Buffer) => {
    const copy = Buffer.from(data);
    writes = writes.then(async () => {
      if (!failed) await handle.write(copy);
    }).catch(() => {
      failed = true;
    });
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    await writes;
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  };

  const operations: BashOperations = {
    exec: async (command, cwd, options) => {
      try {
        return await inner.exec(command, cwd, {
          ...options,
          onData: (data) => {
            append(data);
            options.onData(data);
          },
        });
      } finally {
        await close();
      }
    },
  };

  return {
    path,
    operations,
    async read() {
      await close();
      if (failed) return undefined;
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async remove() {
      await close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Pure transform
// ---------------------------------------------------------------------------

const ANSI_RE =
  /\x1b\]\d*(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)|\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const NOISE_RE = [
  /^[\s.·▸►>│┃|/\\=*_-]*$/u,
  /^processing chunk \.\.\./i,
  /^Compiling package \d+ of \d+/,
  /^add \d+ #/,
];

export function isNoiseLine(line: string): boolean {
  return NOISE_RE.some((re) => re.test(line));
}

export function dropNoise(lines: string[]): string[] {
  return lines.filter((line) => !isNoiseLine(line));
}

export function compressRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= 3) out.push(`${run} x ${lines[i]}`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out;
}

/** Keep real representatives at both ends of a similar numbered run. */
export function collapseSimilarLines(lines: string[], keep = 3, keepTail = 2): string[] {
  const out: string[] = [];
  let i = 0;
  const shape = (line: string) => line.replace(/\d+(?:\.\d+)*/g, "#");
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && shape(lines[j]) === shape(lines[i])) j++;
    const run = j - i;
    if (run >= 8) {
      const headKeep = Math.min(keep, run);
      for (let k = i; k < i + headKeep; k++) out.push(lines[k]);
      const tailKeep = Math.min(keepTail, run - headKeep);
      const hidden = run - headKeep - tailKeep;
      if (hidden > 0) out.push(`… ${hidden} more lines of the same shape …`);
      for (let k = j - tailKeep; k < j; k++) out.push(lines[k]);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

const IMPORTANT_RE = /FAIL|\berror\b|\bError\b|\bfailed\b|warning\b|Exception|Traceback|✗|✘/;

function testPattern(pattern: RegExp, line: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(line);
}

function matchesAnyPattern(line: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => testPattern(pattern, line));
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function uniqueLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function truncateUtf8FromEnd(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function truncateUtf8FromStart(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function fitLine(text: string, maxBytes: number): string {
  if (byteLen(text) <= maxBytes) return text;
  if (maxBytes <= 3) return truncateUtf8FromStart(text, maxBytes);
  return `${truncateUtf8FromStart(text, maxBytes - 3)}...`;
}

function formatExtracted(lines: readonly string[], maxBytes: number): string {
  if (lines.length === 0 || maxBytes <= 12) return "";
  const prefix = "[Extracted]";
  let output = prefix;
  for (const line of lines.slice(0, 16)) {
    const remaining = maxBytes - byteLen(output) - 1;
    if (remaining <= 0) break;
    const fitted = fitLine(line, remaining);
    if (!fitted) break;
    output += `\n${fitted}`;
  }
  return output === prefix ? "" : output;
}

function compactMarker(totalLines: number, path: string | undefined, sampled: boolean, maxBytes: number): string {
  const action = sampled ? "Sampled" : "Summarized";
  const withoutPath = `[${action} ${totalLines} output lines. Full output unavailable]`;
  if (!path) return fitLine(withoutPath, maxBytes);
  const prefix = `[${action} ${totalLines} output lines. Full output: `;
  const suffix = "]";
  const pathBudget = maxBytes - byteLen(prefix) - byteLen(suffix);
  if (pathBudget <= 0) return fitLine(`${prefix}${path}${suffix}`, maxBytes);
  const shownPath = byteLen(path) <= pathBudget
    ? path
    : `…${truncateUtf8FromEnd(path, Math.max(0, pathBudget - 3))}`;
  return `${prefix}${shownPath}${suffix}`;
}

export type BashSummary = {
  content: string;
  contextBytes: number;
  totalLines: number;
  shownLines: number;
  elided: number;
  lossy: boolean;
};

export function summarizeBashOutput(
  rawOutput: string,
  settings: BashOutputSettings,
  options: { exitCode: number; path?: string; patterns?: readonly RegExp[] },
): BashSummary {
  const patterns = options.patterns ?? [];
  let normalized = rawOutput.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (settings.filterAnsi) normalized = stripAnsi(normalized);
  const rawLines = splitLines(normalized);
  const rawText = rawLines.join("\n");
  if (rawLines.length === 0 || rawText.trim() === "") {
    return { content: "(no output)", contextBytes: 10, totalLines: 0, shownLines: 0, elided: 0, lossy: false };
  }

  // Capture requested/important lines before any lossy filter or compression.
  const explicitMatches = patterns.length > 0
    ? uniqueLines(rawLines.filter((line) => matchesAnyPattern(line, patterns)))
    : [];
  const automaticMatches = settings.keepImportant
    ? uniqueLines(rawLines.filter((line) => IMPORTANT_RE.test(line)))
    : [];
  const protectedLines = uniqueLines([...explicitMatches, ...automaticMatches]);

  let lines = [...rawLines];
  if (settings.dropNoise) lines = dropNoise(lines);
  if (settings.compressRepeats) lines = compressRepeats(lines);
  if (settings.collapseSimilar) lines = collapseSimilarLines(lines);
  const processedText = lines.join("\n");
  const transformed = processedText !== rawText;
  const processedTotal = lines.length;

  const strategy: BashCutStrategy =
    options.exitCode !== 0 && settings.tailOnError ? "tail" : settings.strategy;

  type Part =
    | { kind: "lines"; from: number; to: number }
    | { kind: "gap"; from?: number; count: number; stride?: number; sampleCount?: number };
  let parts: Part[];
  let sampled = false;
  const budgetLines = strategy === "headTail" ? settings.headLines + settings.tailLines
    : strategy === "sample" ? settings.headLines + settings.tailLines + settings.sampleCount
      : strategy === "tail" ? settings.tailLines
        : strategy === "head" ? settings.headLines
          : 0;

  if (strategy === "summary") {
    parts = [{ kind: "gap", count: processedTotal }];
  } else if (processedTotal <= budgetLines) {
    parts = [{ kind: "lines", from: 0, to: processedTotal }];
  } else {
    const headEnd = Math.min(processedTotal, settings.headLines);
    const tailStart = Math.max(0, processedTotal - settings.tailLines);
    if (strategy === "head") parts = [{ kind: "lines", from: 0, to: headEnd }];
    else if (strategy === "tail") parts = [{ kind: "lines", from: tailStart, to: processedTotal }];
    else if (tailStart <= headEnd) parts = [{ kind: "lines", from: 0, to: processedTotal }];
    else if (strategy === "headTail") {
      parts = [
        { kind: "lines", from: 0, to: headEnd },
        { kind: "gap", from: headEnd, count: tailStart - headEnd },
        { kind: "lines", from: tailStart, to: processedTotal },
      ];
    } else {
      const middle = tailStart - headEnd;
      const sampleCount = Math.max(1, Math.min(settings.sampleCount, middle));
      parts = [
        { kind: "lines", from: 0, to: headEnd },
        { kind: "gap", from: headEnd, count: middle, stride: Math.max(1, Math.floor(middle / sampleCount)), sampleCount },
        { kind: "lines", from: tailStart, to: processedTotal },
      ];
      sampled = true;
    }
  }

  let body = "";
  let elided = 0;
  for (const part of parts) {
    if (part.kind === "lines") {
      for (let i = part.from; i < part.to; i++) body += `${lines[i]}\n`;
      continue;
    }
    elided += part.count;
    if (part.stride && part.sampleCount && part.from !== undefined) {
      const picked: string[] = [];
      for (let i = 0; i < part.sampleCount; i++) {
        picked.push(lines[part.from + Math.min(i * part.stride, part.count - 1)]!);
      }
      body += `… ${part.count} lines elided; ${picked.length} sampled …\n${picked.join("\n")}\n`;
    } else {
      body += `… ${part.count} line${part.count === 1 ? "" : "s"} elided …\n`;
    }
  }
  body = body.replace(/\n$/, "");

  const bodyNeedsShrink = byteLen(body) > settings.maxBytes;
  const actualLoss = transformed || elided > 0 || sampled || bodyNeedsShrink || strategy === "summary";
  const lossy = actualLoss || settings.alwaysShowMarker;
  if (!lossy) {
    return {
      content: body,
      contextBytes: byteLen(body),
      totalLines: rawLines.length,
      shownLines: body.split("\n").length,
      elided: 0,
      lossy: false,
    };
  }

  const marker = compactMarker(rawLines.length, options.path, sampled, settings.maxBytes);
  const separatorReserve = 4;
  const available = Math.max(0, settings.maxBytes - byteLen(marker) - separatorReserve);
  const extractionAllocation = protectedLines.length > 0
    ? Math.min(1024, Math.floor(available * 0.55))
    : 0;
  let bodyBudget = Math.max(0, available - extractionAllocation);
  let fittedBody = fitBody(body, lines, strategy, settings, processedTotal, bodyBudget);
  const already = new Set(fittedBody.split("\n"));
  const candidates = protectedLines.filter((line) => !already.has(line));
  let extracted = formatExtracted(candidates, extractionAllocation);
  if (!extracted) {
    bodyBudget = available;
    fittedBody = fitBody(body, lines, strategy, settings, processedTotal, bodyBudget);
  }

  const sections = [fittedBody, extracted, marker].filter(Boolean);
  let content = sections.join("\n\n");
  if (byteLen(content) > settings.maxBytes) {
    // Final fail-safe. Preserve the marker and extracted signal before body text.
    const fixed = [extracted, marker].filter(Boolean).join("\n\n");
    const remaining = Math.max(0, settings.maxBytes - byteLen(fixed) - (fixed ? 2 : 0));
    fittedBody = fitBody(body, lines, strategy, settings, processedTotal, remaining);
    content = [fittedBody, fixed].filter(Boolean).join("\n\n");
    if (byteLen(content) > settings.maxBytes) content = truncateUtf8FromStart(content, settings.maxBytes);
  }

  return {
    content,
    contextBytes: byteLen(content),
    totalLines: rawLines.length,
    shownLines: fittedBody ? fittedBody.split("\n").length : 0,
    elided,
    lossy: true,
  };
}

function fitBody(
  body: string,
  lines: string[],
  strategy: BashCutStrategy,
  settings: BashOutputSettings,
  totalLines: number,
  budget: number,
): string {
  if (budget <= 0 || !body) return "";
  if (byteLen(body) <= budget) return body;
  const shrunk = shrink(lines, strategy, settings, totalLines, budget);
  return byteLen(shrunk) <= budget ? shrunk : truncateUtf8FromStart(shrunk, budget);
}

/** Existing generic byte fallback; strategy-specific refinement remains separate. */
function shrink(
  lines: string[],
  strategy: BashCutStrategy,
  settings: BashOutputSettings,
  totalLines: number,
  budget: number,
): string {
  const joined = lines.join("\n");
  let headLines = strategy === "headTail" || strategy === "sample" || strategy === "head"
    ? settings.headLines
    : Math.max(1, Math.floor(totalLines / 2));
  let tailLines = strategy === "headTail" || strategy === "sample" || strategy === "tail"
    ? settings.tailLines
    : Math.max(1, Math.floor(totalLines / 2));
  for (let i = 0; i < 24; i++) {
    const head = truncateHead(joined, { maxLines: headLines, maxBytes: Math.max(32, Math.floor(budget * 0.55)) });
    const tail = truncateTail(joined, { maxLines: tailLines, maxBytes: Math.max(32, Math.floor(budget * 0.45)) });
    const candidate = `${head.content || ""}\n… ${Math.max(0, totalLines - head.outputLines - tail.outputLines)} elided …\n${tail.content || ""}`;
    if (byteLen(candidate) <= budget || headLines <= 2) return candidate;
    headLines = Math.max(2, Math.floor(headLines / 2));
    tailLines = Math.max(2, Math.floor(tailLines / 2));
  }
  return truncateTail(joined, { maxLines: 2, maxBytes: budget }).content;
}

// ---------------------------------------------------------------------------
// Tool schema and wrapper
// ---------------------------------------------------------------------------

export type BashToolLike = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: { command: string; timeout?: number } & Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content: unknown[]; details?: unknown }) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: { fullOutputPath?: string } }>;
};

export const bashOutputParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  full_output: Type.Optional(
    Type.Boolean({ description: "Return pi's native output instead of the summarized view." }),
  ),
  strategy: Type.Optional(
    Type.Union([
      Type.Literal("headTail"),
      Type.Literal("sample"),
      Type.Literal("tail"),
      Type.Literal("head"),
    ], { description: "How to summarize this call's output." }),
  ),
  max_bytes: Type.Optional(Type.Number({ description: "Hard byte budget for this call's complete summarized result." })),
  patterns: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 16,
      description: "Regexes whose matching raw lines must survive summarization.",
    }),
  ),
});

export function bashOutputDescription(base: string): string {
  return `${base} Output is summarized to a short head+tail view. `
    + "Pass full_output=true for pi's native output. Pass patterns=[regex] "
    + "to preserve matching raw lines from the elided middle.";
}

function parsePatterns(raw: unknown): RegExp[] {
  if (!Array.isArray(raw)) return [];
  const out: RegExp[] = [];
  for (const value of raw.slice(0, 16)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 200) continue;
    try {
      out.push(new RegExp(value));
    } catch {
      // Invalid model-supplied regexes are ignored; they do not fail the command.
    }
  }
  return out;
}

function textOf(content: Array<{ type: string; text: string }> | undefined): string {
  return content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
}

const EXIT_RE = /^(.*?)\n\nCommand exited with code (-?\d+)$/s;

export function withBashOutput(
  tool: BashToolLike,
  getSettings: () => BashOutputSettings,
  capture?: BashOutputCapture,
): BashToolLike {
  const baseExecute = tool.execute.bind(tool);
  return {
    ...tool,
    description: bashOutputDescription(tool.description),
    parameters: bashOutputParameters,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const settings = getSettings();
      const askFull = params?.full_output === true;
      const patterns = parsePatterns(params?.patterns);
      const perCall = { ...settings };
      if (typeof params?.strategy === "string") {
        const strategies = new Set<BashCutStrategy>(["headTail", "sample", "tail", "head", "summary"]);
        if (strategies.has(params.strategy as BashCutStrategy)) perCall.strategy = params.strategy as BashCutStrategy;
      }
      if (typeof params?.max_bytes === "number" && Number.isFinite(params.max_bytes)) {
        perCall.maxBytes = Math.max(256, Math.min(50 * 1024, Math.floor(params.max_bytes)));
      }

      try {
        const result = await baseExecute(id, params, signal, onUpdate, ctx);
        if (!settings.enabled || askFull) {
          await capture?.remove();
          return result;
        }
        const captured = capture ? await capture.read() : undefined;
        if (capture && captured === undefined) {
          await capture.remove();
          return result; // Fail open to pi's bounded native result; never lose output.
        }
        const source = captured ?? textOf(result.content);
        const summary = summarizeBashOutput(source, perCall, {
          exitCode: 0,
          path: capture?.path,
          patterns,
        });
        if (capture && !summary.lossy) await capture.remove();
        return {
          ...result,
          content: [{ type: "text", text: summary.content }],
          details: capture && summary.lossy ? { fullOutputPath: capture.path } : result.details,
        };
      } catch (error) {
        if (!(error instanceof Error)) {
          await capture?.remove();
          throw error;
        }
        if (!settings.enabled || askFull) {
          await capture?.remove();
          throw error;
        }
        const match = EXIT_RE.exec(error.message);
        if (!match) {
          await capture?.remove();
          throw error;
        }
        const captured = capture ? await capture.read() : undefined;
        if (capture && captured === undefined) {
          await capture.remove();
          throw error;
        }
        const status = `Command exited with code ${match[2]}`;
        const summaryBudget = Math.max(64, perCall.maxBytes - byteLen(status) - 2);
        const summary = summarizeBashOutput(captured ?? match[1], { ...perCall, maxBytes: summaryBudget }, {
          exitCode: Number(match[2]),
          path: capture?.path,
          patterns,
        });
        if (capture && !summary.lossy) await capture.remove();
        throw new Error(`${summary.content}\n\n${status}`);
      }
    },
  };
}

/** Execute one bash call with capture when summarization is active. */
export async function executeBashWithOutput(
  cwd: string,
  options: BashToolOptions,
  id: string,
  params: { command: string; timeout?: number } & Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  ctx: any,
): Promise<any> {
  const settings = getBashOutputSettings();
  if (!settings.enabled || params.full_output === true) {
    return (createBashTool(cwd, options).execute as any)(id, params, signal, onUpdate, ctx);
  }

  const inner = options.operations ?? createLocalBashOperations({ shellPath: options.shellPath });
  let capture: BashOutputCapture;
  try {
    capture = await createBashOutputCapture(inner);
  } catch {
    // If the trusted capture cannot be created, keep pi's native bounded output.
    return (createBashTool(cwd, options).execute as any)(id, params, signal, onUpdate, ctx);
  }
  const base = createBashTool(cwd, { ...options, operations: capture.operations });
  const wrapped = withBashOutput(base as unknown as BashToolLike, () => settings, capture);
  return (wrapped.execute as any)(id, params, signal, onUpdate, ctx);
}

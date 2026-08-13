/**
 * Output-policy engine v2: raw bash output -> context text + a marker.
 *
 * Strategy space:
 *   tail     keep the last N lines            (pi's current behavior)
 *   head     keep the first N lines
 *   headTail keep first H and last T, elide the middle
 *   sample   keep first H, last T, plus a uniform stride sample of the middle
 *   summary  keep no content; only stats + full-output path
 *
 * Tool-arg channel: `patterns` are regexes the model passes on a call. Their
 * matches are injected back into the summary even from the elided middle, so
 * the model can extract exactly the lines it is hunting for.
 */

import { truncateHead, truncateTail, formatSize } from "@earendil-works/pi-coding-agent";

export type CutStrategy = "tail" | "head" | "headTail" | "sample" | "summary";

export type FilterKind = "none" | "ansi" | "noise" | "ansiNoise";

export type OutputPolicy = {
  name: string;
  strategy: CutStrategy;
  maxLines: number; // total content line ceiling (all strategies)
  maxBytes: number; // total content byte ceiling
  headLines: number; // head+tail / sample head
  tailLines: number; // head+tail / sample tail
  sampleCount: number; // sample middle lines (sample strategy)
  filter: FilterKind;
  compressRepeats: boolean; // exact-run collapse
  collapseSimilar: boolean; // collapse runs that differ only by numbers
  keepImportant: boolean; // keep FAIL/error/warning lines through elision
  /** Model-supplied regexes; matches survive elision. */
  patterns: RegExp[];
  /** On non-zero exit, force tail so the error region is kept. */
  tailOnError: boolean;
  /** Always emit a marker that points at the full-output file. */
  alwaysMarker: boolean;
};

export const PI_BASELINE: OutputPolicy = {
  name: "pi-baseline",
  strategy: "tail",
  maxLines: 2000,
  maxBytes: 50 * 1024,
  headLines: 2000,
  tailLines: 2000,
  sampleCount: 20,
  filter: "none",
  compressRepeats: false,
  collapseSimilar: false,
  keepImportant: false,
  patterns: [],
  tailOnError: false,
  alwaysMarker: true,
};

/** Default PUM proposal. */
export const PUM_PROPOSAL: OutputPolicy = {
  name: "pum-ht-3k",
  strategy: "headTail",
  maxLines: 80,
  maxBytes: 3 * 1024,
  headLines: 30,
  tailLines: 40,
  sampleCount: 20,
  filter: "ansiNoise",
  compressRepeats: true,
  collapseSimilar: true,
  keepImportant: true,
  patterns: [],
  tailOnError: true,
  alwaysMarker: true,
};

export type TransformResult = {
  content: string;
  contextBytes: number;
  shownLines: number;
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
  elided: number;
  sampled: number;
};

const ANSI_RE =
  /\x1b\]\d*(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)|\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Conservative noise lines: only unambiguous progress/punctuation lines. */
const NOISE_RE = [
  /^[\s.·▸►>│┃|/\\=*_-]*$/u, // dots, bars, spinner-only lines
  /^processing chunk \.\.\./i,
  /^Compiling package \d+ of \d+/,
  /^add \d+ #/,
];

export function isNoiseLine(line: string): boolean {
  return NOISE_RE.some((re) => re.test(line));
}

export function dropNoise(lines: string[]): string[] {
  return lines.filter((l) => !isNoiseLine(l));
}

/** Collapse runs of >=3 identical lines into "N x <line>". */
export function compressRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= 3) {
      out.push(`${run} x ${lines[i]}`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

/**
 * Collapse the tail of a run of >=8 lines whose digit-stripped forms match,
 * but keep the first few lines VERBATIM so real data (e.g. git hashes, line
 * numbers) survives. Catches "Compiling package 5 of 3000" noise without
 * flattening a git log or a numbered listing.
 */
export function collapseNumericRuns(lines: string[], keep = 3): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].replace(/\d+(?:\.\d+)*/g, "#") === lines[i].replace(/\d+(?:\.\d+)*/g, "#")
    ) {
      j++;
    }
    const run = j - i;
    if (run >= 8) {
      const kept = Math.min(keep, run);
      for (let k = i; k < i + kept; k++) out.push(lines[k]);
      const rest = run - kept;
      if (rest > 0) {
        out.push(`… ${rest} more lines of the same shape …`);
      }
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const IMPORTANT_RE = /FAIL|\berror\b|\bError\b|\bfailed\b|warning\b|Exception|Traceback|✗|✘/;

/** True when a line carries signal worth keeping through elision. */
export function matchesImportant(line: string, patterns: RegExp[]): boolean {
  if (IMPORTANT_RE.test(line)) return true;
  if (patterns.length > 0) {
    for (const re of patterns) {
      if (re.test(line)) return true;
    }
  }
  return false;
}

export function formatSizeBytes(b: number): string {
  return formatSize(b);
}

/**
 * Apply `policy` to `rawOutput` (the FULL raw output text).
 */
export function applyPolicy(
  rawOutput: string,
  policy: OutputPolicy,
  options: { exitCode: number; path?: string; patterns?: RegExp[] },
): TransformResult {
  // 1. Normalize and clean.
  let text = rawOutput.replace(/\r\n/g, "\n");
  if (policy.filter === "ansi" || policy.filter === "ansiNoise") text = stripAnsi(text);
  let lines = splitLines(text);
  if (policy.filter === "noise" || policy.filter === "ansiNoise") lines = dropNoise(lines);
  if (policy.compressRepeats) lines = compressRepeats(lines);
  if (policy.collapseSimilar) lines = collapseNumericRuns(lines);

  const totalLines = lines.length;
  const keptText = lines.join("\n");
  const totalKeptBytes = byteLen(keptText);
  const patterns = [...(options.patterns ?? []), ...policy.patterns];
  const wantImportant = policy.keepImportant || patterns.length > 0;

  // Locate important line indexes that must survive elision.
  const importantIndexes: number[] = [];
  if (wantImportant && policy.strategy !== "summary") {
    for (let i = 0; i < lines.length; i++) {
      if (matchesImportant(lines[i], patterns)) importantIndexes.push(i);
    }
  }

  // 2. Strategy. On non-zero exit, the tail is the error zone -> force it.
  const effectiveStrategy: CutStrategy =
    options.exitCode !== 0 && policy.tailOnError ? "tail" : policy.strategy;

  const headWindow =
    effectiveStrategy === "headTail" || effectiveStrategy === "sample" ? policy.headLines
    : effectiveStrategy === "head" ? policy.maxLines
    : undefined;
  const tailWindow =
    effectiveStrategy === "headTail" || effectiveStrategy === "sample" ? policy.tailLines
    : effectiveStrategy === "tail" ? policy.maxLines
    : undefined;

  // 2b. Select the base slice (list of kept line indices + elision markers).
  type Part =
    | { type: "lines"; from: number; to: number }
    | { type: "gap"; from: number; count: number; stride?: number; skip?: number };
  let parts: Part[];
  let sampled = 0;

  const budgetLines =
    effectiveStrategy === "headTail"
      ? policy.headLines + policy.tailLines
      : effectiveStrategy === "sample"
        ? policy.headLines + policy.tailLines + policy.sampleCount
        : policy.maxLines;

  if (effectiveStrategy === "summary") {
    parts = [{ type: "gap", from: 0, count: totalLines }];
  } else if (totalLines <= budgetLines && byteLen(keptText) <= policy.maxBytes) {
    parts = [];
    if (totalLines > 0) parts.push({ type: "lines", from: 0, to: totalLines });
  } else {
    switch (effectiveStrategy) {
      case "head": {
        parts = totalLines === 0 ? [] : [{ type: "lines", from: 0, to: Math.min(totalLines, policy.maxLines) }];
        break;
      }
      case "tail": {
        const start = Math.max(0, totalLines - policy.maxLines);
        parts = [{ type: "lines", from: start, to: totalLines }];
        break;
      }
      case "headTail": {
        const headEnd = Math.min(totalLines, policy.headLines);
        const tailStart = Math.max(0, totalLines - policy.tailLines);
        if (tailStart <= headEnd) {
          parts = [{ type: "lines", from: 0, to: totalLines }];
        } else {
          parts = [
            { type: "lines", from: 0, to: headEnd },
            { type: "gap", from: headEnd, count: tailStart - headEnd },
            { type: "lines", from: tailStart, to: totalLines },
          ];
        }
        break;
      }
      case "sample": {
        const headEnd = Math.min(totalLines, policy.headLines);
        const tailStart = Math.max(0, totalLines - policy.tailLines);
        if (tailStart <= headEnd) {
          parts = [{ type: "lines", from: 0, to: totalLines }];
        } else {
          const midLen = tailStart - headEnd;
          const count = Math.max(1, Math.min(policy.sampleCount, midLen));
          const stride = Math.floor(midLen / count);
          sampled = count;
          parts = [
            { type: "lines", from: 0, to: headEnd },
            { type: "gap", from: headEnd, count: midLen, stride: stride, skip: sampled },
            { type: "lines", from: tailStart, to: totalLines },
          ];
        }
        break;
      }
    }
  }

  // 2c. Render parts into text while tracking elision.
  let body = "";
  let elided = 0;
  for (const part of parts) {
    if (part.type === "gap") {
      if (part.stride && part.skip) {
        // Uniform sample of the middle: stride step lines, expect ~skip total.
        const picked: string[] = [];
        for (let i = 0; i < part.skip; i++) {
          const idx = part.from + Math.min(i * part.stride, part.count - 1);
          picked.push(lines[idx]);
        }
        elided += part.count;
        body += `… ${part.count} lines elided; ${picked.length} sampled …\n`;
        body += picked.join("\n");
        body += "\n";
      } else {
        elided += part.count;
        body += `… ${part.count} line${part.count === 1 ? "" : "s"} elided …\n`;
      }
    } else {
      for (let i = part.from; i < part.to; i++) {
        body += `${lines[i]}\n`;
      }
    }
  }
  body = body.replace(/\n$/, "");

  // 3. Byte bound: keep fixture lines, then trim toward the budget.
  let finalBody = body;
  if (byteLen(finalBody) > policy.maxBytes) {
    finalBody = shrinkToBytes(finalBody, lines, effectiveStrategy, policy, totalLines);
  }

  // 3b. Re-inject important lines that sit in the elided region.
  if (wantImportant && effectiveStrategy !== "summary" && elided > 0 && importantIndexes.length > 0) {
    const already = new Set(finalBody.split("\n"));
    let floor = 0;
    if (headWindow !== undefined) floor = Math.max(0, Math.min(headWindow - 1, totalLines - 1));
    const tailFloor = tailWindow !== undefined ? totalLines - tailWindow : totalLines;
    const keep: string[] = [];
    for (const i of importantIndexes) {
      if (i <= floor || i >= tailFloor) continue; // already visible
      const line = lines[i];
      if (already.has(line)) continue;
      keep.push(line);
      if (keep.length >= 16) break;
    }
    if (keep.length > 0) {
      finalBody = `${finalBody.trimEnd()}\n\n[Extracted] ${keep.join(" | ")}`;
    }
  }

  // 4. Assemble marker.
  const truncated = finalBody.length < keptText.length;
  const shownLines = finalBody.length === 0 ? 0 : finalBody.split("\n").length;
  const pathPart = options.path ? ` Full output: ${options.path}` : "";

  let marker = "";
  if (policy.alwaysMarker || truncated) {
    if (effectiveStrategy === "summary") {
      marker = `\n\n[Output elided: ${totalLines} lines, ${formatSizeBytes(totalKeptBytes)} fully saved at ${options.path ?? "(in memory)"}]`;
    } else if (sampled > 0) {
      marker = `\n\n[Showing ${shownLines} lines (head+sample+tail) of ${totalLines} (${formatSizeBytes(byteLen(finalBody))}/${formatSizeBytes(totalKeptBytes)}).${pathPart}]`;
    } else if (elided > 0) {
      marker = `\n\n[Showing ${shownLines} lines of ${totalLines} (${formatSizeBytes(byteLen(finalBody))} shown of ${formatSizeBytes(totalKeptBytes)}).${pathPart}]`;
    } else if (truncated) {
      marker = `\n\n[Showing last ${formatSizeBytes(byteLen(finalBody))} (${formatSizeBytes(totalKeptBytes)} total).${pathPart}]`;
    }
  }
  const finalMarker = elided > 0 || sampled > 0 || truncated || policy.alwaysMarker ? marker : "";

  return {
    content: finalBody.trimEnd() + finalMarker,
    contextBytes: byteLen(finalBody.trimEnd() + finalMarker),
    shownLines,
    totalLines,
    totalBytes: totalKeptBytes,
    truncated: truncated || elided > 0,
    elided,
    sampled,
  };
}

/** Byte-shrink a rendered body by rebuilding head/tail/sample with smaller windows. */
function shrinkToBytes(
  body: string,
  lines: string[],
  strategy: CutStrategy,
  policy: OutputPolicy,
  totalLines: number,
): string {
  if (totalLines === 0 || body.length === 0) return body;
  // Last-resort: a plain tail bounded to maxBytes. Prefer head+tail halves.
  const budget = policy.maxBytes;
  let h =
    strategy === "headTail" || strategy === "sample"
      ? policy.headLines
      : strategy === "head"
        ? policy.maxLines
        : Math.max(1, Math.floor(totalLines / 2));
  let t =
    strategy === "headTail" || strategy === "sample"
      ? policy.tailLines
      : strategy === "tail"
        ? policy.maxLines
        : Math.max(1, Math.floor(totalLines / 2));
  if (h <= 0) h = 1;
  if (t <= 0) t = 1;
  let candidates = 0;
  while (candidates < 24) {
    candidates++;
    const headText = truncateHead(lines.join("\n"), {
      maxLines: h,
      maxBytes: Math.max(64, Math.floor(budget * 0.55)),
    });
    const tailText = truncateTail(lines.join("\n"), {
      maxLines: t,
      maxBytes: Math.max(64, Math.floor(budget * 0.45)),
    });
    const candidate = `${headText.content || ""}\n… ${Math.max(0, totalLines - headText.outputLines - tailText.outputLines)} elided …\n${tailText.content || ""}`;
    if (byteLen(candidate) <= budget || h <= 2) {
      return candidate;
    }
    h = Math.max(2, Math.floor(h / 2));
    t = Math.max(2, Math.floor(t / 2));
  }
  const tail = truncateTail(lines.join("\n"), { maxLines: 2, maxBytes: budget });
  return tail.content;
}

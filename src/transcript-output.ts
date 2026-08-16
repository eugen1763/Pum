import type { Line, PendingLine } from "./transcript";
import {
  minimalTranscriptLines,
  type MinimalTranscriptLine,
} from "./output-minimal";
import { normalizeOutputMode, type OutputMode } from "./settings";

/** Alias kept at the transcript boundary to avoid coupling renderers to settings storage. */
export type TranscriptOutputMode = OutputMode;

/** Read the mode defensively while older settings and test fixtures omit it. */
export function transcriptOutputMode(settings: unknown): TranscriptOutputMode {
  const value = (settings as { outputMode?: unknown } | null)?.outputMode;
  return normalizeOutputMode(value);
}

/**
 * Derive display rows from canonical transcript rows.
 *
 * Keep this boundary pure. Mode changes can then rerender the complete live or
 * resumed transcript without rewriting session entries or model context.
 * Quiet and Normal aggregate routine successful calls. Verbose keeps every
 * canonical tool row and changes ToolLine presentation only.
 */
export function projectTranscriptLines(
  lines: readonly Line[],
  mode: TranscriptOutputMode,
): MinimalTranscriptLine[] {
  if (mode === "verbose") return [...lines];
  const compact = minimalTranscriptLines(lines, mode === "quiet");
  return mode === "quiet"
    ? compact.filter((line) => line.kind !== "agent-message")
    : compact;
}

/** Hide queued agent-message display rows in Quiet without changing delivery state. */
export function projectPendingTranscriptLines(
  pending: readonly PendingLine[],
  mode: TranscriptOutputMode,
): PendingLine[] {
  return mode === "quiet"
    ? pending.filter((item) => item.line.kind !== "agent-message")
    : [...pending];
}

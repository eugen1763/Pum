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
 * Normal aggregates routine successful calls. Quiet aggregates every settled
 * call, including failed and rejected calls. Verbose keeps every canonical
 * tool row and changes ToolLine presentation only.
 *
 * Inter-agent messages answer to their own setting, not to the mode. What one
 * agent said to another is a different question from how much tool detail to
 * show, so Verbose can hide them and Quiet can keep them.
 */
export function projectTranscriptLines(
  lines: readonly Line[],
  mode: TranscriptOutputMode,
  showAgentMessages = true,
): MinimalTranscriptLine[] {
  const visible = showAgentMessages
    ? lines
    : lines.filter((line) => line.kind !== "agent-message");
  if (mode === "verbose") return [...visible];
  return minimalTranscriptLines(visible, mode === "quiet");
}

/** Hide queued agent-message display rows without changing delivery state. */
export function projectPendingTranscriptLines(
  pending: readonly PendingLine[],
  showAgentMessages = true,
): PendingLine[] {
  return showAgentMessages
    ? [...pending]
    : pending.filter((item) => item.line.kind !== "agent-message");
}

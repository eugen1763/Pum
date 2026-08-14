import type { Line } from "./transcript";
import {
  minimalTranscriptLines,
  type MinimalTranscriptLine,
} from "./output-minimal";

/** Transcript presentation modes persisted by PUM settings. */
export type TranscriptOutputMode = "minimal" | "default" | "detailed";

export const TRANSCRIPT_OUTPUT_MODES = ["minimal", "default", "detailed"] as const;

/** Read the mode defensively while older settings and test fixtures omit it. */
export function transcriptOutputMode(settings: unknown): TranscriptOutputMode {
  const value = (settings as { outputMode?: unknown } | null)?.outputMode;
  return TRANSCRIPT_OUTPUT_MODES.includes(value as TranscriptOutputMode)
    ? value as TranscriptOutputMode
    : "default";
}

/**
 * Derive display rows from canonical transcript rows.
 *
 * Keep this boundary pure. Mode changes can then rerender the complete live or
 * resumed transcript without rewriting session entries or model context.
 * Minimal-mode aggregation plugs into this function during final integration.
 * Detailed mode keeps row identity and changes only ToolLine presentation.
 */
export function projectTranscriptLines(
  lines: readonly Line[],
  mode: TranscriptOutputMode,
): MinimalTranscriptLine[] {
  return mode === "minimal" ? minimalTranscriptLines(lines) : [...lines];
}

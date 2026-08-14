import type { Line } from "./transcript";
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
 * Minimal-mode aggregation plugs into this function during final integration.
 * Detailed mode keeps row identity and changes only ToolLine presentation.
 */
export function projectTranscriptLines(
  lines: readonly Line[],
  mode: TranscriptOutputMode,
): MinimalTranscriptLine[] {
  return mode === "minimal" ? minimalTranscriptLines(lines) : [...lines];
}

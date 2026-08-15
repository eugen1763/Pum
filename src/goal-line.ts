import { statusTextWidth, truncateStatusText } from "./status-metadata";
import type { GoalRecord, GoalState } from "./goal";
import type { Theme } from "./theme";

/**
 * The goal label that sits on the full-width rule above the prompt input.
 *
 * The rule is exactly one rendered row, so the label has to be measured in
 * terminal columns and cut on grapheme boundaries before it is painted.
 */

/** Columns of padding inside the label, on its right edge. */
export const GOAL_LABEL_RIGHT_PADDING = 2;
const PREFIX = "GOAL";
const SEPARATOR = " · ";
/** Below this the label cannot say anything useful, so the rule stays plain. */
const MIN_LABEL_COLUMNS = 12;

export type GoalLabel = {
  /** Exactly what is painted, right padding included. */
  text: string;
  /** Rendered terminal columns. */
  width: number;
  state: GoalState;
};

/** Foreground for a goal label, by lifecycle state. */
export function goalLabelColor(theme: Theme, state: GoalState): string {
  switch (state) {
    case "active": return theme.accent;
    case "blocked": return theme.warn;
    case "completed": return theme.success;
    case "failed": return theme.error;
    default: return theme.goalLabel;
  }
}

/**
 * Build the label for a rule of `ruleWidth` columns, or null when the terminal
 * is too narrow to hold one. The label never exceeds half the rule, so the
 * animated sweep always has room left.
 */
export function goalLabel(goal: GoalRecord | null, ruleWidth: number): GoalLabel | null {
  if (!goal || ruleWidth <= 0) return null;
  const available = Math.min(ruleWidth, Math.max(MIN_LABEL_COLUMNS, Math.floor(ruleWidth / 2)));
  if (available < MIN_LABEL_COLUMNS || available > ruleWidth) return null;

  const head = `${PREFIX}${SEPARATOR}${goal.state}`;
  const padding = " ".repeat(GOAL_LABEL_RIGHT_PADDING);
  const headWidth = statusTextWidth(head) + GOAL_LABEL_RIGHT_PADDING;
  if (headWidth > available) return null;

  const textColumns = available - headWidth - statusTextWidth(SEPARATOR);
  // The rule is one row, so a multi-line goal collapses to a single line first.
  const oneLine = goal.text.replace(/\s+/g, " ").trim();
  const text = textColumns > 0 ? truncateStatusText(oneLine, textColumns) : null;
  const label = text ? `${head}${SEPARATOR}${text}${padding}` : `${head}${padding}`;
  return { text: label, width: statusTextWidth(label), state: goal.state };
}

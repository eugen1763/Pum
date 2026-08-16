import { statusTextWidth, truncateStatusText } from "./status-metadata";
import type { GoalRecord, GoalState } from "./goal";
import type { Theme } from "./theme";

/**
 * The goal label that sits on the full-width rule above the prompt input.
 *
 * The rule is exactly one rendered row, so the label has to be measured in
 * terminal columns and cut on grapheme boundaries before it is painted. The
 * rule can carry more than one label, so the column budget below is shared:
 * see `mode-line.ts`.
 */

/** Columns of full-background padding on each side of label text. */
export const RULE_LABEL_SIDE_PADDING = 1;
/** Columns of plain rule kept after the right-aligned label group. */
export const RULE_LABEL_TRAILING_RULE_COLUMNS = 2;
/** Separates a label's prefix, its state, and its text. */
export const LABEL_SEPARATOR = " · ";
/** Below this a label cannot say anything useful, so the rule stays plain. */
export const MIN_LABEL_COLUMNS = 12;
/** Columns of rule the labels never take, so the sweep always has somewhere to run. */
export const MIN_RULE_COLUMNS = 4;
const PREFIX = "GOAL";

export type GoalLabel = {
  /** Exactly what is painted, including one padding column on each side. */
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
 * Columns every label on one rule shares, so the animated sweep always has room
 * left. `minColumns` is the narrowest label the caller can still make useful;
 * below it the rule stays plain.
 */
export function ruleLabelBudget(ruleWidth: number, minColumns = MIN_LABEL_COLUMNS): number {
  if (ruleWidth <= 0) return 0;
  const room = ruleWidth - MIN_RULE_COLUMNS;
  const budget = Math.min(room, Math.max(minColumns, Math.floor(ruleWidth / 2)));
  return budget < minColumns ? 0 : budget;
}

/** Narrowest goal label worth painting: the prefix, this state, the padding. */
export function goalMinColumns(goal: GoalRecord): number {
  return statusTextWidth(`${PREFIX}${LABEL_SEPARATOR}${goal.state}`) + RULE_LABEL_SIDE_PADDING * 2;
}

/**
 * Build the goal label inside `available` columns, or null when it does not
 * fit. `includeText` off keeps only the prefix and the state.
 */
export function goalLabelWithin(
  goal: GoalRecord | null,
  available: number,
  includeText = true,
): GoalLabel | null {
  if (!goal || available <= 0) return null;

  const head = `${PREFIX}${LABEL_SEPARATOR}${goal.state}`;
  const padding = " ".repeat(RULE_LABEL_SIDE_PADDING);
  const headWidth = statusTextWidth(head) + RULE_LABEL_SIDE_PADDING * 2;
  if (headWidth > available) return null;

  const textColumns = available - headWidth - statusTextWidth(LABEL_SEPARATOR);
  // The rule is one row, so a multi-line goal collapses to a single line first.
  const oneLine = goal.text.replace(/\s+/g, " ").trim();
  const text = includeText && textColumns > 0 ? truncateStatusText(oneLine, textColumns) : null;
  const label = text
    ? `${padding}${head}${LABEL_SEPARATOR}${text}${padding}`
    : `${padding}${head}${padding}`;
  return { text: label, width: statusTextWidth(label), state: goal.state };
}

/**
 * Build the label for a rule of `ruleWidth` columns, or null when the terminal
 * is too narrow to hold one.
 */
export function goalLabel(goal: GoalRecord | null, ruleWidth: number): GoalLabel | null {
  return goalLabelWithin(goal, ruleLabelBudget(ruleWidth));
}

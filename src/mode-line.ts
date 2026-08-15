import {
  GOAL_LABEL_RIGHT_PADDING,
  LABEL_SEPARATOR,
  MIN_LABEL_COLUMNS,
  goalLabelColor,
  goalLabelWithin,
  goalMinColumns,
  ruleLabelBudget,
} from "./goal-line";
import { statusTextWidth, truncateStatusText } from "./status-metadata";
import type { WorkingRuleLabel } from "./animation";
import type { GoalRecord } from "./goal";
import type { Theme } from "./theme";

/**
 * The labels that share the full-width rule above the prompt input.
 *
 * AFK sits left of the goal, because the rule clips at its right edge: when the
 * terminal is too narrow for everything, the goal loses columns first.
 */

const PREFIX = "AFK";

export type AfkRuleStateName = "on" | "answering";
export const AFK_RULE_STATES: readonly AfkRuleStateName[] = ["on", "answering"];

/**
 * All the rule needs to know about AFK. The controller owns the real state;
 * this stays a plain value so the label builder has no dependency on it.
 */
export type AfkRuleState = {
  state: AfkRuleStateName;
  /** Current AFK guidance, previewed when the rule has columns to spare. */
  instructions?: string | null;
};

/** A preview needs the separator and a column of text to say anything at all. */
const MIN_PREVIEW_COLUMNS = statusTextWidth(LABEL_SEPARATOR) + 1;

/** Narrowest AFK label worth painting: the prefix, this state, the padding. */
const afkMinColumns = (afk: AfkRuleState): number =>
  statusTextWidth(`${PREFIX}${LABEL_SEPARATOR}${afk.state}`) + GOAL_LABEL_RIGHT_PADDING;

/** Foreground for the AFK label, by what AFK is doing. */
export function afkLabelColor(theme: Theme, state: AfkRuleStateName): string {
  return state === "answering" ? theme.statsRunning : theme.agentMessage;
}

/**
 * Build the AFK label inside `available` columns. `previewAllowance` caps the
 * whole label when the instruction preview is wanted; 0 leaves it out.
 */
function afkLabel(
  afk: AfkRuleState,
  available: number,
  previewAllowance: number,
): { text: string; width: number } | null {
  if (available <= 0) return null;

  const head = `${PREFIX}${LABEL_SEPARATOR}${afk.state}`;
  const padding = " ".repeat(GOAL_LABEL_RIGHT_PADDING);
  const headWidth = statusTextWidth(head) + GOAL_LABEL_RIGHT_PADDING;
  if (headWidth > available) return null;

  const textColumns =
    Math.min(available, previewAllowance) - headWidth - statusTextWidth(LABEL_SEPARATOR);
  // The rule is one row, so multi-line instructions collapse to one line first.
  const oneLine = (afk.instructions ?? "").replace(/\s+/g, " ").trim();
  const preview = oneLine && textColumns > 0 ? truncateStatusText(oneLine, textColumns) : null;
  const text = preview ? `${head}${LABEL_SEPARATOR}${preview}${padding}` : `${head}${padding}`;
  return { text, width: statusTextWidth(text) };
}

export type ModeLineInput = {
  goal: GoalRecord | null;
  afk: AfkRuleState | null;
  ruleWidth: number;
  theme: Theme;
};

/**
 * Columns the labels may share. AFK and the goal both outrank anything
 * optional, so a rule that can seat both states widens past half the rule to do
 * it, and only falls back to AFK alone when even that does not fit.
 */
function labelBudget(ruleWidth: number, afk: AfkRuleState | null, goal: GoalRecord | null): number {
  if (!afk) return ruleLabelBudget(ruleWidth);
  if (goal) {
    const both = ruleLabelBudget(ruleWidth, afkMinColumns(afk) + goalMinColumns(goal));
    if (both > 0) return both;
  }
  return ruleLabelBudget(ruleWidth, Math.max(MIN_LABEL_COLUMNS, afkMinColumns(afk)));
}

/**
 * The ordered labels for a rule of `ruleWidth` columns, empty when the terminal
 * cannot show a useful minimum. Together they never take more than the shared
 * budget, so the animated sweep always has rule left to run on.
 *
 * Columns go out in priority order — the AFK state, the goal state, the AFK
 * instruction preview, then the goal text — so a narrowing rule loses the goal
 * text first and the AFK state last.
 */
export function modeLineLabels(input: ModeLineInput): WorkingRuleLabel[] {
  const { goal, afk, theme } = input;
  const budget = labelBudget(input.ruleWidth, afk, goal);
  if (budget <= 0) return [];
  let left = budget;

  let afkPainted = afk ? afkLabel(afk, left, 0) : null;
  if (afkPainted) left -= afkPainted.width;

  let goalPainted = goal ? goalLabelWithin(goal, left, false) : null;
  if (goalPainted) left -= goalPainted.width;

  // The goal state outranks the preview. When the rule is too narrow to seat
  // both, a stub of a preview is noise, so the goal takes it down with it.
  const goalSqueezedOut = goal !== null && goalPainted === null;
  if (afk && afkPainted && !goalSqueezedOut) {
    // Long instructions would otherwise eat every spare column and the goal
    // would never say what it is. Half the spare is the preview's, but it keeps
    // its own minimum, so the goal text is the first of the two to run out.
    const share = Math.max(MIN_PREVIEW_COLUMNS, Math.ceil(left / 2));
    const spare = goalPainted ? Math.min(left, share) : left;
    const room = afkPainted.width + spare;
    const withPreview = afkLabel(afk, room, room);
    if (withPreview) {
      left -= withPreview.width - afkPainted.width;
      afkPainted = withPreview;
    }
  }

  if (goal && goalPainted) {
    goalPainted = goalLabelWithin(goal, goalPainted.width + left, true) ?? goalPainted;
  }

  const labels: WorkingRuleLabel[] = [];
  if (afk && afkPainted) labels.push({ ...afkPainted, color: afkLabelColor(theme, afk.state) });
  if (goalPainted) {
    labels.push({
      text: goalPainted.text,
      width: goalPainted.width,
      color: goalLabelColor(theme, goalPainted.state),
    });
  }
  return labels;
}

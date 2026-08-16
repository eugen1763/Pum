import type { Theme } from "./theme";

/**
 * The inline goal-review row.
 *
 * One row stands for one judge run. It is appended the moment the review
 * starts and rewritten in place when the review ends, so the transcript shows
 * the wait and its outcome in the same spot instead of going quiet for a full
 * model call and then producing a continuation out of nowhere.
 */

export type GoalReviewStatus =
  | "reviewing"
  /** The goal is met. */
  | "completed"
  /** More work is owed; the continuation turn follows this row. */
  | "continuing"
  /** The judge needs an answer from the user. */
  | "blocked"
  /** The retry limit is spent. */
  | "failed"
  /** A valid verdict arrived too late to act on. */
  | "discarded"
  /** The goal was stopped, cleared, or replaced while the review ran. */
  | "cancelled"
  /** The review could not start, or ended without a usable verdict. */
  | "error";

export const REVIEW_LABEL = "Goal review";

export function goalReviewGlyph(status: GoalReviewStatus): string {
  switch (status) {
    case "reviewing": return "◌ ";
    case "completed": return "✓ ";
    case "continuing": return "→ ";
    case "blocked": return "? ";
    case "failed": return "✗ ";
    case "error": return "✗ ";
    default: return "· ";
  }
}

export function goalReviewColor(theme: Theme, status: GoalReviewStatus): string {
  switch (status) {
    case "reviewing": return theme.accent;
    case "completed": return theme.success;
    case "continuing": return theme.accent;
    case "blocked": return theme.warn;
    case "failed": return theme.error;
    case "error": return theme.error;
    default: return theme.dim;
  }
}

function statusWord(status: GoalReviewStatus): string {
  return status === "cancelled" ? "cancelled" : status;
}

/** The one-line header: the label, the status, and any detail the caller adds. */
export function goalReviewHeadline(status: GoalReviewStatus, detail?: string): string {
  const head = `${REVIEW_LABEL} · ${statusWord(status)}`;
  const extra = detail?.trim();
  return extra ? `${head} ${extra}` : head;
}

/** How far through the retry budget an incomplete review is. */
export function retryDetail(incompleteCount: number, retryLimit: number): string {
  return retryLimit === 0 ? `(attempt ${incompleteCount})` : `(${incompleteCount}/${retryLimit})`;
}

import { MAX_GOAL_TEXT } from "./goal";

/**
 * `/goal` and `/goalf` parsing.
 *
 * A bare word after `/goal` is a control action. Anything longer is goal text,
 * so "/goal stop the flaky tests" still sets a goal rather than stopping one.
 */

export const GOAL_CONTROLS = ["stop", "continue", "status", "clear"] as const;
export type GoalControl = (typeof GOAL_CONTROLS)[number];

export type GoalCommand =
  | { kind: "control"; control: GoalControl }
  | { kind: "set"; text: string }
  | { kind: "formulate"; draft: string }
  | { kind: "error"; message: string };

const GOAL_USAGE = `/goal <text> sets a goal. /goal ${GOAL_CONTROLS.join(" | /goal ")} control it. `
  + "/goalf <draft> works one out with you first.";

/** True for any input the goal commands own, so App can route before the model sees it. */
export function isGoalCommand(text: string): boolean {
  return /^\/goalf?(?:\s|$)/.test(text.trim());
}

export function parseGoalCommand(input: string): GoalCommand | null {
  const trimmed = input.trim();
  const match = /^\/(goalf?)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const argument = (match[2] ?? "").trim();

  if (match[1] === "goalf") {
    if (!argument) return { kind: "error", message: `/goalf needs a draft goal. ${GOAL_USAGE}` };
    if (argument.length > MAX_GOAL_TEXT) {
      return { kind: "error", message: `a goal draft is at most ${MAX_GOAL_TEXT} characters` };
    }
    return { kind: "formulate", draft: argument };
  }

  if (!argument) return { kind: "error", message: `/goal needs goal text. ${GOAL_USAGE}` };

  const single = /^[a-zA-Z-]+$/.test(argument) ? argument.toLowerCase() : null;
  if (single) {
    if (GOAL_CONTROLS.includes(single as GoalControl)) {
      return { kind: "control", control: single as GoalControl };
    }
    return {
      kind: "error",
      message: `unknown /goal action "${argument}". ${GOAL_USAGE}`,
    };
  }

  if (argument.length > MAX_GOAL_TEXT) {
    return { kind: "error", message: `a goal is at most ${MAX_GOAL_TEXT} characters` };
  }
  return { kind: "set", text: argument };
}

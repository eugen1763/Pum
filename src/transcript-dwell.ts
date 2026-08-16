import type { Line } from "./transcript";

/**
 * How long a transcript row is allowed to say one thing.
 *
 * Two rules, and every row that can change shape obeys both. A row younger than
 * `YOUNG_ROW_MS` has not earned a place yet, so a tool that starts and settles
 * inside that window is never drawn in its running form at all: it appears
 * already settled and folds straight into its activity group. A row that was
 * drawn keeps the form it was drawn in for `MIN_VISIBLE_MS`, whatever the
 * canonical transcript does underneath, so nothing on screen changes faster
 * than it can be read.
 *
 * Only the form is held. Text that is meant to stream — live Bash output, a
 * growing `+3 −1` — updates in place, because holding that would stutter output
 * whose whole purpose is to arrive.
 */

/** Below this a row has not earned a place on screen. */
export const YOUNG_ROW_MS = 400;
/** Once drawn, a row keeps its form at least this long. */
export const MIN_VISIBLE_MS = 2_000;
/** A command has to be slow to be worth streaming its output. */
export const LIVE_OUTPUT_DELAY_MS = 500;

/** What a held row remembers between renders. */
export type DwellEntry = {
  /** First time the row was seen in the canonical transcript. */
  firstSeenAt: number;
  /** The form actually on screen, or undefined while the row is still too young to draw. */
  shownForm?: string;
  /** When that form was first drawn. */
  shownAt?: number;
  /** The row exactly as drawn, for rows whose parts all change together. */
  shownLine?: Line;
  /** When live output was first shown for this call. */
  outputShownAt?: number;
  /** The live output period is over and never reopens, whatever remounts. */
  outputDone?: boolean;
};

export type DwellMemory = Map<string, DwellEntry>;

export type HeldTranscript = {
  lines: Line[];
  memory: DwellMemory;
  /** When to re-evaluate, or undefined when nothing is waiting on the clock. */
  nextDeadline?: number;
};

/**
 * Rows that never change shape are not held. A text row is appended once and
 * then stands; only a tool call and a goal review are rewritten in place.
 */
export function dwellIdentity(line: Line): string | undefined {
  if (line.kind === "tool") return `tool:${line.call.id}`;
  if (line.kind === "goal-review") return `review:${line.id}`;
  return undefined;
}

/**
 * The part of a row that may not change too quickly. Arguments, details and
 * output are deliberately absent: they update live.
 */
export function dwellForm(line: Line): string {
  if (line.kind === "tool") return line.call.state;
  if (line.kind === "goal-review") return line.status;
  return "";
}

/**
 * Whether every part of a row changes at once.
 *
 * A tool row does not: its arguments, detail and output belong to the running
 * row and go on updating while the state is held. A goal review does — its
 * summary arrives with the verdict — so holding only the status would pair a
 * finished summary with the word "reviewing".
 */
function changesWholly(line: Line): boolean {
  return line.kind === "goal-review";
}

/** A row still in the form it was drawn in, so the display can keep showing it. */
function withForm(line: Line, entry: DwellEntry): Line {
  if (changesWholly(line) && entry.shownLine) return entry.shownLine;
  if (line.kind === "tool" && entry.shownForm !== undefined) {
    return { kind: "tool", call: { ...line.call, state: entry.shownForm as typeof line.call.state } };
  }
  return line;
}

/**
 * Whether a row might vanish as fast as it arrived.
 *
 * Only a tool call can: it may settle in milliseconds and fold into its group.
 * A goal review is a whole model call, so it is drawn the moment the turn
 * settles — waiting to see whether it lasts would withhold the one thing the
 * row exists to say. It still obeys the minimum-visible rule.
 */
function isTransient(line: Line): boolean {
  return line.kind === "tool" && line.call.state === "running";
}

/**
 * When the work behind a row began, which is not when the display first saw it.
 * Switching to an agent shows every row for the first time, and a call that has
 * been running for seconds by then has plainly earned its place.
 */
function startedAt(line: Line, firstSeenAt: number): number {
  if (line.kind === "tool" && line.call.startedAt !== undefined) return line.call.startedAt;
  return firstSeenAt;
}

const earlier = (a: number | undefined, b: number) => (a === undefined || b < a ? b : a);

type OutputDecision = { output: boolean; entry: DwellEntry; deadline?: number };

/**
 * Whether a call's live output may be on screen, and for how much longer.
 *
 * The period belongs to the call, not to the row component that happens to be
 * mounted: switching between agents remounts every row, and a period that
 * restarted there would replay output the user has already watched end. Once
 * it closes it stays closed.
 */
function liveOutput(line: Line, entry: DwellEntry, now: number): OutputDecision {
  if (line.kind !== "tool" || !line.call.output) return { output: false, entry };
  if (entry.outputDone) return { output: false, entry };

  const running = line.call.state === "running";
  const began = startedAt(line, entry.firstSeenAt);

  if (entry.outputShownAt === undefined) {
    // Never opened. A command that settles before the delay is over never
    // shows live output at all, so a fast command cannot flash one.
    if (!running) return { output: false, entry: { ...entry, outputDone: true } };
    if (now - began < LIVE_OUTPUT_DELAY_MS) {
      return { output: false, entry, deadline: began + LIVE_OUTPUT_DELAY_MS };
    }
    return { output: true, entry: { ...entry, outputShownAt: now } };
  }

  // Open. It stays open while the command runs, and closes once what is on
  // screen has had its time.
  if (running) return { output: true, entry };
  const closesAt = entry.outputShownAt + MIN_VISIBLE_MS;
  if (now >= closesAt) return { output: false, entry: { ...entry, outputDone: true } };
  return { output: true, entry, deadline: closesAt };
}

/** The same row with its live output withheld. */
function withoutOutput(line: Line): Line {
  if (line.kind !== "tool" || line.call.output === undefined) return line;
  const { output: _output, ...call } = line.call;
  return { kind: "tool", call };
}

/**
 * Apply both dwell rules to one transcript.
 *
 * Pure: the caller keeps `memory` between renders and re-runs this at
 * `nextDeadline`. Grouping runs afterwards, so an activity summary inherits
 * both rules from the calls it folds without knowing they exist.
 */
export function heldTranscriptLines(
  lines: readonly Line[],
  memory: DwellMemory,
  now: number,
): HeldTranscript {
  const next: DwellMemory = new Map();
  const held: Line[] = [];
  let nextDeadline: number | undefined;

  for (const line of lines) {
    const id = dwellIdentity(line);
    if (id === undefined) {
      held.push(line);
      continue;
    }

    const form = dwellForm(line);
    const previous = memory.get(id);
    const firstSeenAt = previous?.firstSeenAt ?? now;
    const base: DwellEntry = previous ?? { firstSeenAt };
    const decision = liveOutput(line, base, now);
    if (decision.deadline !== undefined) nextDeadline = earlier(nextDeadline, decision.deadline);
    const shown = decision.output ? line : withoutOutput(line);
    const carried = decision.entry;
    const entry: DwellEntry = {
      firstSeenAt,
      ...(carried.outputShownAt === undefined ? {} : { outputShownAt: carried.outputShownAt }),
      ...(carried.outputDone ? { outputDone: true } : {}),
    };

    if (previous?.shownForm === undefined) {
      // Never drawn. A row that is still settling has to outlive the young
      // window to earn a place; one that already settled has nothing to flicker
      // and is drawn at once, in its settled form.
      const began = startedAt(line, firstSeenAt);
      if (now - began < YOUNG_ROW_MS && isTransient(line)) {
        next.set(id, entry);
        nextDeadline = earlier(nextDeadline, began + YOUNG_ROW_MS);
        continue;
      }
      entry.shownForm = form;
      entry.shownAt = now;
      if (changesWholly(shown)) entry.shownLine = shown;
      next.set(id, entry);
      held.push(shown);
      continue;
    }

    // Drawn already. The canonical form is adopted only once the form on
    // screen has had its time.
    const shownAt = previous.shownAt ?? firstSeenAt;
    const remembered = changesWholly(shown) ? { shownLine: shown } : {};
    if (previous.shownForm === form) {
      next.set(id, { ...entry, ...remembered, shownForm: form, shownAt });
      held.push(shown);
      continue;
    }
    const ready = now - shownAt >= MIN_VISIBLE_MS;
    if (ready) {
      next.set(id, { ...entry, ...remembered, shownForm: form, shownAt: now });
      held.push(shown);
      continue;
    }
    const kept = withForm(shown, previous);
    next.set(id, {
      ...entry,
      shownForm: previous.shownForm,
      shownAt,
      ...(changesWholly(kept) ? { shownLine: kept } : {}),
    });
    nextDeadline = earlier(nextDeadline, shownAt + MIN_VISIBLE_MS);
    held.push(kept);
  }

  return { lines: held, memory: next, ...(nextDeadline === undefined ? {} : { nextDeadline }) };
}

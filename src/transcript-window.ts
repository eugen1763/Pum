/**
 * Which part of the transcript is mounted.
 *
 * OpenTUI paints only what the viewport covers, but it lays out every mounted
 * node on every frame, and it rebuilds the render list with them. A resumed
 * session holds thousands of rows, so mounting all of them made the cost of one
 * keystroke grow with the length of the conversation.
 *
 * The transcript therefore mounts a contiguous run that always reaches the last
 * row: rows `[start, end)` of the projected lines. Older rows join the tree when
 * the reader scrolls back to them, or when something asks to reveal one. They
 * are never dropped while the reader is above the last row, so nothing can
 * vanish from under a scroll position.
 *
 * All of this is index arithmetic on the projected lines. It is kept here, away
 * from the renderer, so the rules can be read and tested on their own.
 */

/** Rows added per step, and the smallest run kept mounted. */
export function transcriptWindowRows(terminalHeight: number): number {
  // A row is one message, one tool call, or one summary, and it occupies at
  // least one terminal row. Two terminal heights of rows therefore always
  // outgrow the viewport, however short the individual rows turn out to be.
  //
  // That factor is what stops one step back turning into all of them: a step
  // moves the reader more than one screen away from the top of the mounted run,
  // so the trigger to mount more does not fire again straight away.
  return Math.max(MIN_WINDOW_ROWS, Math.max(0, Math.floor(terminalHeight)) * 2);
}

/** Floor for a very short terminal, so scrolling back is not one row at a time. */
export const MIN_WINDOW_ROWS = 60;

/** Rows mounted before a revealed row, so it does not land against the top edge. */
export const REVEAL_MARGIN_ROWS = 20;

/** Keep a start inside the transcript. A shrunken transcript can strand one. */
export function clampWindowStart(start: number, lineCount: number): number {
  const count = Math.max(0, lineCount);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.min(Math.floor(start), count));
}

/**
 * The start to use while the reader sits at the last row.
 *
 * Exactly one window of rows, so arriving rows cannot grow the mounted run
 * without limit over a long turn, and a terminal that just got taller gets the
 * rows to fill itself. History the reader asked for is held by the floor
 * instead, which is released only on returning here.
 */
export function tailWindowStart(lineCount: number, windowRows: number): number {
  const rows = Math.max(1, Math.floor(windowRows));
  return Math.max(0, Math.max(0, lineCount) - rows);
}

/** The start after the reader scrolls back for more history. */
export function extendedWindowStart(current: number, windowRows: number): number {
  const rows = Math.max(1, Math.floor(windowRows));
  return Math.max(0, clampWindowStart(current, Number.POSITIVE_INFINITY) - rows);
}

/**
 * The start that puts `index` in the tree.
 *
 * Only ever moves the start backwards. A reveal must not unmount the rows the
 * reader already has, and a target that is mounted already needs no change.
 */
export function windowStartForRow(
  current: number,
  index: number,
  margin = REVEAL_MARGIN_ROWS,
): number {
  if (!Number.isFinite(index) || index < 0) return current;
  return Math.min(current, Math.max(0, Math.floor(index) - Math.max(0, margin)));
}

/**
 * Is the viewport within one screen of the top of the mounted run?
 *
 * The trigger to mount more history. One screen of slack means the rows are
 * there before the reader reaches the edge, rather than after it.
 */
export function nearWindowTop(scrollTop: number, viewportHeight: number): boolean {
  return scrollTop <= Math.max(1, viewportHeight);
}

/** Is the viewport at the last row? Sticky scroll holds it there while it is. */
export function atWindowBottom(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): boolean {
  // One row of tolerance: the scroll position is rounded to whole rows, and a
  // content height that just changed can leave it a row short of the end.
  return scrollTop >= Math.max(0, scrollHeight - viewportHeight) - 1;
}

/**
 * Is the viewport at the top of the mounted run?
 *
 * A reader who sends the view here has asked for what is above it. One window
 * per gesture never reaches the start of a long session, so this answers a
 * different question than `nearWindowTop` and gets a different response.
 */
export function atWindowTop(scrollTop: number): boolean {
  return scrollTop <= 0;
}

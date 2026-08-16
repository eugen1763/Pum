/**
 * Shared position bookkeeping for the atomic attachment markers the prompt
 * carries: `[Image #n]` and `[Pasted text #n]`. Both behave the same way -
 * touch any part of a marker and the whole attachment goes, along with its
 * temp file - so both go through this module rather than through two copies
 * of the same arithmetic.
 */

export type MarkedAttachment = {
  marker: string;
  start: number;
  end: number;
};

export type MarkerPrune<T> = {
  /** The draft with every broken marker fragment cut out. */
  value: string;
  /** Leftmost cut, for placing the cursor. Null when nothing was cut. */
  cursor: number | null;
  kept: T[];
  removed: T[];
};

export type MarkerReindex<T> = {
  kept: T[];
  removed: T[];
};

/** Length of the common prefix, which is where the edit began. */
function commonPrefixLength(previous: string, next: string): number {
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  ) prefix++;
  return prefix;
}

/**
 * Cut the remains of every marker the edit broke out of the running `value`.
 *
 * Pass the previous and next draft so the edit point can be located, and chain
 * calls by feeding one result's `value` and `cursor` into the next: the
 * collections share one draft, so each cut moves the ones after it.
 */
export function pruneEditedMarkers<T extends MarkedAttachment>(
  items: readonly T[],
  options: { previous: string; next: string; value: string; cursor: number | null },
): MarkerPrune<T> {
  let value = options.value;
  let cursor = options.cursor;
  const kept: T[] = [];
  const removed: T[] = [];

  for (const item of items) {
    const exactStart = value.indexOf(item.marker);
    if (exactStart >= 0) {
      kept.push(item);
      continue;
    }

    const prefix = commonPrefixLength(options.previous, options.next);
    const delta = options.next.length - options.previous.length;
    const start = Math.max(0, Math.min(value.length, Math.min(item.start, prefix)));
    const end = Math.max(start, Math.min(value.length, item.end + delta));
    value = value.slice(0, start) + value.slice(end);
    cursor = cursor === null ? start : Math.min(cursor, start);
    removed.push(item);
  }

  return { value, cursor, kept, removed };
}

/**
 * Re-anchor surviving markers against the final draft. Run this after every
 * prune, because a cut made for one collection shifts the markers of another.
 */
export function reindexMarkers<T extends MarkedAttachment>(
  items: readonly T[],
  value: string,
): MarkerReindex<T> {
  const kept: T[] = [];
  const removed: T[] = [];

  for (const item of items) {
    const start = value.indexOf(item.marker);
    if (start < 0) {
      removed.push(item);
      continue;
    }
    kept.push({ ...item, start, end: start + item.marker.length });
  }

  return { kept, removed };
}

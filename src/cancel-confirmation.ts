/** The second Escape press must arrive before this interval expires. */
export const CANCEL_WINDOW_MS = 2_000;

/** Return true only for a timely second press on the same selected agent. */
export function confirmsCancellation(
  armedAt: number | null,
  armedTarget: string | null,
  selectedTarget: string,
  now: number,
): boolean {
  if (armedAt === null || armedTarget !== selectedTarget) return false;
  const elapsed = now - armedAt;
  return elapsed >= 0 && elapsed < CANCEL_WINDOW_MS;
}

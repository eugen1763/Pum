/** Pasted text at or below this size stays inline unless it has too many lines. */
export const MAX_PASTED_TEXT_BYTES = 16 * 1024;
/** A paste with more logical lines becomes an attachment, even when it is small. */
export const MAX_PASTED_TEXT_LINES = 3;

/** True when a paste should become an in-memory `[Pasted text #n]` attachment. */
export function shouldStagePastedText(text: string): boolean {
  if (Buffer.byteLength(text, "utf8") > MAX_PASTED_TEXT_BYTES) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character !== "\n" && character !== "\r") continue;
    if (character === "\r" && text[index + 1] === "\n") index += 1;
    if (++lines > MAX_PASTED_TEXT_LINES) return true;
  }
  return false;
}

export type PendingPastedText = {
  id: number;
  marker: string;
  text: string;
  bytes: number;
  start: number;
  end: number;
};

/** Keep the payload in the draft, without filesystem or global state. */
export function stagePastedText(text: string): { text: string; bytes: number } {
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

/** Expand original marker spans once. Payloads are literal, never replacement patterns. */
export function expandPastedTexts(
  draft: string,
  items: readonly Pick<PendingPastedText, "marker" | "start" | "end" | "text">[],
): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    if (item.start < cursor || draft.slice(item.start, item.end) !== item.marker) continue;
    parts.push(draft.slice(cursor, item.start), item.text);
    cursor = item.end;
  }
  parts.push(draft.slice(cursor));
  return parts.join("");
}

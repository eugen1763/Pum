/**
 * Wrapping that breaks at spaces only.
 *
 * OpenTUI's `wrapMode="word"` also breaks after `.`, `,`, `:`, `-`, `/` and
 * `(`. In reasoning text, which is dense with file names, flags and paths,
 * that puts `auth.` and `json` on two rows, and reads as a linebreak in the
 * middle of a word. Pre-wrapped text leaves the renderer nothing to break.
 */

/** OpenTUI paints one tab as two columns, not as a jump to a tab stop. */
const TAB = "  ";

/** Columns a run of text occupies on screen. */
export function textColumns(text: string): number {
  return Bun.stringWidth(text.replaceAll("\t", TAB));
}

/**
 * Break `text` into rows of at most `width` columns, at spaces only.
 *
 * A word wider than the whole row is split, because no break point exists.
 * Existing line breaks and leading indentation are kept.
 */
export function wrapAtSpaces(text: string, width: number): string {
  if (!Number.isFinite(width) || width < 1) return text;
  const rows: string[] = [];
  for (const line of text.split("\n")) rows.push(...wrapLine(line, width));
  return rows.join("\n");
}

function wrapLine(line: string, width: number): string[] {
  if (textColumns(line) <= width) return [line];
  const rows: string[] = [];
  // Whitespace runs are kept as their own segments, so the indentation of a
  // code line survives and two words never lose the space between them.
  const segments = line.split(/(\s+)/);
  let row = "";
  let gap = "";
  const flush = () => {
    if (row.length > 0) rows.push(row);
    row = "";
    gap = "";
  };
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (/^\s+$/.test(segment)) {
      // Indentation belongs to the row it opens; a gap between two words is
      // only paid for when the following word fits on the same row.
      if (row.length === 0) row = segment;
      else gap = segment;
      continue;
    }
    if (textColumns(row + gap + segment) <= width) {
      row += gap + segment;
      gap = "";
      continue;
    }
    flush();
    if (textColumns(segment) <= width) {
      row = segment;
      continue;
    }
    const pieces = splitWord(segment, width);
    rows.push(...pieces.slice(0, -1));
    row = pieces[pieces.length - 1]!;
  }
  flush();
  return rows.length > 0 ? rows : [line];
}

/** Cut a word that cannot fit any row into row-sized pieces. */
function splitWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    if (textColumns(piece + char) > width && piece.length > 0) {
      pieces.push(piece);
      piece = "";
    }
    piece += char;
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

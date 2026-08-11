import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type NewsItem = {
  /** Stable identifier used to tag the matching transcript line. */
  id: string;
  /** The final assistant answer text of a user-initiated turn. */
  text: string;
  /** Epoch milliseconds when the answer settled. */
  at: number;
  /** True when the user marked it read with Space or viewed it. */
  read: boolean;
  /** True when the user replied to it. */
  answered: boolean;
};

/** The list never holds more than this many answers. */
export const NEWS_CAPACITY = 20;

/** Companion file next to the session JSONL: news.<sessionId>.json */
export function newsFileFor(sessionFile: string): string {
  const base = basename(sessionFile).replace(/\.jsonl?$/, "");
  return join(dirname(sessionFile), `${base}.news.json`);
}

function isNewsItem(value: unknown): value is NewsItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.text === "string" &&
    typeof item.at === "number" &&
    typeof item.read === "boolean" &&
    typeof item.answered === "boolean"
  );
}

/** Load the persisted news list for a session. Never throws. */
export function loadNewsItems(sessionFile: string | undefined): NewsItem[] {
  if (!sessionFile) return [];
  try {
    const file = newsFileFor(sessionFile);
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isNewsItem).slice(0, NEWS_CAPACITY);
  } catch {
    return [];
  }
}

/** Persist the news list atomically next to the session. Best effort only. */
export function saveNewsItems(
  sessionFile: string | undefined,
  items: readonly NewsItem[],
): void {
  if (!sessionFile) return;
  try {
    const file = newsFileFor(sessionFile);
    writeFileSync(`${file}.tmp`, JSON.stringify(items.slice(0, NEWS_CAPACITY), null, 2), "utf8");
    renameSync(`${file}.tmp`, file);
  } catch {
    // A failed news write never breaks the session.
  }
}

/**
 * Attach news identifiers to replayed assistant lines that exactly match a
 * stored answer. Each stored answer claims the first later unmatched line with
 * the same text, so resumed transcripts keep their circle/checkmark markers.
 */
export function tagNewsLines<T>(lines: readonly T[], items: readonly NewsItem[]): T[] {
  if (items.length === 0 || lines.length === 0) return lines.map((line) => line);
  const claimed = new Set<number>();
  const out = lines.map((line) => line);
  for (const item of items) {
    const maybe = (value: T) =>
      value as unknown as { kind?: unknown; role?: unknown; text?: unknown; newsId?: unknown };
    const index = out.findIndex((line, i) =>
      !claimed.has(i) &&
      maybe(line).kind === "text" &&
      maybe(line).role === "assistant" &&
      maybe(line).text === item.text,
    );
    if (index < 0) continue;
    claimed.add(index);
    out[index] = { ...(out[index] as object), newsId: item.id } as T;
  }
  return out;
}

/** Compact relative age for the popup header. */
export function formatAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

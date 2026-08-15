import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type NewsPrompt = {
  /** The user prompt or steer text that produced the answer. */
  text: string;
  /** True when the text steered an already-running turn. */
  steer: boolean;
};

export type NewsCompletion = {
  settlementId: string;
  messageId: string;
  agentId: string;
  agentName: string;
  requesterAgentId: string | null;
  requesterName: string;
  summary: string;
};

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
  /** User prompt and steers that produced this answer, oldest first. */
  prompts?: NewsPrompt[];
  /** Managed completion identity for a finish_subagent-triggered answer. */
  completion?: NewsCompletion;
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
    typeof item.answered === "boolean" &&
    (item.prompts === undefined ||
      (Array.isArray(item.prompts) &&
        item.prompts.every(
          (prompt) =>
            Boolean(prompt) &&
            typeof (prompt as Record<string, unknown>).text === "string" &&
            typeof (prompt as Record<string, unknown>).steer === "boolean",
        ))) &&
    (item.completion === undefined || isNewsCompletion(item.completion))
  );
}

function isNewsCompletion(value: unknown): value is NewsCompletion {
  if (!value || typeof value !== "object") return false;
  const completion = value as Record<string, unknown>;
  return typeof completion.settlementId === "string"
    && typeof completion.messageId === "string"
    && typeof completion.agentId === "string"
    && typeof completion.agentName === "string"
    && (completion.requesterAgentId === null || typeof completion.requesterAgentId === "string")
    && typeof completion.requesterName === "string"
    && typeof completion.summary === "string";
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

export type FinishNewsSettlement = {
  id: string;
  messageId: string;
  agentId: string;
  agentName: string;
  parentAgentId: string | null;
  requesterName: string;
  status: "idle" | "completed" | "failed";
  summary?: string;
  content: string;
  createdAt: number;
  response?: string;
};

/** Project one completed finish settlement into the persisted News model. */
export function newsItemFromFinishSettlement(
  settlement: FinishNewsSettlement,
): NewsItem | undefined {
  if (settlement.status !== "completed" || !settlement.response?.trim()) return undefined;
  if (/^(?:ack(?:nowledged)?|got it|noted|ok(?:ay)?|thanks|thank you|understood)[.!\s]*$/i.test(
    settlement.response.trim(),
  )) return undefined;
  return {
    id: `subagent-finish:${settlement.messageId}`,
    text: settlement.response.trim(),
    at: settlement.createdAt,
    read: false,
    answered: false,
    prompts: [{ text: settlement.content, steer: false }],
    completion: {
      settlementId: settlement.id,
      messageId: settlement.messageId,
      agentId: settlement.agentId,
      agentName: settlement.agentName,
      requesterAgentId: settlement.parentAgentId,
      requesterName: settlement.requesterName,
      summary: settlement.summary ?? "",
    },
  };
}

/** Upsert stable News identities while preserving local read and reply state. */
export function mergeNewsItems(
  existing: readonly NewsItem[],
  incoming: readonly NewsItem[],
): NewsItem[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    const current = byId.get(item.id);
    byId.set(item.id, current
      ? { ...item, read: current.read, answered: current.answered }
      : item);
  }
  return [...byId.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, NEWS_CAPACITY);
}

/**
 * Attach news identifiers to replayed assistant lines that exactly match a
 * stored answer. Each stored answer claims the first later unmatched line with
 * the same text, so resumed transcripts keep their circle/checkmark markers.
 */
export function tagNewsLines<T>(
  lines: readonly T[],
  items: readonly NewsItem[],
  requesterAgentId: string | null = null,
): T[] {
  if (items.length === 0 || lines.length === 0) return lines.map((line) => line);
  const claimed = new Set<number>();
  const out = lines.map((line) => line);
  for (const item of items) {
    if ((item.completion?.requesterAgentId ?? null) !== requesterAgentId) continue;
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

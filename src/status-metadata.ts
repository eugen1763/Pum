import { fg, type TextChunk } from "@opentui/core";
import type { Theme } from "./theme";

export type StatusMetadataValues = {
  cwd?: string;
  branch: string | null;
  outgoingTokens: number;
  incomingTokens: number;
  cacheReadTokens: number;
  cost: number;
  contextPct: number | null;
};

export type StatusMetadataItem = {
  key: "cwd" | "branch" | "outgoing" | "incoming" | "cacheRead" | "cost" | "context";
  text: string;
  tone: "cwd" | "branch" | "dim" | "warn";
  priority: number;
};

export const formatTokens = (value: number): string => {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
};

export const formatCost = (value: number): string =>
  `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

export const statusTextWidth = (text: string): number => Bun.stringWidth(text);

/** Show the launch directory without the long parent path. */
export function formatWorkingDirectory(cwd: string): string {
  const withoutTrailingSeparators = cwd.replace(/[\\/]+$/, "");
  if (!withoutTrailingSeparators) return "/";
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators)) return `${withoutTrailingSeparators}\\`;
  const name = withoutTrailingSeparators.split(/[\\/]/).at(-1) || withoutTrailingSeparators;
  return name;
}

export function statusMetadataItems(values: StatusMetadataValues): StatusMetadataItem[] {
  const items: StatusMetadataItem[] = [];
  if (values.cwd) {
    items.push({ key: "cwd", text: formatWorkingDirectory(values.cwd), tone: "cwd", priority: 85 });
  }
  if (values.branch) {
    items.push({ key: "branch", text: values.branch, tone: "branch", priority: 90 });
  }
  if (values.outgoingTokens) {
    items.push({
      key: "outgoing",
      text: `↑ ${formatTokens(values.outgoingTokens)}`,
      tone: "dim",
      priority: 80,
    });
  }
  if (values.incomingTokens) {
    items.push({
      key: "incoming",
      text: `↓ ${formatTokens(values.incomingTokens)}`,
      tone: "dim",
      priority: 70,
    });
  }
  if (values.cacheReadTokens) {
    items.push({
      key: "cacheRead",
      text: `↺ ${formatTokens(values.cacheReadTokens)}`,
      tone: "dim",
      priority: 50,
    });
  }
  if (values.cost) {
    items.push({ key: "cost", text: formatCost(values.cost), tone: "dim", priority: 60 });
  }
  if (values.contextPct !== null) {
    items.push({
      key: "context",
      text: `${values.contextPct}%`,
      tone: values.contextPct > 75 ? "warn" : "dim",
      priority: 100,
    });
  }
  return items;
}

export function statusMetadataWidth(items: readonly StatusMetadataItem[]): number {
  return items.reduce((width, item, index) => width + statusTextWidth(item.text) + (index ? 3 : 0), 0);
}

/** Keep the highest-priority values that fit, then restore StatusBar display order. */
export function fitStatusMetadata(
  items: readonly StatusMetadataItem[],
  maxWidth: number,
): StatusMetadataItem[] {
  if (maxWidth <= 0) return [];
  if (statusMetadataWidth(items) <= maxWidth) return [...items];

  const selected = new Set<StatusMetadataItem>();
  let used = 0;
  for (const item of [...items].sort((a, b) => b.priority - a.priority)) {
    const added = statusTextWidth(item.text) + (selected.size ? 3 : 0);
    if (used + added > maxWidth) continue;
    selected.add(item);
    used += added;
  }
  return items.filter((item) => selected.has(item));
}

export function statusMetadataChunks(
  items: readonly StatusMetadataItem[],
  theme: Theme,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const item of items) {
    if (chunks.length) chunks.push(fg(theme.dim)(" · "));
    const color = item.tone === "cwd"
      ? theme.statusCwd
      : item.tone === "branch"
        ? theme.toolArg
      : item.tone === "warn"
        ? theme.warn
        : theme.dim;
    chunks.push(fg(color)(item.text));
  }
  return chunks;
}

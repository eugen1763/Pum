export type AgentUsage = {
  tokens: number;
  cost: number;
  contextPct: number | null;
};

export const emptyAgentUsage = (): AgentUsage => ({
  tokens: 0,
  cost: 0,
  contextPct: null,
});

export function addTurnUsage(
  current: AgentUsage,
  usage: any,
  contextWindow: number | undefined,
): AgentUsage {
  if (!usage) return current;
  const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0);
  return {
    tokens: current.tokens + (usage.totalTokens ?? 0),
    cost: current.cost + (usage.cost?.total ?? 0),
    contextPct: contextWindow
      ? Math.min(100, Math.round((inputTokens / contextWindow) * 100))
      : null,
  };
}

export function usageFromEntries(
  entries: readonly any[],
  contextWindow: number | undefined,
): AgentUsage {
  let result = emptyAgentUsage();
  for (const entry of entries) {
    const usage = entry?.type === "message" && entry.message?.role === "assistant"
      ? entry.message.usage
      : (entry?.type === "compaction" || entry?.type === "branch_summary")
        ? entry.usage
        : undefined;
    if (usage) result = addTurnUsage(result, usage, contextWindow);
  }
  return result;
}

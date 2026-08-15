import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isRejectedToolResult } from "./check-mode";

export type StatsRole = "Agent" | "Check";
export type ToolOutcome = "successful" | "failed" | "blocked" | "running" | "interrupted";

export type SessionStatsModelRow = {
  model: string;
  role: StatsRole;
  attempts: number | null;
  outgoing: number | null;
  incoming: number | null;
  cacheRead: number | null;
  cost: number | null;
  compressions: number | null;
};

export type SessionStatsToolRow = Record<ToolOutcome, number> & {
  tool: string;
  total: number;
};

export type SessionStatsSnapshot = {
  models: SessionStatsModelRow[];
  tools: SessionStatsToolRow[];
  outcomes: Record<ToolOutcome, number>;
};

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tokens?: number;
  cost?: { total?: number };
};

type PersistedModelObservation = {
  model: string;
  role: StatsRole;
  attempts: number;
  outgoing: number;
  incoming: number;
  cacheRead: number;
  cost: number;
  compressions: number;
};

type PersistedAgent = {
  id: string;
  sessionFile?: string;
  initialModel: string;
  attemptsExact: boolean;
  observations: PersistedModelObservation[];
  runningTools: Array<{ id: string; tool: string }>;
  countedBranchSummaryIds: string[];
  fallback?: SessionStatsSnapshot;
};

type PersistedStats = { version: 1; agents: PersistedAgent[] };

const MAX_AGENTS = 100;
const MAX_MODELS_PER_AGENT = 64;
const MAX_RUNNING_TOOLS = 256;
const MAX_COUNTED_BRANCH_SUMMARIES = 512;

const emptyOutcomes = (): Record<ToolOutcome, number> => ({
  successful: 0,
  failed: 0,
  blocked: 0,
  running: 0,
  interrupted: 0,
});

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function modelKey(role: StatsRole, model: string): string {
  return `${role}\u0000${model}`;
}

function modelRef(value: any, fallback = "unknown"): string {
  const provider = typeof value?.provider === "string" ? value.provider : "";
  const model = typeof value?.model === "string"
    ? value.model
    : typeof value?.modelId === "string"
      ? value.modelId
      : typeof value?.id === "string"
        ? value.id
        : "";
  return provider && model ? `${provider}/${model}` : model || fallback;
}

function addUsage(row: SessionStatsModelRow, usage: UsageLike | undefined): void {
  if (!usage) {
    row.outgoing = null;
    row.incoming = null;
    row.cacheRead = null;
    row.cost = null;
    return;
  }
  if (finite(usage.tokens) !== null && finite(usage.input) === null) {
    row.outgoing = null;
    row.incoming = null;
    row.cacheRead = null;
    row.cost = typeof usage.cost === "object" && finite(usage.cost.total) !== null
      ? (row.cost ?? 0) + usage.cost.total!
      : null;
    return;
  }
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead) ?? 0;
  const cacheWrite = finite(usage.cacheWrite) ?? 0;
  const cost = finite(usage.cost?.total);
  row.outgoing = input === null || row.outgoing === null
    ? null
    : row.outgoing + input + cacheWrite;
  row.incoming = output === null || row.incoming === null ? null : row.incoming + output;
  row.cacheRead = row.cacheRead === null ? null : row.cacheRead + cacheRead;
  row.cost = cost === null || row.cost === null ? null : row.cost + cost;
}

function ensureModel(
  rows: Map<string, SessionStatsModelRow>,
  role: StatsRole,
  model: string,
): SessionStatsModelRow {
  const key = modelKey(role, model);
  let row = rows.get(key);
  if (!row) {
    row = {
      model,
      role,
      attempts: null,
      outgoing: 0,
      incoming: 0,
      cacheRead: 0,
      cost: 0,
      compressions: 0,
    };
    rows.set(key, row);
  }
  return row;
}

function toolCalls(message: any): Array<{ id: string; tool: string }> {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; tool: string }> = [];
  for (const block of message.content) {
    if (block?.type !== "toolCall" && block?.type !== "tool_call") continue;
    const id = block.id ?? block.toolCallId;
    const tool = block.name ?? block.toolName;
    if (typeof id === "string" && typeof tool === "string") calls.push({ id, tool });
  }
  return calls;
}

function policyBlockedResult(message: any): boolean {
  if (isRejectedToolResult(message, message?.toolCallId)) return true;
  const text = Array.isArray(message?.content)
    ? message.content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("")
      .trim()
    : "";
  return /^(?:Readonly Bash is blocked|Readonly Bash requires native sandbox enforcement|Sandbox policy hard block|Sandbox backend is unavailable|Sandbox enforcement is required):/i.test(text)
    || /^Readonly Bash is blocked\b/i.test(text)
    || /^Sandbox backend is unavailable\b/i.test(text);
}

export function statsFromEntries(
  entries: readonly any[],
  initialModel = "unknown",
  runningCallIds: ReadonlySet<string> = new Set(),
): SessionStatsSnapshot {
  const models = new Map<string, SessionStatsModelRow>();
  const calls = new Map<string, { tool: string; outcome: ToolOutcome }>();
  let activeModel = initialModel;

  for (const entry of entries) {
    if (entry?.type === "custom" && (entry.customType === "pum.tool_event" || entry.customType === "pum.web_search")) {
      const data = entry.data;
      const id = data?.id;
      const tool = entry.customType === "pum.web_search" ? "web_search" : data?.name;
      if (typeof id === "string" && typeof tool === "string") {
        const state = data?.state;
        const outcome: ToolOutcome = state === "ok"
          ? "successful"
          : state === "error"
            ? "failed"
            : state === "rejected"
              ? "blocked"
              : runningCallIds.has(id) ? "running" : "interrupted";
        calls.set(id, { tool, outcome });
      }
      continue;
    }
    if (entry?.type === "model_change") {
      activeModel = modelRef({ provider: entry.provider, modelId: entry.modelId }, activeModel);
      continue;
    }
    if (entry?.type === "message") {
      const message = entry.message;
      for (const call of toolCalls(message)) {
        if (!calls.has(call.id)) {
          calls.set(call.id, {
            tool: call.tool,
            outcome: runningCallIds.has(call.id) ? "running" : "interrupted",
          });
        }
      }
      if (message?.role === "assistant") {
        const model = modelRef(message, activeModel);
        activeModel = model;
        addUsage(ensureModel(models, "Agent", model), message.usage);
      } else if (message?.role === "toolResult") {
        const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
        if (call) {
          call.outcome = policyBlockedResult(message)
            ? "blocked"
            : message.isError
              ? "failed"
              : "successful";
        }
        if (message.usage) addUsage(ensureModel(models, "Agent", activeModel), message.usage);
      }
      continue;
    }
    if (entry?.type === "compaction" || entry?.type === "branch_summary") {
      const row = ensureModel(models, "Agent", activeModel);
      row.compressions = (row.compressions ?? 0) + 1;
      addUsage(row, entry.usage);
    }
  }

  const toolRows = new Map<string, SessionStatsToolRow>();
  for (const call of calls.values()) {
    let row = toolRows.get(call.tool);
    if (!row) {
      row = { tool: call.tool, ...emptyOutcomes(), total: 0 };
      toolRows.set(call.tool, row);
    }
    row[call.outcome] += 1;
    row.total += 1;
  }
  const outcomes = emptyOutcomes();
  for (const row of toolRows.values()) {
    for (const outcome of Object.keys(outcomes) as ToolOutcome[]) outcomes[outcome] += row[outcome];
  }
  return {
    models: [...models.values()],
    tools: [...toolRows.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
    outcomes,
  };
}

export function mergeSessionStats(parts: readonly SessionStatsSnapshot[]): SessionStatsSnapshot {
  const models = new Map<string, SessionStatsModelRow>();
  const tools = new Map<string, SessionStatsToolRow>();
  for (const part of parts) {
    for (const source of part.models) {
      const key = modelKey(source.role, source.model);
      const existing = models.get(key);
      if (!existing) {
        models.set(key, { ...source });
        continue;
      }
      const row = existing;
      for (const field of ["outgoing", "incoming", "cacheRead", "cost", "compressions"] as const) {
        const value = source[field];
        if (value === null) row[field] = null;
        else if (row[field] !== null) row[field] += value;
      }
      if (source.attempts === null) row.attempts = null;
      else if (row.attempts !== null) row.attempts += source.attempts;
    }
    for (const source of part.tools) {
      let row = tools.get(source.tool);
      if (!row) {
        row = { tool: source.tool, ...emptyOutcomes(), total: 0 };
        tools.set(source.tool, row);
      }
      for (const outcome of Object.keys(emptyOutcomes()) as ToolOutcome[]) row[outcome] += source[outcome];
      row.total += source.total;
    }
  }
  const outcomes = emptyOutcomes();
  for (const row of tools.values()) {
    for (const outcome of Object.keys(outcomes) as ToolOutcome[]) outcomes[outcome] += row[outcome];
  }
  return {
    models: [...models.values()].sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model)),
    tools: [...tools.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
    outcomes,
  };
}

export function chartBarWidths(
  outcomes: Record<ToolOutcome, number>,
  width: number,
): Record<ToolOutcome, number> {
  const total = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
  const result = emptyOutcomes();
  if (total <= 0 || width <= 0) return result;
  for (const outcome of Object.keys(result) as ToolOutcome[]) {
    result[outcome] = Math.min(width, Math.round((outcomes[outcome] / total) * width));
  }
  return result;
}

/** Companion file next to the main JSONL. */
export function sessionStatsFile(sessionFile: string): string {
  const base = basename(sessionFile).replace(/\.jsonl?$/, "");
  return join(dirname(sessionFile), `${base}.stats.json`);
}

function normalizePersisted(value: unknown): PersistedStats | undefined {
  if (!value || typeof value !== "object" || (value as any).version !== 1 || !Array.isArray((value as any).agents)) {
    return undefined;
  }
  const agents: PersistedAgent[] = [];
  for (const raw of (value as any).agents.slice(-MAX_AGENTS)) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.initialModel !== "string") continue;
    const observations: PersistedModelObservation[] = [];
    for (const row of (Array.isArray(raw.observations) ? raw.observations : []).slice(-MAX_MODELS_PER_AGENT)) {
      if (!row || typeof row !== "object" || typeof row.model !== "string" || !["Agent", "Check"].includes(row.role)) continue;
      observations.push({
        model: row.model,
        role: row.role,
        attempts: finite(row.attempts) ?? 0,
        outgoing: finite(row.outgoing) ?? 0,
        incoming: finite(row.incoming) ?? 0,
        cacheRead: finite(row.cacheRead) ?? 0,
        cost: finite(row.cost) ?? 0,
        compressions: finite(row.compressions) ?? 0,
      });
    }
    const runningTools = (Array.isArray(raw.runningTools) ? raw.runningTools : [])
      .filter((tool: any) => tool && typeof tool.id === "string" && typeof tool.tool === "string")
      .slice(-MAX_RUNNING_TOOLS)
      .map((tool: any) => ({ id: tool.id, tool: tool.tool }));
    agents.push({
      id: raw.id,
      initialModel: raw.initialModel,
      attemptsExact: raw.attemptsExact === true,
      observations,
      runningTools,
      countedBranchSummaryIds: (Array.isArray(raw.countedBranchSummaryIds) ? raw.countedBranchSummaryIds : [])
        .filter((id: unknown): id is string => typeof id === "string")
        .slice(-MAX_COUNTED_BRANCH_SUMMARIES),
      ...(typeof raw.sessionFile === "string" ? { sessionFile: raw.sessionFile } : {}),
      ...(raw.fallback && typeof raw.fallback === "object"
        ? { fallback: normalizeSnapshot(raw.fallback) }
        : {}),
    });
  }
  return { version: 1, agents };
}

function normalizeSnapshot(raw: any): SessionStatsSnapshot {
  const tools = (Array.isArray(raw?.tools) ? raw.tools : []).map((row: any) => ({
    tool: typeof row?.tool === "string" ? row.tool : "unknown",
    successful: finite(row?.successful) ?? 0,
    failed: finite(row?.failed) ?? 0,
    blocked: finite(row?.blocked) ?? 0,
    running: finite(row?.running) ?? 0,
    interrupted: (finite(row?.interrupted) ?? 0) + (finite(row?.runningInterrupted) ?? 0),
    total: finite(row?.total) ?? 0,
  }));
  return {
    models: Array.isArray(raw?.models) ? raw.models : [],
    tools,
    outcomes: {
      successful: finite(raw?.outcomes?.successful) ?? 0,
      failed: finite(raw?.outcomes?.failed) ?? 0,
      blocked: finite(raw?.outcomes?.blocked) ?? 0,
      running: finite(raw?.outcomes?.running) ?? 0,
      interrupted: (finite(raw?.outcomes?.interrupted) ?? 0)
        + (finite(raw?.outcomes?.runningInterrupted) ?? 0),
    },
  };
}

function readEntries(path: string | undefined): any[] | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return undefined;
  }
}

function observationSnapshot(agent: PersistedAgent): SessionStatsSnapshot {
  const tools = agent.runningTools.map(({ id, tool }) => ({
    tool,
    ...emptyOutcomes(),
    [id.startsWith("interrupted:") ? "interrupted" : "running"]: 1,
    total: 1,
  }));
  const outcomes = emptyOutcomes();
  for (const row of tools) {
    outcomes.running += row.running;
    outcomes.interrupted += row.interrupted;
  }
  return {
    models: agent.observations.map((row) => ({ ...row })),
    tools,
    outcomes,
  };
}

function entryToolCallIds(entries: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    for (const call of toolCalls(entry.message)) ids.add(call.id);
  }
  return ids;
}

function hasHistoricalRequests(entries: readonly any[]): boolean {
  return entries.some((entry) => (
    (entry?.type === "message" && entry.message?.role === "assistant")
    || entry?.type === "compaction"
    || entry?.type === "branch_summary"
  ));
}

function boundedSnapshot(snapshot: SessionStatsSnapshot): SessionStatsSnapshot {
  const models = snapshot.models.slice(0, MAX_MODELS_PER_AGENT);
  const tools = snapshot.tools.slice(0, 128);
  const outcomes = emptyOutcomes();
  for (const row of tools) {
    for (const outcome of Object.keys(outcomes) as ToolOutcome[]) outcomes[outcome] += row[outcome];
  }
  return { models, tools, outcomes };
}

export type CheckStatsObservation = {
  agentId: string | null;
  model: string;
  usage?: UsageLike;
};

/** Coalescing window for stats writes. Long enough to swallow a tool burst. */
const PERSIST_DEBOUNCE_MS = 250;

/** Managers holding a queued write, flushed together when the process exits. */
const pendingManagers = new Set<SessionStatsManager>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const manager of [...pendingManagers]) manager.flush();
  });
}

/** Cheap identity for a session file, so an unchanged agent is not re-read. */
function fileStamp(path: string | undefined): string {
  if (!path) return "none";
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

export class SessionStatsManager {
  private mainSessionFile?: string;
  private data: PersistedStats = { version: 1, agents: [] };
  private sessions = new Map<string, AgentSession>();
  private unsubscribers = new Map<string, () => void>();
  private listeners = new Set<() => void>();
  private snapshotCache = new Map<string, { key: string; snapshot: SessionStatsSnapshot }>();
  private agentRevisions = new Map<string, number>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistPending = false;

  /** Invalidate the cached snapshot of one agent after its data changed. */
  private touch(agentId: string): void {
    this.agentRevisions.set(agentId, (this.agentRevisions.get(agentId) ?? 0) + 1);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  prepareMainSession(sessionFile: string | undefined): void {
    if (this.mainSessionFile === sessionFile) return;
    // Anything queued belongs to the session being left behind.
    this.flush();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.sessions.clear();
    this.snapshotCache.clear();
    this.agentRevisions.clear();
    this.mainSessionFile = sessionFile;
    this.data = { version: 1, agents: [] };
    if (this.mainSessionFile) {
      try {
        const file = sessionStatsFile(this.mainSessionFile);
        if (existsSync(file)) {
          const parsed = normalizePersisted(JSON.parse(readFileSync(file, "utf8")));
          if (parsed) {
            this.data = parsed;
          }
        }
      } catch {
        this.data = { version: 1, agents: [] };
      }
    }
  }

  bindMainSession(session: AgentSession): void {
    if (this.mainSessionFile !== session.sessionFile) this.prepareMainSession(session.sessionFile);
    const retained = this.data.agents.some((agent) => agent.id === "main");
    this.attach("main", session, modelRef(session.agent.state.model), retained);
  }

  attach(agentId: string, session: AgentSession, initialModel?: string, retained = false): void {
    this.unsubscribers.get(agentId)?.();
    this.sessions.set(agentId, session);
    const entries = ((session.sessionManager as any).getEntries?.() ?? []) as any[];
    const agent = this.ensureAgent(
      agentId,
      initialModel ?? modelRef(session.agent.state.model),
      retained || !hasHistoricalRequests(entries),
    );
    agent.sessionFile = session.sessionFile;
    for (const tool of agent.runningTools) {
      tool.id = `interrupted:${tool.id}`;
    }
    const unsubscribe = session.subscribe((event: any) => this.observeAgentEvent(agentId, session, event));
    this.unsubscribers.set(agentId, unsubscribe);
    this.touch(agentId);
    this.schedulePersist();
    this.emit();
  }

  registerAgentFile(agentId: string, sessionFile: string, initialModel: string): void {
    const entries = readEntries(sessionFile) ?? [];
    const agent = this.ensureAgent(agentId, initialModel, !hasHistoricalRequests(entries));
    agent.sessionFile = sessionFile;
    this.touch(agentId);
    this.schedulePersist();
    this.emit();
  }

  detach(agentId: string): void {
    this.unsubscribers.get(agentId)?.();
    this.unsubscribers.delete(agentId);
    this.sessions.delete(agentId);
  }

  closeAgent(agentId: string): void {
    const agent = this.data.agents.find((item) => item.id === agentId);
    if (!agent) return;
    const entries = readEntries(agent.sessionFile);
    if (entries) agent.fallback = boundedSnapshot(this.snapshotForAgent(agent, entries, false));
    agent.runningTools = [];
    this.detach(agentId);
    this.touch(agentId);
    this.schedulePersist();
    this.emit();
  }

  observeCheck(observation: CheckStatsObservation): void {
    const agent = this.ensureAgent(observation.agentId ?? "main", observation.model);
    const row = this.ensureObservation(agent, "Check", observation.model);
    row.attempts += 1;
    if (observation.usage) {
      row.outgoing += (observation.usage.input ?? 0) + (observation.usage.cacheWrite ?? 0);
      row.incoming += observation.usage.output ?? 0;
      row.cacheRead += observation.usage.cacheRead ?? 0;
      row.cost += observation.usage.cost?.total ?? 0;
    }
    this.schedulePersist();
    this.emit();
  }

  private observeAgentEvent(agentId: string, session: AgentSession, event: any): void {
    const agent = this.ensureAgent(agentId, modelRef(session.agent.state.model));
    const activeModel = modelRef(session.agent.state.model, agent.initialModel);
    let changed = true;
    if (event.type === "turn_start" || event.type === "auto_retry_start") {
      this.ensureObservation(agent, "Agent", activeModel).attempts += 1;
    } else if (event.type === "compaction_start") {
      const row = this.ensureObservation(agent, "Agent", activeModel);
      row.attempts += 1;
    } else if (event.type === "compaction_end" && event.result && !event.aborted) {
      this.ensureObservation(agent, "Agent", activeModel).compressions += 1;
    } else if (event.type === "summarization_retry_attempt_start") {
      this.ensureObservation(agent, "Agent", activeModel).attempts += 1;
    } else if (event.type === "entry_appended" && this.countBranchSummaryAttempt(agent, event.entry, activeModel)) {
      // countBranchSummaryAttempt mutates the active model row and stable-id set.
    } else if (event.type === "tool_execution_start") {
      if (!agent.runningTools.some((tool) => tool.id === event.toolCallId)) {
        agent.runningTools.push({ id: event.toolCallId, tool: event.toolName });
        agent.runningTools = agent.runningTools.slice(-MAX_RUNNING_TOOLS);
      }
    } else if (event.type === "tool_execution_end") {
      agent.runningTools = agent.runningTools.filter((tool) => tool.id !== event.toolCallId);
    } else {
      changed = false;
    }
    if (!changed) return;
    this.touch(agentId);
    this.schedulePersist();
    this.emit();
  }

  snapshot(): SessionStatsSnapshot {
    const parts: SessionStatsSnapshot[] = [];
    for (const agent of this.data.agents) parts.push(this.agentSnapshot(agent));
    return mergeSessionStats(parts);
  }

  /**
   * One agent's contribution, reused while nothing about it has changed. The
   * key is cheap on purpose: a revision the mutating paths bump, plus the entry
   * count of a live session or the size and mtime of a stored one. An
   * unattached agent is not even read from disk until its file moves.
   */
  private agentSnapshot(agent: PersistedAgent): SessionStatsSnapshot {
    const session = this.sessions.get(agent.id);
    const manager = session?.sessionManager as any;
    const live = manager?.getEntries?.() as any[] | undefined;
    const source = live ? `live:${live.length}` : `file:${fileStamp(agent.sessionFile)}`;
    const cached = this.snapshotCache.get(agent.id);
    const key = `${this.agentRevisions.get(agent.id) ?? 0}:${source}`;
    if (cached?.key === key) return cached.snapshot;
    const entries = live ?? readEntries(agent.sessionFile);
    const snapshot = entries
      ? this.snapshotForAgent(agent, entries, true)
      : agent.fallback ?? observationSnapshot(agent);
    // snapshotForAgent can reconcile branch summaries and bump the revision,
    // so key on what it left behind or the next read misses again.
    this.snapshotCache.set(agent.id, {
      key: `${this.agentRevisions.get(agent.id) ?? 0}:${source}`,
      snapshot,
    });
    return snapshot;
  }

  private snapshotForAgent(
    agent: PersistedAgent,
    entries: readonly any[],
    includeRunning: boolean,
  ): SessionStatsSnapshot {
    this.reconcileBranchSummaryAttempts(agent, entries);
    const activeRunningIds = new Set(agent.runningTools
      .filter((tool) => !tool.id.startsWith("interrupted:"))
      .map((tool) => tool.id));
    const legacy = statsFromEntries(entries, agent.initialModel, activeRunningIds);
    const persistedCallIds = entryToolCallIds(entries);
    const observations = observationSnapshot({
      ...agent,
      runningTools: includeRunning ? agent.runningTools.filter((tool) => (
        !tool.id.startsWith("interrupted:") && !persistedCallIds.has(tool.id)
      )) : [],
    });
    const interrupted = agent.runningTools.filter((tool) => (
      tool.id.startsWith("interrupted:")
      && !persistedCallIds.has(tool.id.replace(/^(?:interrupted:)+/, ""))
    ));
    if (includeRunning && interrupted.length) {
      observations.tools.push(...interrupted.map(({ tool }) => ({
        tool, ...emptyOutcomes(), interrupted: 1, total: 1,
      })));
    }
    const combined = mergeSessionStats([legacy, observations]);
    for (const row of combined.models) {
      const observed = agent.observations.find((item) => item.role === row.role && item.model === row.model);
      if (row.role === "Agent") {
        row.attempts = agent.attemptsExact && observed ? observed.attempts : null;
        const legacyRow = legacy.models.find((item) => item.role === "Agent" && item.model === row.model);
        row.compressions = legacyRow?.compressions ?? row.compressions;
      }
    }
    return combined;
  }

  private ensureAgent(id: string, initialModel: string, attemptsExact = true): PersistedAgent {
    let agent = this.data.agents.find((item) => item.id === id);
    if (!agent) {
      agent = {
        id,
        initialModel,
        attemptsExact,
        observations: [],
        runningTools: [],
        countedBranchSummaryIds: [],
      };
      this.data.agents.push(agent);
      this.data.agents = this.data.agents.slice(-MAX_AGENTS);
      this.touch(id);
    } else if (agent.attemptsExact !== true) {
      agent.attemptsExact = false;
    }
    return agent;
  }

  private reconcileBranchSummaryAttempts(agent: PersistedAgent, entries: readonly any[]): void {
    let activeModel = agent.initialModel;
    let changed = false;
    for (const entry of entries) {
      if (entry?.type === "model_change") {
        activeModel = modelRef({ provider: entry.provider, modelId: entry.modelId }, activeModel);
        continue;
      }
      if (entry?.type === "message" && entry.message?.role === "assistant") {
        activeModel = modelRef(entry.message, activeModel);
        continue;
      }
      if (this.countBranchSummaryAttempt(agent, entry, activeModel)) changed = true;
    }
    if (!changed) return;
    // snapshot() runs inside a React render. Queue the write, never do it here.
    this.schedulePersist();
  }

  private countBranchSummaryAttempt(agent: PersistedAgent, entry: any, activeModel: string): boolean {
    if (entry?.type !== "branch_summary" || entry.fromHook === true || !entry.usage || typeof entry.id !== "string") {
      return false;
    }
    if (agent.countedBranchSummaryIds.includes(entry.id)) return false;
    this.touch(agent.id);
    agent.countedBranchSummaryIds.push(entry.id);
    agent.countedBranchSummaryIds = agent.countedBranchSummaryIds.slice(-MAX_COUNTED_BRANCH_SUMMARIES);
    if (agent.attemptsExact) this.ensureObservation(agent, "Agent", activeModel).attempts += 1;
    return true;
  }

  private ensureObservation(agent: PersistedAgent, role: StatsRole, model: string): PersistedModelObservation {
    // Every caller mutates the row it gets back, so the cached snapshot of this
    // agent is stale from here on.
    this.touch(agent.id);
    let row = agent.observations.find((item) => item.role === role && item.model === model);
    if (!row) {
      row = { model, role, attempts: 0, outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, compressions: 0 };
      agent.observations.push(row);
      agent.observations = agent.observations.slice(-MAX_MODELS_PER_AGENT);
    }
    return row;
  }

  /**
   * Queue a stats write. Serializing and writing the whole file on every tool
   * event costs more than the metrics are worth, so writes coalesce and land
   * once the burst settles. flush() covers exit, and an exit hook covers a
   * crash, so nothing queued is lost.
   */
  private schedulePersist(): void {
    if (!this.mainSessionFile) return;
    this.persistPending = true;
    pendingManagers.add(this);
    installExitHook();
    if (this.persistTimer) return;
    const timer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    this.persistTimer = timer;
  }

  /** Write a queued stats update now. Safe to call at any time. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.persistPending) return;
    this.persistPending = false;
    pendingManagers.delete(this);
    this.persist();
  }

  /** Stop observing sessions and write anything still queued. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.sessions.clear();
    this.flush();
  }

  private persist(): void {
    if (!this.mainSessionFile) return;
    try {
      const file = sessionStatsFile(this.mainSessionFile);
      // pid and time keep two PUM processes on one session from interleaving
      // write and rename and losing an update.
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, JSON.stringify(this.data), "utf8");
      renameSync(temp, file);
    } catch {
      // UI-only metrics must never break an agent turn.
    }
  }
}

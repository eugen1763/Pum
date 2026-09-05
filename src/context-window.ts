import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateTokens,
  sessionEntryToContextMessages,
  type AgentSession,
  type ExtensionAPI,
  type InlineExtension,
  type SessionEntry,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { registerTranscriptHistoryTool } from "./transcript-history";
import { CONTEXT_GUIDANCE } from "./context-guidance";

export const CONTEXT_TOOL_NAMES = ["history", "get_context_remaining", "new_context"] as const;
export const CONTEXT_WINDOW_CUSTOM_TYPE = "pum.context_window";
export const CONTEXT_HANDOFF_MAX_CHARS = 20_000;

interface BoundaryData { version: 1; handoff?: string }
interface Pending { id: string; handoff?: string; signal?: AbortSignal; duplicate: boolean }
interface PromptSnapshot { systemPrompt: string; tools: string; modelKey?: string }
interface RequestSnapshot extends PromptSnapshot {
  windowId: string | null;
  stateSystemPrompt: string;
  stateTools: string;
  injectedTokens: number;
}
const MANUAL_COMPACTION_REFUSAL = "Manual /compress is unavailable after a PUM context rollover on the active branch. Use new_context instead. The full transcript is retained.";
function modelIdentity(model: AgentSession["model"]): string | undefined {
  return model ? `${model.provider}/${model.id}:${model.contextWindow}` : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function handoffParams(value: unknown): { handoff?: string } {
  if (!object(value) || Object.keys(value).some((key) => key !== "handoff")
    || (value.handoff !== undefined && (typeof value.handoff !== "string" || value.handoff.length > CONTEXT_HANDOFF_MAX_CHARS))) {
    throw new Error(`new_context accepts only an optional literal handoff of at most ${CONTEXT_HANDOFF_MAX_CHARS} characters.`);
  }
  return value as { handoff?: string };
}
function boundaryData(value: unknown): BoundaryData {
  if (!object(value) || value.version !== 1 || Object.keys(value).some((key) => key !== "version" && key !== "handoff")) {
    throw new Error("Invalid PUM context-window boundary. Refusing to restore older context.");
  }
  const { handoff } = handoffParams({ handoff: value.handoff });
  return { version: 1, ...(handoff === undefined ? {} : { handoff }) };
}
function header(id: string, handoff?: string, navigation?: { userId?: string; previousId?: string | null }): AgentMessage {
  return {
    role: "custom", customType: CONTEXT_WINDOW_CUSTOM_TYPE, display: false, timestamp: 0,
    content: `Fresh PUM context window: ${id}. Earlier transcript entries remain available through history. The rollover generated no summary. Restore project memory and the session todo list with the available tools. Recover exact user instructions and relevant results with history before continuing. Current system instructions still apply.`
      + (navigation ? `\nHistory navigation: latest prior user entry ID: ${navigation.userId ?? "none"}; previous transcript entry ID: ${navigation.previousId ?? "none"}. Use history with op "read" and entryId, then follow parentId links to recover exact earlier instructions.` : "")
      + (handoff === undefined ? "" : `\n\nLiteral handoff supplied to new_context:\n${handoff}`),
  };
}
function isBoundary(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === CONTEXT_WINDOW_CUSTOM_TYPE;
}
const textResult = (details: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details,
});

/** One instance belongs to one runtime. Only public SDK state and hooks are used. */
export class ContextWindowController {
  private session?: AgentSession;
  private pending?: Pending;
  private refreshPending = false;
  private windowId: string | null = null;
  private observedExtraTokens = 0;
  private modelKey?: string;
  private usageFloor = 0;
  private preparedPrompt?: PromptSnapshot;
  private requestSnapshot?: RequestSnapshot;
  private usageSnapshots = new WeakMap<AgentMessage, RequestSnapshot>();

  extension(): InlineExtension {
    return { name: "pum-context-window", factory: (pi: ExtensionAPI) => {
      registerTranscriptHistoryTool(pi, () => {
        const meter = this.remaining();
        if (meter.reserveExceedsCapacity === true && typeof meter.remainingTokens === "number") {
          const model = this.requireSession().model!;
          return Math.max(0, meter.remainingTokens - Math.min(model.maxTokens, Math.floor(model.contextWindow / 4)));
        }
        return typeof meter.remainingBeforeReserve === "number" && typeof meter.remainingTokens === "number"
          ? Math.min(meter.remainingBeforeReserve, meter.remainingTokens) : undefined;
      });
      pi.on("session_start", () => { this.disableAutomaticCompaction(); this.restore(); });
      pi.on("session_tree", () => { this.pending = undefined; this.restore(); });
      pi.on("model_select", (event) => {
        const key = modelIdentity(event.model);
        if (key !== this.modelKey) {
          this.modelKey = key;
          this.usageFloor = this.session?.agent.state.messages.length ?? 0;
        }
      });
      pi.on("before_agent_start", (event) => {
        this.disableAutomaticCompaction();
        return { systemPrompt: `${event.systemPrompt}\n\n${CONTEXT_GUIDANCE}` };
      });
      // Defense for callers that retained the original compact method. The
      // public wrapper below is the primary guard: this hook runs after preflight.
      pi.on("session_before_compact", (event) => event.reason === "manual"
        && !this.hasActiveBoundary() ? undefined : { cancel: true });
      pi.on("session_compact", () => { this.restore(); });
      pi.on("turn_end", (event, ctx) => this.endTurn(event, ctx.signal));
      pi.on("agent_end", () => { this.pending = undefined; });
      pi.on("session_shutdown", () => { this.pending = undefined; });
      pi.registerTool({
        name: "get_context_remaining", label: "Context Remaining",
        description: "Report active-window capacity for the current model, including the configured reserve. Counts are estimates, not an automatic rollover threshold.",
        parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential",
        execute: async (_id, params) => {
          if (!object(params) || Object.keys(params).length) throw new Error("get_context_remaining accepts no arguments.");
          return textResult(this.remaining());
        },
      });
      pi.registerTool({
        name: "new_context", label: "New Context",
        description: "Queue an explicit fresh model context without summarization. Preserve all transcript entries. Commit only after the complete successful tool batch. Optional handoff is literal text.",
        parameters: Type.Object({ handoff: Type.Optional(Type.String({ maxLength: CONTEXT_HANDOFF_MAX_CHARS })) }, { additionalProperties: false }),
        executionMode: "sequential",
        execute: async (id, params, signal) => {
          // Even an invalid second invocation must invalidate the first request.
          if (this.pending) this.pending.duplicate = true;
          const { handoff } = handoffParams(params);
          this.requireSession();
          if (signal?.aborted) throw new Error("Context rollover was cancelled.");
          if (this.pending) throw new Error("Only one new_context call is allowed in a tool batch. Rollover cancelled.");
          this.validateFreshCapacity(handoff);
          this.pending = { id, handoff, signal, duplicate: false };
          return textResult({ queued: true, message: "Fresh context will begin after this complete tool batch succeeds. History will remain intact." });
        },
      });
    } };
  }

  bind(session: AgentSession): void {
    if (this.session) {
      if (this.session === session) return;
      throw new Error("A context-window controller cannot be shared across runtimes.");
    }
    this.session = session;
    const compact = session.compact;
    session.compact = async (...args) => {
      // Native compact reads the full branch and cannot see the synthetic
      // handoff. Refuse before it aborts work, authenticates, or prepares a summary.
      if (this.hasActiveBoundary()) throw new Error(MANUAL_COMPACTION_REFUSAL);
      return compact.apply(session, args);
    };
    session.agent.subscribe((event) => {
      if (event.type === "agent_start") {
        this.preparedPrompt = undefined;
        this.requestSnapshot = undefined;
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (this.requestSnapshot) this.usageSnapshots.set(event.message, this.requestSnapshot);
        this.requestSnapshot = undefined;
      }
    });
    // Reload and unrelated settings saves replace effective overrides. Native
    // preflight runs before before_agent_start, so keep these public, per-runtime
    // accessors disabled as well. Neither accessor writes saved defaults.
    const getCompactionSettings = session.settingsManager.getCompactionSettings;
    session.settingsManager.getCompactionSettings = () => ({
      ...getCompactionSettings.call(session.settingsManager), enabled: false,
    });
    session.settingsManager.getCompactionEnabled = () => false;
    this.disableAutomaticCompaction();
    this.restore();
    const transform = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      const originalTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const stateSystemPrompt = session.agent.state.systemPrompt;
      const stateTools = this.toolSchemas();
      const prompt = this.preparedPrompt ?? { systemPrompt: stateSystemPrompt, tools: stateTools, modelKey: modelIdentity(session.model) };
      this.requestSnapshot = undefined;
      const transformed = transform ? await transform.call(session.agent, messages, signal) : messages;
      // Observe the complete extension chain, including memory injected after our
      // extension. Return it unchanged; memory and dynamic instructions stay active.
      this.observedExtraTokens = Math.max(0, transformed.reduce((sum, message) => sum + estimateTokens(message), 0)
        - originalTokens);
      this.requestSnapshot = { ...prompt, windowId: this.windowId, stateSystemPrompt, stateTools,
        injectedTokens: this.observedExtraTokens };
      return transformed;
    };
    const previous = session.agent.prepareNextTurnWithContext;
    const legacy = session.agent.prepareNextTurn;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      this.disableAutomaticCompaction();
      const fresh = this.refreshPending;
      this.refreshPending = false;
      const input = fresh ? { ...turn, context: { ...turn.context, messages: session.agent.state.messages.slice() } } : turn;
      const update = previous ? await previous.call(session.agent, input, signal) : await legacy?.call(session.agent, signal);
      const context = update?.context ?? input.context;
      this.preparedPrompt = { systemPrompt: context.systemPrompt, tools: this.toolSchemas(context.tools),
        modelKey: modelIdentity(update?.model ?? session.model) };
      return fresh ? { ...update, context } : update;
    };
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Context-window runtime is not bound.");
    return this.session;
  }
  private hasActiveBoundary(): boolean {
    return this.session?.sessionManager.getBranch().some(isBoundary) ?? false;
  }
  private disableAutomaticCompaction(): void {
    this.session?.settingsManager.applyOverrides({ compaction: { enabled: false } });
  }
  private restore(): void {
    const session = this.session;
    if (!session) return;
    const branch = session.sessionManager.getBranch();
    const index = branch.findLastIndex(isBoundary);
    this.windowId = index < 0 ? null : branch[index]!.id;
    this.usageFloor = 0;
    this.modelKey = modelIdentity(session.model);
    this.requestSnapshot = undefined;
    this.preparedPrompt = undefined;
    this.usageSnapshots = new WeakMap();
    if (index < 0) { this.restoreUsageFloor(branch); return; }
    const boundary = branch[index]!;
    if (boundary.type !== "custom") return;
    let data: BoundaryData;
    try { data = boundaryData(boundary.data); }
    catch (error) {
      // A tree-event handler can fail after pi has restored unfiltered messages.
      // Leave no old-window messages available even if its caller catches errors.
      session.agent.state.messages = [];
      this.refreshPending = true;
      throw error;
    }
    // Legacy sessions can contain a later compaction. Filter its kept entries
    // at the boundary, but never discard the boundary's literal handoff.
    const activeIds = new Set(branch.slice(index + 1).map((entry) => entry.id));
    const entries = session.sessionManager.buildContextEntries().filter((entry) => activeIds.has(entry.id));
    const latestUser = branch.slice(0, index).findLast((entry) => entry.type === "message" && entry.message.role === "user");
    session.agent.state.messages = [header(boundary.id, data.handoff, {
      userId: latestUser?.id, previousId: boundary.parentId,
    }), ...entries.flatMap(sessionEntryToContextMessages)];
    this.restoreUsageFloor(branch);
    this.refreshPending = true;
  }
  private restoreUsageFloor(branch: SessionEntry[]): void {
    const change = branch.findLastIndex((entry) => entry.type === "model_change" || entry.type === "compaction");
    if (change < 0) return;
    // SessionManager projections retain message objects. Include a structural
    // identity fallback for runtimes that copy their state on restoration.
    const older = new Set(branch.slice(0, change).filter((entry) => entry.type === "message")
      .map((entry) => JSON.stringify(entry.message)));
    const messages = this.requireSession().agent.state.messages;
    for (let index = 0; index < messages.length; index++) {
      if (older.has(JSON.stringify(messages[index]))) this.usageFloor = index + 1;
    }
  }
  private endTurn(event: TurnEndEvent, signal?: AbortSignal): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.duplicate || pending.signal?.aborted || signal?.aborted) return;
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length") return;
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (calls.filter((call) => call.name === "new_context").length !== 1
      || !calls.some((call) => call.id === pending.id && call.name === "new_context")
      || calls.length !== event.toolResults.length || new Set(calls.map((call) => call.id)).size !== calls.length
      || event.toolResults.some((result) => result.isError)
      || calls.some((call) => event.toolResults.filter((result) => result.toolCallId === call.id && result.toolName === call.name).length !== 1)) return;
    const session = this.requireSession();
    // The user can select another model while a sibling tool is running.
    this.validateFreshCapacity(pending.handoff);
    const previousLeaf = session.sessionManager.getLeafId();
    try {
      session.sessionManager.appendCustomEntry(CONTEXT_WINDOW_CUSTOM_TYPE, {
        version: 1, ...(pending.handoff === undefined ? {} : { handoff: pending.handoff }),
      });
    } catch (error) {
      // pi updates its in-memory tree before writing the entry. Leave a failed
      // append off the active branch; never prune messages after a failed write.
      if (previousLeaf === null) session.sessionManager.resetLeaf();
      else session.sessionManager.branch(previousLeaf);
      throw error;
    }
    this.restore();
  }
  private validateFreshCapacity(handoff?: string): void {
    const session = this.requireSession();
    const model = session.model;
    const capacity = model?.contextWindow;
    const branch = session.sessionManager.getBranch();
    const latestUser = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
    const freshTokens = estimateTokens(header("pending", handoff, {
      userId: latestUser?.id, previousId: session.sessionManager.getLeafId(),
    })) + this.overheadTokens();
    const configuredReserve = this.reserveTokens();
    // A default reserve can exceed a small model's entire window. It is not an
    // automatic threshold; use bounded output headroom for explicit rollover.
    const reserve = capacity && configuredReserve >= capacity
      ? Math.min(model?.maxTokens ?? 0, Math.floor(capacity / 4)) : configuredReserve;
    if (!capacity || !Number.isFinite(capacity) || freshTokens >= Math.max(0, capacity - reserve)) {
      throw new Error("The handoff and prompt overhead do not fit the current model's fresh context with response headroom.");
    }
  }
  private reserveTokens(): number {
    const reserve = this.requireSession().settingsManager.getCompactionSettings().reserveTokens;
    return Number.isFinite(reserve) ? Math.max(0, reserve) : 0;
  }
  private toolSchemas(tools = this.requireSession().agent.state.tools): string {
    return JSON.stringify(tools.map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    })));
  }
  private overheadTokens(): number {
    const state = this.requireSession().agent.state;
    return Math.ceil((state.systemPrompt.length + this.toolSchemas().length) / 4) + this.observedExtraTokens;
  }
  private overheadGrowth(snapshot: RequestSnapshot): number {
    const state = this.requireSession().agent.state;
    // A public next-turn hook can supply a request prompt different from state.
    // Keep that effective baseline until state actually changes. Never subtract
    // estimated shrinkage from measured provider usage or offset tool growth.
    const prompt = state.systemPrompt === snapshot.stateSystemPrompt ? snapshot.systemPrompt : state.systemPrompt;
    const stateTools = this.toolSchemas();
    const tools = stateTools === snapshot.stateTools ? snapshot.tools : stateTools;
    return Math.ceil(Math.max(0, prompt.length - snapshot.systemPrompt.length) / 4)
      + Math.ceil(Math.max(0, tools.length - snapshot.tools.length) / 4)
      + Math.max(0, this.observedExtraTokens - snapshot.injectedTokens);
  }
  private remaining(): Record<string, unknown> {
    const session = this.requireSession();
    const model = session.model;
    const messages = session.agent.state.messages;
    const key = modelIdentity(model);
    if (key !== this.modelKey) { this.modelKey = key; this.usageFloor = messages.length; }
    let usageIndex = -1;
    let usageTokens = 0;
    let usageSnapshot: RequestSnapshot | undefined;
    for (let index = messages.length - 1; index >= this.usageFloor; index--) {
      const message = messages[index]!;
      if (message.role !== "assistant") continue;
      // Never reuse an older model's meter, including a switch back to a prior model.
      if (message.provider !== model?.provider || message.model !== model?.id) break;
      const snapshot = this.usageSnapshots.get(message);
      // A restored usage count has no trustworthy prompt/schema baseline.
      if (!snapshot || snapshot.modelKey !== key || snapshot.windowId !== this.windowId) continue;
      const usage = message.usage;
      if (!usage || typeof usage !== "object") continue;
      const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
      if (message.stopReason !== "error" && message.stopReason !== "aborted"
        && values.every((value) => Number.isFinite(value) && value >= 0)) {
        const components = values.reduce((sum, value) => sum + value, 0);
        const total = Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : 0;
        if (Math.max(components, total) > 0) {
          usageTokens = Math.max(components, total); usageIndex = index; usageSnapshot = snapshot; break;
        }
      }
    }
    const trailing = messages.slice(usageIndex + 1).reduce((sum, message) => sum + estimateTokens(message), 0);
    const overhead = usageSnapshot ? this.overheadGrowth(usageSnapshot) : this.overheadTokens();
    const used = Math.ceil(usageTokens + trailing + overhead);
    const capacity = model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
    const reserve = this.reserveTokens();
    return {
      windowId: this.windowId, model: model ? `${model.provider}/${model.id}` : null, contextWindow: capacity,
      usedTokens: used, remainingTokens: capacity === null ? null : Math.max(0, capacity - used),
      reserveTokens: reserve, reserveExceedsCapacity: capacity === null ? null : reserve >= capacity,
      remainingBeforeReserve: capacity === null ? null : Math.max(0, capacity - reserve - used),
      source: usageIndex < 0 ? "estimate" : trailing > 0 || overhead > 0 ? "provider_usage_plus_estimate" : "provider_usage",
      providerUsageTokens: usageTokens, estimatedTrailingTokens: trailing, estimatedOverheadTokens: overhead,
      note: "Remaining capacity is approximate. Provider usage requires a matching request, model capacity, and active window. Conservative estimates add only positive prompt, tool-schema, and observed injected-context growth; shrinkage never reduces measured usage. Unobserved dynamic context and provider tokenization can differ. Without a request baseline, the full active context is estimated. No automatic rollover threshold is enabled. If the configured reserve exhausts capacity, explicit rollover uses bounded response headroom instead.",
    };
  }
}

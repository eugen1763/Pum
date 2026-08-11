import type { ImageContent, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  addTurnUsage,
  emptyAgentUsage,
  normalizeAgentUsage,
  usageFromEntries,
} from "../agent-usage";
import { replayEntries } from "../replay";
import { isRejectedToolResult, rejectedToolReason } from "../check-mode";
import {
  observeSearchCalls,
  persistSearchCall,
  withSearchRoute,
} from "../web-search";
import { editCounts, toolArg, type ToolCall } from "../tool-line";
import { applyPatchExtension } from "../apply-patch";
import { questionnaireDetail, type QuestionnaireManager } from "../questionnaire";
import {
  recallNewestQueuedUserMessage,
  type RecalledQueuedMessage,
} from "../queue-recall";
import {
  messageCacheDetail,
  type MessageCacheController,
} from "../message-cache";
import {
  ToolGroupsController,
  childAllowedToolNames,
} from "../tool-groups";
import {
  registerTriggerTools,
  type TriggerRuntimeManager,
  type TriggerTargetSelector,
} from "../triggers/tools";
import {
  DEFAULT_MAX_ACTIVE_SUBAGENTS,
  normalizeMaxActiveSubagents,
} from "../settings";
import type { SandboxMode } from "../sandbox/types";
import {
  resolvePendingDelivery,
  settleTranscriptMessage,
  type Line,
  type PendingLine,
} from "../transcript";
import {
  createWorktree,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  worktreeStatus,
  type WorktreeRecord,
} from "../worktree";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  AGENT_MESSAGE_DISPLAY_TYPE,
  SUBAGENT_CUSTOM_TYPE,
  TOOL_EVENT_CUSTOM_TYPE,
  TRIGGER_EVENT_CUSTOM_TYPE,
  type AgentMessageData,
  type TriggerEventData,
  type AgentTranscript,
  type SpawnSubagentOptions,
  type SubagentManagerEvent,
  type SubagentRegistryEvent,
  type SubagentSettlement,
  type SubagentSnapshot,
  type SubagentStatus,
} from "./types";
import type { SpawnPreviewManager, SpawnPreviewRequester } from "./spawn-preview";
import { readonlySubagentExtension } from "./readonly";

const MAX_RETAINED_AGENTS = 100;
const MAX_MESSAGE_LENGTH = 12_000;
const ACTIVE_SUBAGENT_STATUSES = new Set<SubagentStatus>(["starting", "running"]);
const AVAILABLE_TRIGGER_TARGET_STATUSES = new Set<SubagentStatus>(["starting", "running", "idle"]);

export const SUBAGENT_COMMUNICATION_SYSTEM_PROMPT = `## Inter-agent communication

- Use finish_subagent as the only final completion report. Call it only after every retained descendant closes. Complete exactly one successful finish_subagent call; rejected attempts do not count as completion. It sends the sole completion notification to the direct spawner after the status changes.
- Before finish_subagent, recursively merge or resolve every retained descendant. Close the deepest descendants first.
- Every retained descendant blocks finish_subagent regardless of status. Completion does not close a descendant.
- Do not send a final summary, test report, done message, or completion status through message_agent.
- Use message_agent for questions, blockers, coordination, or intermediate information that needs action before completion.
- Do not automatically reply to an acknowledgement, status-only message, or completion notice.
- Never echo a peer message repeatedly.
- Send one acknowledgement only when acknowledgement is necessary.
- Reply again only when the new message contains a question, new information, or a new action.
- If two agents start acknowledging each other, stop the exchange immediately.`;

export const SUBAGENT_COORDINATION_SYSTEM_PROMPT = `## Background subagent coordination

- spawn_subagent returns after setup. The subagent continues in the background.
- Count only starting and running subagents as active. Use the current capacity shown below.
- For follow-up implementation work, prefer a new managed worktree subagent while capacity is available.
- At capacity, use message_agent to queue follow-up work for an appropriate related running subagent.
- message_agent uses the durable recipient-side message and steering queue. Do not create a shell queue or another hidden queue.
- Do not send unrelated work to an arbitrary subagent. If no appropriate recipient is clear, state the capacity issue and keep the work pending for deliberate routing.
- Never wait for subagents with bash sleep, shell polling loops, repeated list_subagents calls, or repeated worktree status calls.
- After you spawn all currently independent subagents, finish the current turn and yield the main agent loop.
- A directly spawned subagent completion notification will automatically start or steer a later main-agent turn.
- A normal 'Message from <agent>' is not a completion notification. Do not merge until the agent status is completed.
- Treat "wait for every subagent" as yielding until completion notifications arrive, not as active polling.
- Use list_subagents only for explicit user requests, recovery after a missing notification, or one status check before a final merge.
- For a coordinated batch, track unfinished agents from completion notifications.
- Merge each successful agent after its completion notification arrives and its status is completed. An idle settlement is not completion.
- Before merging a managed parent, recursively merge or resolve every retained descendant. Close the deepest descendants first.
- Every retained descendant blocks its parent regardless of status. Completion does not close a descendant.
- Wait to merge only when another unfinished task has a concrete dependency, a known conflict risk, or a required integration order. State that reason explicitly.
- If a notification does not arrive, report the notification fault instead of creating a sleep loop.`;

export function buildSubagentCapacityPrompt(activeCount: number, maxActive = DEFAULT_MAX_ACTIVE_SUBAGENTS): string {
  const available = Math.max(0, maxActive - activeCount);
  if (available > 0) {
    return `Current subagent capacity: ${activeCount}/${maxActive} active; ${available} slot${available === 1 ? "" : "s"} available. Prefer spawn_subagent for follow-up implementation work that can run in parallel.`;
  }
  return `Current subagent capacity: ${activeCount}/${maxActive} active; no slots available. Queue follow-up work with message_agent only when an appropriate related running subagent is clear. Otherwise, state the capacity issue and keep the work pending for deliberate routing.`;
}

export function countActiveSubagents(agents: Iterable<Pick<SubagentSnapshot, "status">>): number {
  let count = 0;
  for (const agent of agents) {
    if (ACTIVE_SUBAGENT_STATUSES.has(agent.status)) count += 1;
  }
  return count;
}

/** Prevent the common duplicate where an agent reports done, then finish_subagent reports it again. */
export function isCompletionOnlyMessage(text: string): boolean {
  const message = text.trim();
  if (!message) return false;
  const requestsAction = /\?|\b(?:please|need|blocked|blocking|conflict|question|review|start|spawn|coordinate|help)\b/i.test(message);
  if (requestsAction) return false;
  return /^(?:completed|finished|done\b|implemented\b|task complete\b|work complete\b|all requested .* complete)/i.test(message);
}

export function isAcknowledgementOnlyMessage(text: string): boolean {
  return /^(?:ack(?:nowledged)?|got it|noted|ok(?:ay)?|thanks|thank you|understood)[.!\s]*$/i.test(text.trim());
}

function activeLimitError(maxActive: number): Error {
  return new Error(
    `All ${maxActive} subagent slots are active (starting or running). ` +
      "Queue follow-up work to an appropriate related running subagent with message_agent. " +
      "If no appropriate recipient is clear, keep the task pending and state the capacity issue.",
  );
}

type RuntimeRecord = {
  snapshot: SubagentSnapshot;
  session?: AgentSession;
  api?: ExtensionAPI;
  unsubscribe?: () => void;
  unsubscribeSearch?: () => void;
  dispose?: () => Promise<void> | void;
  finishRequested?: string;
  userInstructionNotices?: Map<string, string>;
  toolGroups?: ToolGroupsController;
  activityGeneration: number;
  idleNotifiedGeneration: number;
};

type ManagerOptions = {
  modelRuntime: ModelRuntime;
  agentDir: string;
  maxActiveSubagents?: number;
  childExtensionFactories?: InlineExtension[];
  childExtensionFactoriesForAgent?: Array<(agentId: string, readonly: boolean) => InlineExtension>;
  sandboxModeSource?: () => SandboxMode;
  questionnaireManager?: QuestionnaireManager;
  spawnPreviewManager?: SpawnPreviewManager;
  triggerManager?: TriggerRuntimeManager;
  messageCacheController?: MessageCacheController;
};

const emptyTranscript = (): AgentTranscript => ({ lines: [], stream: null, pending: [] });

function flushTranscript(transcript: AgentTranscript): AgentTranscript {
  if (!transcript.stream?.text.trim()) return { ...transcript, stream: null };
  return {
    lines: [
      ...transcript.lines,
      { kind: "text", role: transcript.stream.kind, text: transcript.stream.text.trim() },
    ],
    stream: null,
    pending: transcript.pending,
  };
}

function snapshotMetadata(snapshot: SubagentSnapshot): Omit<SubagentSnapshot, "transcript"> {
  const { transcript: _transcript, ...metadata } = snapshot;
  return metadata;
}

function cloneSnapshot(record: RuntimeRecord): SubagentSnapshot {
  return {
    ...record.snapshot,
    worktree: { ...record.snapshot.worktree },
    usage: { ...record.snapshot.usage },
    transcript: {
      lines: [...record.snapshot.transcript.lines],
      stream: record.snapshot.transcript.stream
        ? { ...record.snapshot.transcript.stream }
        : null,
      pending: record.snapshot.transcript.pending.map((pending) => ({
        ...pending,
        line: { ...pending.line },
      })),
    },
  };
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function readonlySpawnParameter() {
  return Type.Optional(Type.Boolean({
    description: "Run the child with read-only filesystem tools and native Bash sandbox roots",
  }));
}

export function spawnSubagentParameters(readonlyAvailable: boolean) {
  return Type.Object({
    task: Type.String({ description: "Complete task for the subagent" }),
    name: Type.Optional(Type.String({ description: "Optional worktree and agent name" })),
    preview: Type.Optional(Type.Boolean({ description: "Ask the user to approve before spawning" })),
    ...(readonlyAvailable ? { readonly: readonlySpawnParameter() } : {}),
  }, { additionalProperties: false });
}

type RetainedDescendant = { record: RuntimeRecord; depth: number };

export class SubagentManager {
  private readonly modelRuntime: ModelRuntime;
  private readonly agentDir: string;
  private readonly childExtensionFactories: InlineExtension[];
  private readonly childExtensionFactoriesForAgent: Array<(agentId: string, readonly: boolean) => InlineExtension>;
  private readonly sandboxModeSource: () => SandboxMode;
  private readonly questionnaireManager?: QuestionnaireManager;
  private readonly spawnPreviewManager?: SpawnPreviewManager;
  private readonly triggerManager?: TriggerRuntimeManager;
  private readonly messageCacheController?: MessageCacheController;
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
  private mainApi?: ExtensionAPI;
  private mainSessionManager?: ExtensionContext["sessionManager"];
  private mainCwd = process.cwd();
  private parentSessionId = "detached";
  private mainRunning = false;
  private maxActiveSubagents: number;
  private worktreeQueue: Promise<void> = Promise.resolve();
  private readonly messageTimes = new Map<string, number[]>();
  private readonly settlements = new Map<string, SubagentSettlement>();
  private readonly acceptedSettlementMessageIds = new Set<string>();
  private readonly settlementDeliveriesInFlight = new Set<string>();
  private readonly spawnParameterSchemas = new Set<ReturnType<typeof spawnSubagentParameters>>();

  constructor(options: ManagerOptions) {
    this.modelRuntime = options.modelRuntime;
    this.agentDir = options.agentDir;
    this.maxActiveSubagents = normalizeMaxActiveSubagents(options.maxActiveSubagents);
    this.childExtensionFactories = [applyPatchExtension, ...(options.childExtensionFactories ?? [])];
    this.childExtensionFactoriesForAgent = options.childExtensionFactoriesForAgent ?? [];
    this.sandboxModeSource = options.sandboxModeSource ?? (() => "off");
    this.questionnaireManager = options.questionnaireManager;
    this.spawnPreviewManager = options.spawnPreviewManager;
    this.triggerManager = options.triggerManager;
    this.messageCacheController = options.messageCacheController;
  }

  subscribe(listener: (event: SubagentManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SubagentManagerEvent = { type: "changed" }): void {
    for (const listener of this.listeners) listener(event);
  }

  getAgents(): SubagentSnapshot[] {
    return [...this.records.values()]
      .map(cloneSnapshot)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  getAgent(id: string): SubagentSnapshot | undefined {
    const record = this.records.get(id);
    return record ? cloneSnapshot(record) : undefined;
  }

  private persist(event: SubagentRegistryEvent): void {
    this.mainApi?.appendEntry(SUBAGENT_CUSTOM_TYPE, event);
  }

  persistToolEvent(call: ToolCall): void {
    this.mainApi?.appendEntry(TOOL_EVENT_CUSTOM_TYPE, {
      id: call.id,
      name: call.name,
      arg: call.arg,
      state: call.state,
      detail: call.detail,
    });
  }

  async attachMain(
    pi: ExtensionAPI,
    sessionManager: ExtensionContext["sessionManager"],
    cwd: string,
  ): Promise<void> {
    const sessionId = sessionManager.getSessionId();
    if (this.mainApi === pi && this.parentSessionId === sessionId && this.mainSessionManager) return;
    if (this.parentSessionId !== "detached") this.spawnPreviewManager?.cancelRequester(this.parentSessionId);
    await this.stopAll("interrupted", false);
    this.records.clear();
    this.messageTimes.clear();
    this.settlements.clear();
    this.acceptedSettlementMessageIds.clear();
    this.settlementDeliveriesInFlight.clear();
    this.mainApi = pi;
    this.mainSessionManager = sessionManager;
    this.mainCwd = cwd;
    this.parentSessionId = sessionId;
    this.mainRunning = false;
    this.emit({
      type: "trigger-target",
      sessionId,
      agentId: null,
      available: true,
      settled: true,
    });

    const restored = new Map<string, Omit<SubagentSnapshot, "transcript">>();
    const restoredActivity = new Map<string, { activityGeneration: number; idleNotifiedGeneration: number }>();
    const restoredFinish = new Map<string, string>();
    for (const entry of sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_CUSTOM_TYPE) continue;
      const data = entry.data as SubagentRegistryEvent | undefined;
      if (!data || typeof data.id !== "string") continue;
      if (data.event === "spawned" && data.snapshot) restored.set(data.id, data.snapshot);
      else if (data.event === "removed") {
        restored.delete(data.id);
        restoredActivity.delete(data.id);
        restoredFinish.delete(data.id);
      } else if (data.event === "status") {
        const current = restored.get(data.id);
        if (current && data.status) {
          current.status = data.status;
          current.summary = data.summary ?? current.summary;
          current.updatedAt = data.at;
        }
      } else if (data.event === "usage") {
        const current = restored.get(data.id);
        if (current && data.usage) current.usage = data.usage;
      } else if (data.event === "activity") {
        restoredActivity.set(data.id, {
          activityGeneration: Math.max(0, data.activityGeneration ?? 0),
          idleNotifiedGeneration: Math.max(0, data.idleNotifiedGeneration ?? 0),
        });
      } else if (data.event === "finish") {
        if (typeof data.finishSummary === "string") restoredFinish.set(data.id, data.finishSummary);
        else restoredFinish.delete(data.id);
      } else if (data.event === "settlement" && data.settlement) {
        this.settlements.set(data.settlement.id, data.settlement);
      }
    }

    for (const restoredSnapshot of restored.values()) {
      const snapshot = {
        ...restoredSnapshot,
        parentAgentId: restoredSnapshot.parentAgentId ?? null,
        readonly: restoredSnapshot.readonly === true,
        usage: normalizeAgentUsage(restoredSnapshot.usage),
      } as SubagentSnapshot;
      let transcript = emptyTranscript();
      if (snapshot.sessionFile && existsSync(snapshot.sessionFile)) {
        try {
          const childManager = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(
            snapshot.sessionFile,
          );
          transcript = {
            lines: replayEntries(childManager.buildContextEntries(), snapshot.worktree.path, true),
            stream: null,
            pending: [],
          };
          const retainedUsage = restoredSnapshot.usage as any;
          if (!retainedUsage || typeof retainedUsage.outgoing !== "number") {
            snapshot.usage = usageFromEntries(
              childManager.getEntries(),
              this.resolveModel(snapshot.modelId).contextWindow,
            );
          }
        } catch {
          // Keep metadata even if an old subagent session cannot be opened.
        }
      }
      const status: SubagentStatus = ["running", "starting"].includes(snapshot.status)
        ? "interrupted"
        : snapshot.status;
      const activity = restoredActivity.get(snapshot.id);
      const activityGeneration = activity?.activityGeneration ?? 0;
      const idleNotifiedGeneration = status === "interrupted"
        ? Math.max(activity?.idleNotifiedGeneration ?? 0, activityGeneration)
        : activity?.idleNotifiedGeneration ?? 0;
      this.records.set(snapshot.id, {
        snapshot: { ...snapshot, status, transcript },
        userInstructionNotices: new Map(),
        activityGeneration,
        idleNotifiedGeneration,
        finishRequested: restoredFinish.get(snapshot.id),
      });
      if (status === "interrupted" && snapshot.status !== "interrupted") {
        this.persist({
          event: "status",
          id: snapshot.id,
          at: Date.now(),
          status: "interrupted",
          summary: snapshot.summary,
        });
        this.persistActivity(this.records.get(snapshot.id)!);
      }
    }
    await this.retrySettlementsForParent(null);
    this.emit();
  }

  async bindMainSession(
    sessionManager: ExtensionContext["sessionManager"],
    cwd: string,
  ): Promise<void> {
    if (!this.mainApi) throw new Error("Subagent extension API is unavailable");
    await this.attachMain(this.mainApi, sessionManager, cwd);
  }

  async detachMain(): Promise<void> {
    const sessionId = this.parentSessionId;
    this.spawnPreviewManager?.cancelRequester(sessionId);
    await this.stopAll("interrupted", true);
    this.emit({
      type: "trigger-target",
      sessionId,
      agentId: null,
      available: false,
      settled: true,
    });
    this.mainApi = undefined;
    this.mainSessionManager = undefined;
    this.settlementDeliveriesInFlight.clear();
    this.records.clear();
    this.emit();
  }

  private updateStatus(record: RuntimeRecord, status: SubagentStatus, summary?: string): void {
    if (status === "running" && record.snapshot.status !== "running") {
      record.snapshot.runStartedAt = Date.now();
    }
    record.snapshot.status = status;
    record.snapshot.updatedAt = Date.now();
    if (summary) record.snapshot.summary = summary;
    this.persist({
      event: "status",
      id: record.snapshot.id,
      at: record.snapshot.updatedAt,
      status,
      summary,
    });
    this.emit();
  }

  private updateTranscript(record: RuntimeRecord, update: (value: AgentTranscript) => AgentTranscript): void {
    record.snapshot.transcript = update(record.snapshot.transcript);
    record.snapshot.updatedAt = Date.now();
    this.emit();
  }

  private appendLine(record: RuntimeRecord, line: Line): void {
    this.updateTranscript(record, (value) => {
      const flushed = flushTranscript(value);
      return { ...flushed, lines: [...flushed.lines, line] };
    });
  }

  private addPending(record: RuntimeRecord, pending: PendingLine): void {
    this.updateTranscript(record, (value) => ({
      ...value,
      pending: [...value.pending, pending],
    }));
  }

  private resolvePending(record: RuntimeRecord, id: string): void {
    this.updateTranscript(record, (value) => resolvePendingDelivery(value, id));
  }

  private resolvePendingText(record: RuntimeRecord, text: string): PendingLine | undefined {
    const pending = record.snapshot.transcript.pending.find((item) => item.deliveryText === text);
    if (pending) this.resolvePending(record, pending.id);
    return pending;
  }

  private persistActivity(record: RuntimeRecord): void {
    this.persist({
      event: "activity",
      id: record.snapshot.id,
      at: Date.now(),
      activityGeneration: record.activityGeneration,
      idleNotifiedGeneration: record.idleNotifiedGeneration,
    });
  }

  private beginActivity(record: RuntimeRecord): void {
    record.activityGeneration = (record.activityGeneration ?? 0) + 1;
    record.idleNotifiedGeneration ??= 0;
    this.persistActivity(record);
  }

  private countsAsActivity(message: any): boolean {
    if (message?.role === "user") return true;
    if (message?.role !== "custom") return false;
    if (message.customType === TRIGGER_EVENT_CUSTOM_TYPE) return true;
    if (message.customType !== AGENT_MESSAGE_CUSTOM_TYPE) return false;
    const details = message.details as AgentMessageData | undefined;
    return !["acknowledgement", "idle", "completion", "status"].includes(details?.kind ?? "message");
  }

  private dropPending(record: RuntimeRecord, id: string): void {
    this.updateTranscript(record, (value) => ({
      ...value,
      pending: value.pending.filter((item) => item.id !== id),
    }));
  }

  private patchTool(record: RuntimeRecord, id: string, patch: Partial<ToolCall>): void {
    this.updateTranscript(record, (value) => ({
      ...value,
      lines: value.lines.map((line) =>
        line.kind === "tool" && line.call.id === id
          ? { kind: "tool", call: { ...line.call, ...patch } }
          : line,
      ),
    }));
  }

  private processSessionEvent(record: RuntimeRecord, event: any): void {
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (this.countsAsActivity(message)) this.beginActivity(record);
        if (message?.role === "custom"
          && [AGENT_MESSAGE_CUSTOM_TYPE, TRIGGER_EVENT_CUSTOM_TYPE].includes(message.customType)) {
          const id = message.details?.id;
          if (typeof id === "string") {
            this.resolvePending(record, id);
            this.acknowledgeSettlementMessage(id);
          }
        } else if (message?.role === "user") {
          const text = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                .filter((block: any) => block?.type === "text")
                .map((block: any) => block.text)
                .join("")
                .trim()
              : "";
          if (text) {
            const pending = this.resolvePendingText(record, text);
            if (pending) {
              const instruction = record.userInstructionNotices?.get(pending.id);
              if (instruction !== undefined) {
                record.userInstructionNotices?.delete(pending.id);
                this.notifyMainOfUserInstruction(record, instruction);
              }
            }
          }
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant") {
          this.updateTranscript(record, (value) => settleTranscriptMessage(value));
        }
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        const kind = update.type === "text_delta" ? "assistant" : update.type === "thinking_delta" ? "thinking" : null;
        if (!kind) return;
        this.updateTranscript(record, (value) => {
          if (value.stream?.kind === kind) {
            return { ...value, stream: { kind, text: value.stream.text + update.delta } };
          }
          const flushed = flushTranscript(value);
          return { ...flushed, stream: { kind, text: update.delta } };
        });
        break;
      }
      case "tool_execution_start":
        this.appendLine(record, {
          kind: "tool",
          call: {
            id: event.toolCallId,
            name: event.toolName,
            arg: toolArg(event.toolName, event.args, record.snapshot.worktree.path),
            state: "running",
          },
        });
        break;
      case "tool_execution_end":
        this.patchTool(record, event.toolCallId, {
          state: isRejectedToolResult(event.result, event.toolCallId)
            ? "rejected"
            : event.isError
              ? "error"
              : "ok",
          detail: isRejectedToolResult(event.result, event.toolCallId)
            ? rejectedToolReason(event.result, event.toolCallId)
            : event.toolName === "edit" || event.toolName === "apply_patch"
              ? editCounts(event.result)
              : event.toolName === "questionnaire"
                ? questionnaireDetail(event.result)
                : event.toolName.startsWith("message_cache_")
                  ? messageCacheDetail(event.result)
                  : undefined,
        });
        break;
      case "agent_start":
        this.updateStatus(record, "running");
        break;
      case "turn_end": {
        const usage = event.message?.usage;
        if (!usage) break;
        record.snapshot.usage = addTurnUsage(
          record.snapshot.usage,
          usage,
          record.session?.agent.state.model.contextWindow,
        );
        record.snapshot.updatedAt = Date.now();
        this.persist({
          event: "usage",
          id: record.snapshot.id,
          at: record.snapshot.updatedAt,
          usage: record.snapshot.usage,
        });
        this.emit();
        break;
      }
      case "agent_settled": {
        this.messageCacheController?.releaseRequester({ kind: "subagent", id: record.snapshot.id });
        this.updateTranscript(record, flushTranscript);
        if (record.session) {
          void this.triggerManager?.markTargetSettled(
            record.session.sessionId,
            record.snapshot.id,
          );
          this.emit({
            type: "trigger-target",
            sessionId: record.session.sessionId,
            agentId: record.snapshot.id,
            available: true,
            settled: true,
          });
        }
        const error = record.session?.agent?.state?.errorMessage;
        const priorStatus = record.snapshot.status;
        const status: SubagentStatus = error
          ? "failed"
          : record.finishRequested !== undefined
            ? "completed"
            : ["completed", "failed", "stopped"].includes(priorStatus)
                && record.activityGeneration === record.idleNotifiedGeneration
              ? priorStatus
              : "idle";
        const summary = record.finishRequested || error || record.snapshot.summary;
        this.updateStatus(record, status, summary);
        if (record.session && !AVAILABLE_TRIGGER_TARGET_STATUSES.has(status)) {
          void this.triggerManager?.invalidateAgent(record.session.sessionId, record.snapshot.id);
          this.emit({
            type: "trigger-target",
            sessionId: record.session.sessionId,
            agentId: record.snapshot.id,
            available: false,
            settled: true,
          });
        }
        if (status === "idle") {
          if (record.activityGeneration > record.idleNotifiedGeneration) {
            record.idleNotifiedGeneration = record.activityGeneration;
            this.persistActivity(record);
            void this.recordSettlement(record, status, summary);
          }
        } else if (status === "completed" || status === "failed") {
          if (record.idleNotifiedGeneration !== record.activityGeneration) {
            record.idleNotifiedGeneration = record.activityGeneration;
            this.persistActivity(record);
          }
          if (priorStatus !== status || record.finishRequested !== undefined) {
            void this.recordSettlement(record, status, summary);
          }
        }
        if (record.finishRequested !== undefined) {
          record.finishRequested = undefined;
          this.persist({
            event: "finish",
            id: record.snapshot.id,
            at: Date.now(),
            finishSummary: null,
          });
        }
        break;
      }
    }
  }

  private childExtension(agentId: string): InlineExtension {
    return {
      name: `pum-subagent-${agentId}`,
      factory: (pi) => {
        // Capture immediately because inline extensions can load after the
        // child session_start event on some session creation paths.
        const initialRecord = this.records.get(agentId);
        if (initialRecord) initialRecord.api = pi;
        pi.on("session_start", (_event, ctx) => {
          const record = this.records.get(agentId);
          if (record) record.api = pi;
          void ctx;
        });
        pi.on("session_shutdown", (_event, ctx) => {
          this.spawnPreviewManager?.cancelRequester(ctx.sessionManager.getSessionId(), agentId);
        });
        pi.on("before_agent_start", (event) => {
          const record = this.records.get(agentId);
          if (!record) return;
          const identity = `${event.systemPrompt}\n\nYou are subagent ${record.snapshot.name} (${agentId}). `
            + `Work only in ${record.snapshot.worktree.path} on branch ${record.snapshot.worktree.branch}. `;
          if (record.snapshot.readonly) {
            return {
              systemPrompt: identity
                + "This is a readonly inspection task. Do not change files, commit, delegate work, or start external processes. "
                + "Use finish_subagent exactly once for the final inspection summary. It sends the sole completion notification after status changes.",
            };
          }
          return {
            systemPrompt: identity
              + "Use message_agent only for questions, blockers, coordination, or intermediate information that needs action. "
              + "Never send the final summary through message_agent. "
              + "Commit completed changes before finishing. Call finish_subagent only after every retained descendant closes. Complete exactly one successful finish_subagent call with the final summary; rejected attempts do not count as completion. It sends the sole completion notification after status changes.\n\n"
              + SUBAGENT_COMMUNICATION_SYSTEM_PROMPT + "\n\n"
              + SUBAGENT_COORDINATION_SYSTEM_PROMPT + "\n\n"
              + buildSubagentCapacityPrompt(this.activeCount(), this.maxActiveSubagents),
          };
        });

        const questionnaireRecord = this.records.get(agentId);
        if (questionnaireRecord) {
          this.questionnaireManager?.registerTool(pi, {
            id: agentId,
            name: questionnaireRecord.snapshot.name,
          });
        }
        const messageCacheRecord = this.records.get(agentId);
        if (messageCacheRecord) {
          this.messageCacheController?.registerTools(pi, () => ({
            kind: "subagent",
            id: agentId,
            name: messageCacheRecord.snapshot.name,
          }));
        }
        const toolGroupsRecord = this.records.get(agentId);
        if (toolGroupsRecord?.toolGroups) {
          toolGroupsRecord.toolGroups.registerTool(pi);
        }
        if (this.triggerManager) {
          registerTriggerTools(
            pi,
            this.triggerManager,
            (ctx) => ({
              kind: "subagent",
              sessionId: ctx.sessionManager.getSessionId(),
              agentId,
              cwd: ctx.cwd,
            }),
            { audience: "subagent" },
          );
        }

        pi.registerTool({
          name: "spawn_subagent",
          label: "Spawn Subagent",
          description: "Start a nonblocking child subagent in a new Git worktree.",
          promptSnippet: "Start a child subagent in an isolated Git worktree",
          parameters: this.trackedSpawnSubagentParameters(),
          execute: async (_id, params, signal, _update, ctx) => {
            const parent = this.records.get(agentId);
            if (!parent) throw new Error("Spawner subagent no longer exists");
            if (parent.snapshot.readonly) {
              throw new Error("Readonly subagents cannot spawn child agents");
            }
            const readonlyRequested = (params as { readonly?: boolean }).readonly === true;
            if (readonlyRequested && this.sandboxModeSource() === "off") {
              throw new Error("Readonly subagents require the PUM Sandbox setting to be Auto or Require");
            }
            const options: SpawnSubagentOptions = {
              task: params.task,
              name: params.name,
              modelId: parent.snapshot.modelId,
              thinkingLevel: parent.snapshot.thinkingLevel,
              readonly: readonlyRequested,
              parentAgentId: agentId,
            };
            if (params.preview) {
              const preview = await this.requestSpawnPreview({
                sessionId: ctx.sessionManager.getSessionId(),
                agentId,
                name: parent.snapshot.name,
              }, options, signal);
              if (!preview.approved) return textResult(`Spawn cancelled (${preview.reason ?? "cancelled"}).`, preview);
              const snapshot = await this.spawn(options);
              if (preview.note) await this.sendUserMessage(snapshot.id, preview.note);
              return textResult(`Spawned ${snapshot.name}\nid: ${snapshot.id}`, snapshot);
            }
            const snapshot = await this.spawn(options);
            return textResult(`Spawned ${snapshot.name}\nid: ${snapshot.id}`, snapshot);
          },
        });

        pi.registerTool({
          name: "message_agent",
          label: "Message Agent",
          description: "Send a question, blocker, coordination request, or actionable intermediate message. Never use this tool for a final completion report; use finish_subagent instead.",
          promptSnippet: "Send a message to the main agent or another subagent",
          parameters: Type.Object({
            target: Type.String({ description: 'Target agent id/name, or "main"' }),
            message: Type.String({ description: "Message to send" }),
          }),
          execute: async (_id, params) => {
            if (isCompletionOnlyMessage(params.message)) {
              throw new Error("Use finish_subagent for the final summary. message_agent does not send completion-only reports.");
            }
            await this.routeMessage(agentId, params.target, params.message);
            return textResult(`Message delivered to ${params.target}`);
          },
        });

        pi.registerTool({
          name: "list_subagents",
          label: "List Subagents",
          description: "List active and completed subagents and their worktrees.",
          parameters: Type.Object({}),
          execute: async () => textResult(this.formatAgentList()),
        });

        pi.registerTool({
          name: "finish_subagent",
          label: "Finish Subagent",
          description: "Mark this task complete and send the sole final summary to the direct spawner after the agent status changes. Do not send the summary with message_agent first.",
          parameters: Type.Object({
            summary: Type.String({ description: "Summary of completed work, tests, and remaining concerns" }),
          }),
          execute: async (_id, params) => {
            await this.withWorktreeLock(async () => {
              const record = this.records.get(agentId);
              if (!record) throw new Error("Subagent no longer exists");
              this.assertNoRetainedDescendants(record, "finish");
              record.finishRequested = params.summary;
              this.persist({
                event: "finish",
                id: record.snapshot.id,
                at: Date.now(),
                finishSummary: params.summary,
              });
            });
            return {
              ...textResult("Completion recorded."),
              terminate: true,
            };
          },
        });

        pi.registerTool({
          name: "worktree",
          label: "Worktree",
          description: "List, inspect, merge, or remove PUM Git worktrees. Close managed descendants recursively before their parent.",
          promptSnippet: "Manage isolated Git worktrees under .pum/worktrees",
          parameters: Type.Object({
            action: Type.String({ description: "create, list, status, merge, or remove" }),
            target: Type.Optional(Type.String({ description: "Worktree id or name" })),
            name: Type.Optional(Type.String({ description: "Name for a new worktree" })),
            force: Type.Optional(Type.Boolean({ description: "Force removal of a standalone unmerged worktree" })),
          }),
          execute: async (_id, params) => {
            const record = this.records.get(agentId);
            if (record?.snapshot.readonly && !["list", "status"].includes(params.action)) {
              throw new Error(`Readonly subagents cannot run worktree ${params.action}`);
            }
            return this.worktreeAction(
              this.mainCwd,
              params.action,
              params.target,
              params.name,
              params.force,
              record?.snapshot.readonly === true,
            );
          },
        });
      },
    };
  }

  mainExtension(): InlineExtension {
    return {
      name: "pum-subagents",
      factory: (pi) => {
        // Capture the API immediately. Some session creation paths load inline
        // extensions after session_start, so every tool also binds lazily.
        this.mainApi = pi;
        pi.on("before_agent_start", (event) => ({
          systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_COORDINATION_SYSTEM_PROMPT}\n\n${buildSubagentCapacityPrompt(this.activeCount(), this.maxActiveSubagents)}`,
        }));
        pi.on("agent_start", () => {
          this.mainRunning = true;
        });
        pi.on("agent_settled", () => {
          this.mainRunning = false;
          this.messageCacheController?.releaseRequester({ kind: "main", id: this.parentSessionId });
          void this.triggerManager?.markTargetSettled(this.parentSessionId, null);
          this.emit({
            type: "trigger-target",
            sessionId: this.parentSessionId,
            agentId: null,
            available: true,
            settled: true,
          });
        });
        pi.on("message_start", (event) => {
          const message = event.message;
          if (message.role !== "custom"
            || ![AGENT_MESSAGE_CUSTOM_TYPE, TRIGGER_EVENT_CUSTOM_TYPE].includes(message.customType)) return;
          const id = (message.details as AgentMessageData | undefined)?.id;
          if (typeof id === "string") {
            this.acknowledgeSettlementMessage(id);
            this.emit({ type: "main-pending-resolve", id });
          }
        });
        pi.on("session_start", async (_event, ctx) => {
          await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
        });
        pi.on("session_shutdown", async () => {
          const sessionId = this.parentSessionId;
          await this.detachMain();
          await this.triggerManager?.invalidateSession(sessionId);
        });

        this.messageCacheController?.registerTools(pi, (ctx) => ({
          kind: "main",
          id: ctx.sessionManager.getSessionId(),
          name: "main",
        }));

        if (this.triggerManager) {
          registerTriggerTools(
            pi,
            this.triggerManager,
            (ctx) => ({
              kind: "main",
              sessionId: ctx.sessionManager.getSessionId(),
              cwd: ctx.cwd,
            }),
            {
              audience: "main",
              resolveTarget: (requester, selector) => this.resolveTriggerSelector(requester.sessionId, selector),
              authorizeTarget: (requester, target) => this.authorizeTriggerTarget(requester.sessionId, target),
            },
          );
        }

        pi.registerTool({
          name: "spawn_subagent",
          label: "Spawn Subagent",
          description: "Start a nonblocking subagent in a new Git worktree. The configured limit counts starting and running subagents.",
          promptSnippet: "Start a parallel subagent in an isolated Git worktree",
          promptGuidelines: [
            "Use spawn_subagent for independent tasks that can run in parallel.",
            "For follow-up implementation work, prefer spawn_subagent while configured capacity is available.",
            "At configured capacity, queue related follow-up work through message_agent instead of spawning another agent.",
            "Do not route unrelated work to an arbitrary subagent. Keep it pending when no appropriate recipient is clear.",
            "Give each spawn_subagent call a complete, self-contained task.",
            "After spawning background agents, end the current turn. Never poll with bash sleep or status loops.",
            "Merge each successful agent only after its completion notification arrives and its status is completed, unless a concrete dependency or conflict requires waiting. Idle is not completion.",
            "Recursively close every retained descendant before merging a managed parent. Close the deepest descendants first.",
          ],
          parameters: this.trackedSpawnSubagentParameters(),
          execute: async (_id, params, signal, _update, ctx) => {
            await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
            if (!ctx.model) throw new Error("No model is selected");
            const readonlyRequested = (params as { readonly?: boolean }).readonly === true;
            if (readonlyRequested && this.sandboxModeSource() === "off") {
              throw new Error("Readonly subagents require the PUM Sandbox setting to be Auto or Require");
            }
            const options: SpawnSubagentOptions = {
              task: params.task,
              name: params.name,
              modelId: `${ctx.model.provider}/${ctx.model.id}`,
              thinkingLevel: ctx.thinkingLevel ?? "off",
              readonly: readonlyRequested,
            };
            if (params.preview) {
              const preview = await this.requestSpawnPreview({
                sessionId: ctx.sessionManager.getSessionId(),
                agentId: null,
                name: "main",
              }, options, signal);
              if (!preview.approved) return textResult(`Spawn cancelled (${preview.reason ?? "cancelled"}).`, preview);
              const snapshot = await this.spawn(options);
              if (preview.note) await this.sendUserMessage(snapshot.id, preview.note);
              return textResult(
                `Spawned ${snapshot.name}\n` +
                  `id: ${snapshot.id}\nbranch: ${snapshot.worktree.branch}\nworktree: ${snapshot.worktree.path}`,
                snapshot,
              );
            }
            const snapshot = await this.spawn(options);
            return textResult(
              `Spawned ${snapshot.name}\n` +
                `id: ${snapshot.id}\nbranch: ${snapshot.worktree.branch}\nworktree: ${snapshot.worktree.path}`,
              snapshot,
            );
          },
        });

        pi.registerTool({
          name: "message_agent",
          label: "Message Agent",
          description: "Send a durable queued message from the main agent to a subagent. At capacity, use this for related follow-up work when an appropriate running recipient is clear.",
          promptSnippet: "Queue an instruction or question to an appropriate subagent",
          parameters: Type.Object({
            target: Type.String({ description: "Subagent id or name" }),
            message: Type.String({ description: "Message to send" }),
          }),
          execute: async (_id, params, _signal, _update, ctx) => {
            await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
            await this.routeMessage("main", params.target, params.message);
            return textResult(`Message delivered to ${params.target}`);
          },
        });

        pi.registerTool({
          name: "list_subagents",
          label: "List Subagents",
          description: "List subagents, status, branch, and worktree.",
          parameters: Type.Object({}),
          execute: async (_id, _params, _signal, _update, ctx) => {
            await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
            return textResult(this.formatAgentList());
          },
        });

        pi.registerTool({
          name: "stop_subagent",
          label: "Stop Subagent",
          description: "Abort and stop a subagent.",
          parameters: Type.Object({ target: Type.String({ description: "Subagent id or name" }) }),
          execute: async (_id, params, _signal, _update, ctx) => {
            await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
            const record = this.findRecord(params.target);
            if (!record) throw new Error(`Unknown subagent: ${params.target}`);
            await this.stop(record.snapshot.id, "stopped");
            return textResult(`Stopped ${record.snapshot.name}`);
          },
        });

        pi.registerTool({
          name: "worktree",
          label: "Worktree",
          description: "Create, list, inspect, merge, or remove PUM Git worktrees.",
          promptSnippet: "Manage isolated Git worktrees under .pum/worktrees",
          parameters: Type.Object({
            action: Type.String({ description: "create, list, status, merge, or remove" }),
            target: Type.Optional(Type.String({ description: "Worktree id or name" })),
            name: Type.Optional(Type.String({ description: "Name for a new worktree" })),
            force: Type.Optional(Type.Boolean({ description: "Force removal of an unmerged worktree" })),
          }),
          execute: async (_id, params, _signal, _update, ctx) => {
            await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
            return this.worktreeAction(ctx.cwd, params.action, params.target, params.name, params.force);
          },
        });
      },
    };
  }

  private async withWorktreeLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.worktreeQueue;
    this.worktreeQueue = previous.then(() => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async createStandaloneWorktree(name?: string): Promise<WorktreeRecord> {
    return this.withWorktreeLock(() => createWorktree(this.mainCwd, name));
  }

  private resolveModel(ref: string): Model<any> {
    const slash = ref.indexOf("/");
    if (slash <= 0) throw new Error(`Invalid model reference: ${ref}`);
    const model = this.modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1));
    if (!model) throw new Error(`Model is unavailable: ${ref}`);
    return model;
  }

  activeCount(): number {
    return countActiveSubagents([...this.records.values()].map((record) => record.snapshot));
  }

  getMaxActiveSubagents(): number {
    return this.maxActiveSubagents;
  }

  setMaxActiveSubagents(value: number): void {
    this.maxActiveSubagents = normalizeMaxActiveSubagents(value);
  }

  private trackedSpawnSubagentParameters() {
    const schema = spawnSubagentParameters(this.sandboxModeSource() !== "off");
    this.spawnParameterSchemas.add(schema);
    return schema;
  }

  /** Keep already registered spawn tool schemas aligned with the live Sandbox setting. */
  refreshSandboxMode(): void {
    const available = this.sandboxModeSource() !== "off";
    for (const schema of this.spawnParameterSchemas) {
      const properties = schema.properties as Record<string, unknown>;
      if (available) properties.readonly = readonlySpawnParameter();
      else delete properties.readonly;
    }
  }

  private requestSpawnPreview(
    requester: SpawnPreviewRequester,
    options: SpawnSubagentOptions,
    signal?: AbortSignal,
  ) {
    if (!this.spawnPreviewManager) throw new Error("The PUM spawn preview UI is unavailable");
    return this.spawnPreviewManager.request(requester, options, signal);
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentSnapshot> {
    if (options.readonly === true && this.sandboxModeSource() === "off") {
      throw new Error("Readonly subagents require the PUM Sandbox setting to be Auto or Require");
    }
    const record = await this.withWorktreeLock(async () => {
      if (this.activeCount() >= this.maxActiveSubagents) throw activeLimitError(this.maxActiveSubagents);
      if (this.records.size >= MAX_RETAINED_AGENTS) throw new Error(`At most ${MAX_RETAINED_AGENTS} subagents can be retained`);
      if (options.parentAgentId !== undefined && options.parentAgentId !== null) {
        const parent = this.records.get(options.parentAgentId);
        if (!parent) throw new Error("Spawner subagent no longer exists");
        if (parent.finishRequested !== undefined) throw new Error("Spawner subagent is finishing");
      }

      const worktree = await createWorktree(this.mainCwd, options.name);
      const id = randomUUID().slice(0, 8);
      const now = Date.now();
      const snapshot: SubagentSnapshot = {
        id,
        name: worktree.name,
        task: options.task,
        status: "starting",
        worktree,
        parentAgentId: options.parentAgentId ?? null,
        modelId: options.modelId,
        thinkingLevel: options.thinkingLevel,
        readonly: options.readonly === true,
        transcript: emptyTranscript(),
        startedAt: now,
        updatedAt: now,
        usage: emptyAgentUsage(),
      };
      const created: RuntimeRecord = {
        snapshot,
        userInstructionNotices: new Map(),
        activityGeneration: 0,
        idleNotifiedGeneration: 0,
      };
      this.records.set(id, created);
      this.persist({ event: "spawned", id, at: now, snapshot: snapshotMetadata(snapshot) });
      this.emit();
      return created;
    });

    try {
      await this.ensureRuntime(record);
      this.appendLine(record, { kind: "text", role: "user", text: options.task });
      this.updateStatus(record, "running");
      void withSearchRoute(record.session!.sessionId, () => record.session!.prompt(options.task)).catch((error) => {
        this.updateStatus(record, "failed", String(error));
        void this.recordSettlement(record, "failed", String(error));
      });
      return cloneSnapshot(record);
    } catch (error) {
      this.updateStatus(record, "failed", String(error));
      throw error;
    }
  }

  private async ensureRuntime(record: RuntimeRecord, retrySettlements = true): Promise<void> {
    if (record.session) {
      if (retrySettlements) await this.retrySettlementsForParent(record.snapshot.id);
      return;
    }
    if (!existsSync(record.snapshot.worktree.path)) throw new Error(`Missing worktree: ${record.snapshot.worktree.path}`);

    const model = this.resolveModel(record.snapshot.modelId);
    const sessionDir = join(this.agentDir, "subagents", this.parentSessionId);
    const SessionManagerClass = (await import("@earendil-works/pi-coding-agent")).SessionManager;
    const sessionManager = record.snapshot.sessionFile && existsSync(record.snapshot.sessionFile)
      ? SessionManagerClass.open(record.snapshot.sessionFile, sessionDir)
      : SessionManagerClass.create(record.snapshot.worktree.path, sessionDir);
    // Each child tracks its own enabled tool groups, persisted next to its
    // session file. Restore before the child's enable_tools tool registers.
    record.toolGroups = new ToolGroupsController("subagent", undefined, record.snapshot.readonly);
    record.toolGroups.load(sessionManager.getSessionFile());
    const services = await createAgentSessionServices({
      cwd: record.snapshot.worktree.path,
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [
          ...this.childExtensionFactories,
          readonlySubagentExtension(record.snapshot.readonly === true),
          ...this.childExtensionFactoriesForAgent.map((factory) => factory(
            record.snapshot.id,
            record.snapshot.readonly === true,
          )),
          this.childExtension(record.snapshot.id),
        ],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: record.snapshot.thinkingLevel as any,
      tools: childAllowedToolNames(record.snapshot.readonly),
    });
    record.session = result.session;
    record.snapshot.sessionFile = result.session.sessionFile;
    // Narrow the outgoing tool list to core plus enabled groups for this child.
    result.session.setActiveToolsByName(record.toolGroups.activeTools());
    record.unsubscribe = result.session.subscribe((event) => this.processSessionEvent(record, event));
    record.unsubscribeSearch = observeSearchCalls(result.session.sessionId, (call) => {
      if (call.phase === "start") {
        this.appendLine(record, {
          kind: "tool",
          call: { id: call.id, name: "web_search", arg: call.query, state: "running" },
        });
      } else {
        this.patchTool(record, call.id, {
          state: call.ok ? "ok" : "error",
          ...(call.query ? { arg: call.query } : {}),
        });
      }
      persistSearchCall(result.session.sessionManager, call);
    });
    record.dispose = async () => {
      record.unsubscribe?.();
      record.unsubscribe = undefined;
      record.unsubscribeSearch?.();
      record.unsubscribeSearch = undefined;
      await result.session.abort().catch(() => {});
      result.session.dispose();
      record.session = undefined;
      record.api = undefined;
    };
    this.emit({
      type: "trigger-target",
      sessionId: result.session.sessionId,
      agentId: record.snapshot.id,
      available: true,
      settled: !result.session.isStreaming,
    });
    this.persist({
      event: "spawned",
      id: record.snapshot.id,
      at: Date.now(),
      snapshot: snapshotMetadata(record.snapshot),
    });
    if (retrySettlements) await this.retrySettlementsForParent(record.snapshot.id);
  }

  private async authorizeTriggerTarget(
    requesterSessionId: string,
    target: { sessionId: string; agentId: string | null },
  ): Promise<boolean> {
    if (requesterSessionId !== this.parentSessionId) return false;
    if (target.agentId === null) return target.sessionId === this.parentSessionId;
    const record = this.records.get(target.agentId);
    if (!record || record.snapshot.readonly) return false;
    await this.ensureRuntime(record);
    return record.session?.sessionId === target.sessionId;
  }

  private async resolveTriggerSelector(
    sessionId: string,
    selector: TriggerTargetSelector,
  ): Promise<{ target: { sessionId: string; agentId: string | null; label: string }; cwd: string }> {
    if (selector.kind === "main") {
      if (sessionId !== this.parentSessionId) throw new Error("The main trigger session is no longer active");
      return {
        target: { sessionId, agentId: null, label: "main" },
        cwd: this.mainCwd,
      };
    }
    if (selector.kind !== "subagent") throw new Error("Invalid main-session trigger target");
    const record = this.findRecord(selector.agent);
    if (!record) throw new Error(`Unknown subagent: ${selector.agent}`);
    if (record.snapshot.readonly) {
      throw new Error(`Readonly subagent cannot be an external trigger target: ${record.snapshot.name}`);
    }
    if (!AVAILABLE_TRIGGER_TARGET_STATUSES.has(record.snapshot.status)) {
      throw new Error(`Subagent target is unavailable: ${record.snapshot.name}`);
    }
    await this.ensureRuntime(record);
    if (!record.session) throw new Error(`Subagent session is unavailable: ${record.snapshot.name}`);
    return {
      target: {
        sessionId: record.session.sessionId,
        agentId: record.snapshot.id,
        label: record.snapshot.name,
      },
      cwd: record.snapshot.worktree.path,
    };
  }

  async resolveRetainedTriggerTarget(agent?: string): Promise<{
    sessionId: string;
    agentId: string | null;
    label: string;
    cwd: string;
    available: boolean;
  }> {
    if (!agent || agent === "main") {
      return {
        sessionId: this.parentSessionId,
        agentId: null,
        label: "main",
        cwd: this.mainCwd,
        available: Boolean(this.mainApi),
      };
    }
    const record = this.findRecord(agent);
    if (!record) throw new Error(`Unknown subagent: ${agent}`);
    if (record.snapshot.readonly) {
      return {
        sessionId: record.session?.sessionId ?? "unavailable",
        agentId: record.snapshot.id,
        label: record.snapshot.name,
        cwd: record.snapshot.worktree.path,
        available: false,
      };
    }
    if (!AVAILABLE_TRIGGER_TARGET_STATUSES.has(record.snapshot.status)) {
      return {
        sessionId: record.session?.sessionId ?? "unavailable",
        agentId: record.snapshot.id,
        label: record.snapshot.name,
        cwd: record.snapshot.worktree.path,
        available: false,
      };
    }
    await this.ensureRuntime(record);
    return {
      sessionId: record.session!.sessionId,
      agentId: record.snapshot.id,
      label: record.snapshot.name,
      cwd: record.snapshot.worktree.path,
      available: Boolean(record.api && record.session),
    };
  }

  private findRecord(target: string): RuntimeRecord | undefined {
    return this.records.get(target) ?? [...this.records.values()].find((record) => record.snapshot.name === target);
  }

  private retainedDescendants(parentId: string): RetainedDescendant[] {
    const descendants: RetainedDescendant[] = [];
    const visited = new Set<string>([parentId]);
    let frontier = [{ id: parentId, depth: 0 }];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const parent of frontier) {
        for (const record of this.records.values()) {
          if (record.snapshot.parentAgentId !== parent.id || visited.has(record.snapshot.id)) continue;
          visited.add(record.snapshot.id);
          const descendant = { record, depth: parent.depth + 1 };
          descendants.push(descendant);
          next.push({ id: record.snapshot.id, depth: descendant.depth });
        }
      }
      frontier = next;
    }
    return descendants.sort((a, b) =>
      b.depth - a.depth
        || a.record.snapshot.startedAt - b.record.snapshot.startedAt
        || a.record.snapshot.name.localeCompare(b.record.snapshot.name),
    );
  }

  private assertNoRetainedDescendants(record: RuntimeRecord, action: "finish" | "merge" | "remove"): void {
    const descendants = this.retainedDescendants(record.snapshot.id);
    if (descendants.length === 0) return;
    const blockers = descendants.map(({ record: descendant }) =>
      `- ${descendant.snapshot.name} (${descendant.snapshot.status})`,
    ).join("\n");
    throw new Error(
      `Cannot ${action} ${record.snapshot.name} while retained descendants remain:\n${blockers}\n` +
        "Merge or resolve the deepest descendants first. A descendant closes only after its record and managed worktree are removed through a successful merge or valid removal.",
    );
  }

  private assertManagedMergeReady(record: RuntimeRecord): void {
    if (record.snapshot.status !== "completed") {
      throw new Error(
        `Cannot merge ${record.snapshot.name} while its authoritative status is ${record.snapshot.status}. ` +
          "A managed merge requires status completed after its completion notice arrives. Idle settlement is not completion.",
      );
    }
    const completion = this.settlements.get(this.settlementId(record, "completed"));
    if (completion?.acknowledgedAt === undefined) {
      throw new Error(
        `Cannot merge ${record.snapshot.name} before its completion notice arrives. ` +
          "Authoritative status completed alone is not sufficient.",
      );
    }
  }

  async sendUserMessage(
    id: string,
    text: string,
    images: ImageContent[] = [],
    displayText = text,
    recallable = images.length === 0,
  ): Promise<void> {
    const record = this.findRecord(id);
    if (!record) throw new Error(`Unknown subagent: ${id}`);
    await this.ensureRuntime(record);
    const pending: PendingLine = {
      id: randomUUID().slice(0, 12),
      line: { kind: "text", role: "user", text: displayText },
      deliveryText: text,
      recallable,
    };
    this.addPending(record, pending);
    record.userInstructionNotices ??= new Map();
    record.userInstructionNotices.set(pending.id, displayText);
    this.updateStatus(record, "running");
    if (record.session!.isStreaming) {
      try {
        await withSearchRoute(record.session!.sessionId, () => record.session!.steer(text, images));
      } catch (error) {
        record.userInstructionNotices.delete(pending.id);
        this.dropPending(record, pending.id);
        throw error;
      }
    } else void withSearchRoute(
      record.session!.sessionId,
      () => record.session!.prompt(text, { images }),
    ).catch((error) => {
      record.userInstructionNotices?.delete(pending.id);
      this.dropPending(record, pending.id);
      this.updateStatus(record, "failed", String(error));
      void this.recordSettlement(record, "failed", String(error));
    });
  }

  async recallQueuedUserMessage(id: string): Promise<RecalledQueuedMessage | null> {
    const record = this.findRecord(id);
    if (!record?.session) return null;
    const recalled = await recallNewestQueuedUserMessage(
      record.session,
      record.snapshot.transcript.pending,
    );
    if (!recalled) return null;
    record.userInstructionNotices?.delete(recalled.id);
    this.dropPending(record, recalled.id);
    return recalled;
  }

  async abortAgent(id: string): Promise<void> {
    const record = this.findRecord(id);
    if (!record?.session) return;
    const queued = record.session.clearQueue();
    const cancelled = new Set([...queued.steering, ...queued.followUp]);
    if (cancelled.size > 0) {
      for (const pending of record.snapshot.transcript.pending) {
        if (pending.deliveryText && cancelled.has(pending.deliveryText)) {
          record.userInstructionNotices?.delete(pending.id);
        }
      }
      this.updateTranscript(record, (value) => ({
        ...value,
        pending: value.pending.filter(
          (pending) => !pending.deliveryText || !cancelled.has(pending.deliveryText),
        ),
      }));
    }
    await record.session.abort();
  }

  private agentMessageLine(data: AgentMessageData): Extract<Line, { kind: "agent-message" }> {
    return {
      kind: "agent-message",
      sender: data.sender,
      recipient: data.recipient,
      text: data.text,
    };
  }

  async deliverTriggerEvent(data: TriggerEventData): Promise<void> {
    if (!data.id || !data.triggerId || !data.name || !data.text.trim()) {
      throw new Error("Trigger event is incomplete");
    }
    const { sessionId, agentId } = data.target;
    const line: Extract<Line, { kind: "agent-message" }> = {
      kind: "agent-message",
      sender: `trigger:${data.name}`,
      recipient: agentId ?? "main",
      text: data.text,
    };
    const pending: PendingLine = { id: data.id, line };
    const message = {
      customType: TRIGGER_EVENT_CUSTOM_TYPE,
      content: data.text,
      display: true,
      details: data,
    };

    if (agentId === null) {
      if (sessionId !== this.parentSessionId || !this.mainApi) {
        throw new Error("The main trigger target is unavailable");
      }
      this.mainApi.appendEntry(TRIGGER_EVENT_CUSTOM_TYPE, data);
      this.emit({ type: "main-pending-add", pending });
      if (!this.wakeMain(message, data.text, "steer")) {
        this.emit({ type: "main-pending-drop", id: data.id });
        throw new Error("The main trigger target is unavailable");
      }
      return;
    }

    const record = this.records.get(agentId);
    if (!record) throw new Error(`Unknown trigger target agent: ${agentId}`);
    await this.ensureRuntime(record);
    if (!record.session || !record.api || record.session.sessionId !== sessionId) {
      throw new Error("The child trigger target is unavailable");
    }
    record.session.sessionManager.appendCustomEntry(TRIGGER_EVENT_CUSTOM_TYPE, data);
    this.addPending(record, pending);
    try {
      withSearchRoute(record.session.sessionId, () => {
        record.api!.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      });
      this.updateStatus(record, "running");
    } catch (error) {
      this.dropPending(record, pending.id);
      throw error;
    }
  }

  async routeMessage(senderTarget: string, recipientTarget: string, text: string): Promise<void> {
    const message = text.trim();
    if (!message) throw new Error("Message cannot be empty");
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`Message exceeds ${MAX_MESSAGE_LENGTH} characters`);
    const now = Date.now();
    const recent = (this.messageTimes.get(senderTarget) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 20) throw new Error("Agent message rate limit exceeded");
    recent.push(now);
    this.messageTimes.set(senderTarget, recent);

    const sender = senderTarget === "main" ? undefined : this.findRecord(senderTarget);
    const recipient = recipientTarget === "main" ? undefined : this.findRecord(recipientTarget);
    if (senderTarget !== "main" && !sender) throw new Error(`Unknown sender: ${senderTarget}`);
    if (recipientTarget !== "main" && !recipient) throw new Error(`Unknown recipient: ${recipientTarget}`);
    if (sender && recipient && sender.snapshot.id === recipient.snapshot.id) {
      throw new Error("An agent cannot message itself");
    }

    const data: AgentMessageData = {
      id: randomUUID().slice(0, 12),
      sender: sender?.snapshot.name ?? "main",
      recipient: recipient?.snapshot.name ?? "main",
      text: message,
      at: now,
      kind: isAcknowledgementOnlyMessage(message) ? "acknowledgement" : "message",
    };

    const line = this.agentMessageLine(data);
    const pending: PendingLine = { id: data.id, line };
    if (sender) {
      sender.session?.sessionManager.appendCustomEntry(AGENT_MESSAGE_DISPLAY_TYPE, data);
      this.appendLine(sender, line);
    } else {
      this.mainApi?.appendEntry(AGENT_MESSAGE_DISPLAY_TYPE, data);
      this.emit({ type: "main-line", line });
    }

    const customMessage = {
      customType: AGENT_MESSAGE_CUSTOM_TYPE,
      content: `Message from ${data.sender}:\n${message}`,
      display: true,
      details: data,
    };
    if (recipientTarget === "main") {
      if (!this.mainApi) throw new Error("Main agent is unavailable");
      this.emit({ type: "main-pending-add", pending });
      if (!this.wakeMain(customMessage, customMessage.content)) {
        this.emit({ type: "main-pending-drop", id: pending.id });
        throw new Error("Main agent is unavailable");
      }
    } else if (recipient) {
      await this.ensureRuntime(recipient);
      if (!recipient.api) throw new Error(`Agent message API is unavailable: ${recipient.snapshot.name}`);
      this.addPending(recipient, pending);
      try {
        withSearchRoute(recipient.session!.sessionId, () => {
          recipient.api!.sendMessage(customMessage, { deliverAs: "steer", triggerTurn: true });
        });
        this.updateStatus(recipient, "running");
      } catch (error) {
        this.dropPending(recipient, pending.id);
        throw error;
      }
    }
  }

  private wakeMain(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    _fallback: string,
    deliverAs: "steer" | "followUp" = "followUp",
  ): boolean {
    const api = this.mainApi;
    if (!api) return false;
    // The explicit main-session binding makes the structured custom message a
    // reliable wake signal. Do not add a user-message fallback because it
    // creates a second visible turn after the custom message already wakes one.
    try {
      withSearchRoute(this.parentSessionId, () => {
        api.sendMessage(message, { deliverAs, triggerTurn: true });
      });
      return true;
    } catch {
      return false;
    }
  }

  private notifyMainOfUserInstruction(record: RuntimeRecord, instruction: string): void {
    if (!this.mainApi) return;
    const text = `User added instructions to subagent ${record.snapshot.name}:\n${instruction}`;
    const data: AgentMessageData = {
      id: randomUUID().slice(0, 12),
      sender: "user",
      recipient: "main",
      text,
      at: Date.now(),
      kind: "user-instruction",
    };
    const pending: PendingLine = { id: data.id, line: this.agentMessageLine(data) };
    this.emit({ type: "main-pending-add", pending });
    const delivered = this.wakeMain(
      {
        customType: AGENT_MESSAGE_CUSTOM_TYPE,
        content: text,
        display: true,
        details: data,
      },
      text,
      this.mainRunning ? "steer" : "followUp",
    );
    if (!delivered) this.emit({ type: "main-pending-drop", id: pending.id });
  }

  private settlementId(record: RuntimeRecord, status: "idle" | "completed" | "failed"): string {
    return `${record.snapshot.id}:${record.activityGeneration}:${status}`;
  }

  private async recordSettlement(
    record: RuntimeRecord,
    status: "idle" | "completed" | "failed",
    summary?: string,
  ): Promise<void> {
    const id = this.settlementId(record, status);
    let settlement = this.settlements.get(id);
    if (!settlement) {
      const content = [
        `Subagent ${record.snapshot.name} ${status}.`,
        `id: ${record.snapshot.id}`,
        `branch: ${record.snapshot.worktree.branch}`,
        `worktree: ${record.snapshot.worktree.path}`,
        summary ? `summary: ${summary}` : "",
      ].filter(Boolean).join("\n");
      settlement = {
        id,
        messageId: `settlement-${id}`,
        agentId: record.snapshot.id,
        parentAgentId: record.snapshot.parentAgentId,
        status,
        summary,
        activityGeneration: record.activityGeneration,
        content,
        createdAt: Date.now(),
      };
      this.settlements.set(id, settlement);
      this.persist({
        event: "settlement",
        id: record.snapshot.id,
        at: settlement.createdAt,
        settlement,
      });
    }
    await this.deliverSettlement(settlement);
  }

  private sessionHasSettlementMessage(sessionManager: any, messageId: string): boolean {
    if (this.acceptedSettlementMessageIds.has(messageId)) return true;
    const entries = sessionManager?.getEntries?.() ?? [];
    return entries.some((entry: any) =>
      entry?.type === "custom_message"
        && entry.customType === AGENT_MESSAGE_CUSTOM_TYPE
        && entry.details?.id === messageId,
    );
  }

  private acknowledgeSettlement(settlement: SubagentSettlement): void {
    this.settlementDeliveriesInFlight.delete(settlement.messageId);
    if (settlement.acknowledgedAt !== undefined) return;
    settlement.acknowledgedAt = Date.now();
    this.acceptedSettlementMessageIds.add(settlement.messageId);
    this.persist({
      event: "settlement",
      id: settlement.agentId,
      at: settlement.acknowledgedAt,
      settlement: { ...settlement },
    });
  }

  private acknowledgeSettlementMessage(messageId: string): void {
    const settlement = [...this.settlements.values()].find((item) => item.messageId === messageId);
    if (settlement) this.acknowledgeSettlement(settlement);
  }

  private clearSettlementDeliveriesForParent(parentAgentId: string): void {
    for (const settlement of this.settlements.values()) {
      if (settlement.parentAgentId === parentAgentId) {
        this.settlementDeliveriesInFlight.delete(settlement.messageId);
      }
    }
  }

  private async deliverSettlement(settlement: SubagentSettlement): Promise<boolean> {
    if (settlement.acknowledgedAt !== undefined) return true;
    const source = this.records.get(settlement.agentId);
    const sender = source?.snapshot.name ?? settlement.agentId;

    if (settlement.parentAgentId === null) {
      if (!this.mainApi) return false;
      if (this.sessionHasSettlementMessage(this.mainSessionManager, settlement.messageId)) {
        this.acknowledgeSettlement(settlement);
        return true;
      }
      if (this.settlementDeliveriesInFlight.has(settlement.messageId)) return true;
      const data: AgentMessageData = {
        id: settlement.messageId,
        sender,
        recipient: "main",
        text: settlement.content,
        at: settlement.createdAt,
        kind: settlement.status === "idle" ? "idle" : settlement.status === "completed" ? "completion" : "status",
      };
      this.settlementDeliveriesInFlight.add(settlement.messageId);
      const delivered = this.wakeMain({
        customType: AGENT_MESSAGE_CUSTOM_TYPE,
        content: settlement.content,
        display: true,
        details: data,
      }, settlement.content);
      if (!delivered) {
        this.settlementDeliveriesInFlight.delete(settlement.messageId);
        return false;
      }
      this.emit({ type: "main-line", line: this.agentMessageLine(data) });
      return true;
    }

    const parent = this.records.get(settlement.parentAgentId);
    if (!parent) return false;
    try {
      await this.ensureRuntime(parent, false);
      if (!parent.api || !parent.session) return false;
      if (this.sessionHasSettlementMessage(parent.session.sessionManager, settlement.messageId)) {
        this.acknowledgeSettlement(settlement);
        return true;
      }
      if (this.settlementDeliveriesInFlight.has(settlement.messageId)) return true;
      const data: AgentMessageData = {
        id: settlement.messageId,
        sender,
        recipient: parent.snapshot.name,
        text: settlement.content,
        at: settlement.createdAt,
        kind: settlement.status === "idle" ? "idle" : settlement.status === "completed" ? "completion" : "status",
      };
      const pending: PendingLine = { id: data.id, line: this.agentMessageLine(data) };
      if (!parent.snapshot.transcript.pending.some((item) => item.id === pending.id)) {
        this.addPending(parent, pending);
      }
      this.settlementDeliveriesInFlight.add(settlement.messageId);
      try {
        withSearchRoute(parent.session.sessionId, () => {
          parent.api!.sendMessage(
            {
              customType: AGENT_MESSAGE_CUSTOM_TYPE,
              content: settlement.content,
              display: true,
              details: data,
            },
            {
              deliverAs: parent.session!.isStreaming ? "steer" : "followUp",
              triggerTurn: true,
            },
          );
        });
      } catch {
        this.settlementDeliveriesInFlight.delete(settlement.messageId);
        this.dropPending(parent, pending.id);
        return false;
      }
      this.updateStatus(parent, "running");
      return true;
    } catch {
      return false;
    }
  }

  private async retrySettlementsForParent(parentAgentId: string | null): Promise<void> {
    for (const settlement of this.settlements.values()) {
      if (settlement.acknowledgedAt !== undefined || settlement.parentAgentId !== parentAgentId) continue;
      await this.deliverSettlement(settlement);
    }
  }

  private formatAgentList(): string {
    const agents = this.getAgents();
    if (!agents.length) return "No subagents.";
    return agents.map((agent) =>
      `${agent.id}  ${agent.name}  ${agent.status}${agent.readonly ? "  readonly" : ""}\n  ${agent.worktree.branch}\n  ${agent.worktree.path}`,
    ).join("\n");
  }

  async stop(id: string, status: SubagentStatus = "stopped", persist = true): Promise<void> {
    const record = this.findRecord(id);
    if (!record) return;
    const sessionId = record.session?.sessionId;
    if (record.dispose) await record.dispose();
    this.clearSettlementDeliveriesForParent(record.snapshot.id);
    if (sessionId) {
      await this.triggerManager?.invalidateAgent(sessionId, record.snapshot.id);
      this.emit({
        type: "trigger-target",
        sessionId,
        agentId: record.snapshot.id,
        available: false,
        settled: true,
      });
    }
    record.snapshot.transcript.pending = [];
    if (persist) this.updateStatus(record, status);
    else {
      record.snapshot.status = status;
      record.snapshot.updatedAt = Date.now();
    }
  }

  private async stopAll(status: SubagentStatus, persist: boolean): Promise<void> {
    for (const record of this.records.values()) {
      const sessionId = record.session?.sessionId;
      if (record.dispose) await record.dispose();
      if (sessionId) await this.triggerManager?.invalidateAgent(sessionId, record.snapshot.id);
      if (!["starting", "running"].includes(record.snapshot.status)) continue;
      if (persist) this.updateStatus(record, status);
      else {
        record.snapshot.status = status;
        record.snapshot.updatedAt = Date.now();
      }
    }
  }

  private forgetManagedAgent(record: RuntimeRecord): void {
    this.records.delete(record.snapshot.id);
    this.persist({ event: "removed", id: record.snapshot.id, at: Date.now() });
    this.emit();
  }

  private async worktreeAction(
    cwd: string,
    action: string,
    target?: string,
    name?: string,
    force = false,
    readonly = false,
  ) {
    if (action === "create") {
      const record = await this.withWorktreeLock(() => createWorktree(cwd, name));
      return textResult(`Created ${record.name}\nbranch: ${record.branch}\npath: ${record.path}`, record);
    }
    if (action === "list") {
      const records = await listWorktrees(cwd);
      return textResult(records.length ? records.map((record) => `${record.name}  ${record.branch}\n  ${record.path}`).join("\n") : "No PUM worktrees.", { records });
    }
    if (!target) throw new Error(`worktree ${action} requires target`);
    if (action === "status") {
      const managedAgent = this.findRecord(target);
      const record = managedAgent?.snapshot.worktree
        ?? (await listWorktrees(cwd)).find((item) => item.name === target || item.branch === target);
      if (!record) throw new Error(`Unknown worktree: ${target}`);
      return textResult(await worktreeStatus(cwd, record, readonly), record);
    }
    if (action === "merge") {
      return this.withWorktreeLock(async () => {
        const managedAgent = this.findRecord(target);
        if (managedAgent) {
          this.assertNoRetainedDescendants(managedAgent, "merge");
          this.assertManagedMergeReady(managedAgent);
        }
        const record = managedAgent?.snapshot.worktree
          ?? (await listWorktrees(cwd)).find((item) => item.name === target || item.branch === target);
        if (!record) throw new Error(`Unknown worktree: ${target}`);
        const output = (await mergeWorktree(cwd, record)) || `Merged ${record.branch}`;
        if (!managedAgent) return textResult(output, record);

        await this.stop(managedAgent.snapshot.id, "stopped");
        await removeWorktree(cwd, record);
        this.forgetManagedAgent(managedAgent);
        return textResult(`${output}\nClosed ${managedAgent.snapshot.name} and removed its worktree.`, record);
      });
    }
    if (action === "remove") {
      return this.withWorktreeLock(async () => {
        const managedAgent = this.findRecord(target);
        if (managedAgent && ["starting", "running"].includes(managedAgent.snapshot.status)) {
          throw new Error(`Stop ${managedAgent.snapshot.name} before ${action}`);
        }
        if (managedAgent) {
          this.assertNoRetainedDescendants(managedAgent, "remove");
          if (force) {
            throw new Error(
              `Cannot force-remove managed subagent ${managedAgent.snapshot.name}. ` +
                "Failed or unmerged managed subagents must remain retained until a valid merge or removal flow closes them.",
            );
          }
        }
        const record = managedAgent?.snapshot.worktree
          ?? (await listWorktrees(cwd)).find((item) => item.name === target || item.branch === target);
        if (!record) throw new Error(`Unknown worktree: ${target}`);
        if (managedAgent) await this.stop(managedAgent.snapshot.id, "stopped");
        await removeWorktree(cwd, record, force);
        if (managedAgent) this.forgetManagedAgent(managedAgent);
        return textResult(`Removed ${record.name}`, record);
      });
    }
    throw new Error(`Unknown worktree action: ${action}`);
  }
}

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
import { addTurnUsage, emptyAgentUsage, usageFromEntries } from "../agent-usage";
import { replayEntries } from "../replay";
import { isRejectedToolResult } from "../check-mode";
import {
  observeSearchCalls,
  persistSearchCall,
  withSearchRoute,
} from "../web-search";
import { editCounts, toolArg, type ToolCall } from "../tool-line";
import type { Line, PendingLine } from "../transcript";
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
  type AgentMessageData,
  type AgentTranscript,
  type SpawnSubagentOptions,
  type SubagentManagerEvent,
  type SubagentRegistryEvent,
  type SubagentSnapshot,
  type SubagentStatus,
} from "./types";

const MAX_RUNNING_AGENTS = 4;
const MAX_RETAINED_AGENTS = 8;
const MAX_MESSAGE_LENGTH = 12_000;

export const SUBAGENT_COMMUNICATION_SYSTEM_PROMPT = `## Inter-agent communication

- Do not automatically reply to an acknowledgement, status-only message, or completion notice.
- Never echo a peer message repeatedly.
- Send one acknowledgement only when acknowledgement is necessary.
- Reply again only when the new message contains a question, new information, or a new action.
- If two agents start acknowledging each other, stop the exchange immediately.`;

export const SUBAGENT_COORDINATION_SYSTEM_PROMPT = `## Background subagent coordination

- spawn_subagent returns after setup. The subagent continues in the background.
- Never wait for subagents with bash sleep, shell polling loops, repeated list_subagents calls, or repeated worktree status calls.
- After you spawn all currently independent subagents, finish the current turn and yield the main agent loop.
- A subagent completion notification will automatically start or steer a later main-agent turn.
- Treat "wait for every subagent" as yielding until completion notifications arrive, not as active polling.
- Use list_subagents only for explicit user requests, recovery after a missing notification, or one status check before a final merge.
- For a coordinated batch, track unfinished agents from completion notifications.
- Merge each successful agent as soon as it settles.
- Wait to merge only when another unfinished task has a concrete dependency, a known conflict risk, or a required integration order. State that reason explicitly.
- If a notification does not arrive, report the notification fault instead of creating a sleep loop.`;

type RuntimeRecord = {
  snapshot: SubagentSnapshot;
  session?: AgentSession;
  api?: ExtensionAPI;
  unsubscribe?: () => void;
  unsubscribeSearch?: () => void;
  dispose?: () => Promise<void> | void;
  finishRequested?: string;
};

type ManagerOptions = {
  modelRuntime: ModelRuntime;
  agentDir: string;
  childExtensionFactories?: InlineExtension[];
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

export class SubagentManager {
  private readonly modelRuntime: ModelRuntime;
  private readonly agentDir: string;
  private readonly childExtensionFactories: InlineExtension[];
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
  private mainApi?: ExtensionAPI;
  private mainSessionManager?: ExtensionContext["sessionManager"];
  private mainCwd = process.cwd();
  private parentSessionId = "detached";
  private worktreeQueue: Promise<void> = Promise.resolve();
  private readonly messageTimes = new Map<string, number[]>();

  constructor(options: ManagerOptions) {
    this.modelRuntime = options.modelRuntime;
    this.agentDir = options.agentDir;
    this.childExtensionFactories = options.childExtensionFactories ?? [];
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
    await this.stopAll("interrupted", false);
    this.records.clear();
    this.messageTimes.clear();
    this.mainApi = pi;
    this.mainSessionManager = sessionManager;
    this.mainCwd = cwd;
    this.parentSessionId = sessionId;

    const restored = new Map<string, Omit<SubagentSnapshot, "transcript">>();
    for (const entry of sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_CUSTOM_TYPE) continue;
      const data = entry.data as SubagentRegistryEvent | undefined;
      if (!data || typeof data.id !== "string") continue;
      if (data.event === "spawned" && data.snapshot) restored.set(data.id, data.snapshot);
      else if (data.event === "removed") restored.delete(data.id);
      else if (data.event === "status") {
        const current = restored.get(data.id);
        if (current && data.status) {
          current.status = data.status;
          current.summary = data.summary ?? current.summary;
          current.updatedAt = data.at;
        }
      } else if (data.event === "usage") {
        const current = restored.get(data.id);
        if (current && data.usage) current.usage = data.usage;
      }
    }

    for (const restoredSnapshot of restored.values()) {
      const snapshot = {
        ...restoredSnapshot,
        parentAgentId: restoredSnapshot.parentAgentId ?? null,
        usage: restoredSnapshot.usage ?? emptyAgentUsage(),
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
          if (!restoredSnapshot.usage) {
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
      this.records.set(snapshot.id, { snapshot: { ...snapshot, status, transcript } });
    }
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
    await this.stopAll("interrupted", true);
    this.mainApi = undefined;
    this.mainSessionManager = undefined;
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
    this.updateTranscript(record, (value) => {
      const pending = value.pending.find((item) => item.id === id);
      if (!pending) return value;
      const flushed = flushTranscript(value);
      return {
        ...flushed,
        lines: [...flushed.lines, pending.line],
        pending: flushed.pending.filter((item) => item.id !== id),
      };
    });
  }

  private resolvePendingText(record: RuntimeRecord, text: string): void {
    const pending = record.snapshot.transcript.pending.find((item) => item.deliveryText === text);
    if (pending) this.resolvePending(record, pending.id);
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
        if (message?.role === "custom" && message.customType === AGENT_MESSAGE_CUSTOM_TYPE) {
          const id = message.details?.id;
          if (typeof id === "string") this.resolvePending(record, id);
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
          if (text) this.resolvePendingText(record, text);
        }
        break;
      }
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
          state: isRejectedToolResult(event.result)
            ? "rejected"
            : event.isError
              ? "error"
              : "ok",
          detail: event.toolName === "edit" ? editCounts(event.result) : undefined,
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
        this.updateTranscript(record, flushTranscript);
        const error = record.session?.agent.state.errorMessage;
        const status: SubagentStatus = error
          ? "failed"
          : record.finishRequested !== undefined
            ? "completed"
            : "idle";
        const summary = record.finishRequested || error || record.snapshot.summary;
        this.updateStatus(record, status, summary);
        this.notifyMain(record, status, summary);
        record.finishRequested = undefined;
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
        pi.on("before_agent_start", (event) => {
          const record = this.records.get(agentId);
          if (!record) return;
          return {
            systemPrompt: `${event.systemPrompt}\n\nYou are subagent ${record.snapshot.name} (${agentId}). ` +
              `Work only in ${record.snapshot.worktree.path} on branch ${record.snapshot.worktree.branch}. ` +
              "Use message_agent to communicate with the main agent or peers. " +
              "Commit completed changes before finishing. Call finish_subagent with a concise summary when the task is complete.\n\n" +
              SUBAGENT_COMMUNICATION_SYSTEM_PROMPT,
          };
        });

        pi.registerTool({
          name: "spawn_subagent",
          label: "Spawn Subagent",
          description: "Start a nonblocking child subagent in a new Git worktree.",
          promptSnippet: "Start a child subagent in an isolated Git worktree",
          parameters: Type.Object({
            task: Type.String({ description: "Complete task for the child subagent" }),
            name: Type.Optional(Type.String({ description: "Optional worktree and agent name" })),
          }),
          execute: async (_id, params) => {
            const parent = this.records.get(agentId);
            if (!parent) throw new Error("Spawner subagent no longer exists");
            const snapshot = await this.spawn({
              task: params.task,
              name: params.name,
              modelId: parent.snapshot.modelId,
              thinkingLevel: parent.snapshot.thinkingLevel,
              parentAgentId: agentId,
            });
            return textResult(`Spawned ${snapshot.name}\nid: ${snapshot.id}`, snapshot);
          },
        });

        pi.registerTool({
          name: "message_agent",
          label: "Message Agent",
          description: "Send a message to the main agent or another active subagent.",
          promptSnippet: "Send a message to the main agent or another subagent",
          parameters: Type.Object({
            target: Type.String({ description: 'Target agent id/name, or "main"' }),
            message: Type.String({ description: "Message to send" }),
          }),
          execute: async (_id, params) => {
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
          description: "Mark this subagent task complete and report a summary to the main agent.",
          parameters: Type.Object({
            summary: Type.String({ description: "Summary of completed work, tests, and remaining concerns" }),
          }),
          execute: async (_id, params) => {
            const record = this.records.get(agentId);
            if (!record) throw new Error("Subagent no longer exists");
            record.finishRequested = params.summary;
            return {
              ...textResult("Completion recorded."),
              terminate: true,
            };
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
          systemPrompt: `${event.systemPrompt}\n\n${SUBAGENT_COORDINATION_SYSTEM_PROMPT}`,
        }));
        pi.on("message_start", (event) => {
          const message = event.message;
          if (message.role !== "custom" || message.customType !== AGENT_MESSAGE_CUSTOM_TYPE) return;
          const id = (message.details as AgentMessageData | undefined)?.id;
          if (typeof id === "string") this.emit({ type: "main-pending-resolve", id });
        });
        pi.on("session_start", async (_event, ctx) => {
          await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
        });
        pi.on("session_shutdown", async () => {
          await this.detachMain();
        });

        pi.registerTool({
          name: "spawn_subagent",
          label: "Spawn Subagent",
          description: "Start a nonblocking subagent in a new Git worktree. The subagent runs in parallel and reports when it stops.",
          promptSnippet: "Start a parallel subagent in an isolated Git worktree",
          promptGuidelines: [
            "Use spawn_subagent for independent tasks that can run in parallel.",
            "Give each spawn_subagent call a complete, self-contained task.",
            "After spawning background agents, end the current turn. Never poll with bash sleep or status loops.",
            "Merge each successful agent when it settles unless a concrete dependency or conflict requires waiting.",
          ],
          parameters: Type.Object({
            task: Type.String({ description: "Complete task for the subagent" }),
            name: Type.Optional(Type.String({ description: "Optional worktree and agent name" })),
          }),
          execute: async (_id, params, _signal, _update, ctx) => {
            await this.attachMain(pi, ctx.sessionManager, ctx.cwd);
            if (!ctx.model) throw new Error("No model is selected");
            const snapshot = await this.spawn({
              task: params.task,
              name: params.name,
              modelId: `${ctx.model.provider}/${ctx.model.id}`,
              thinkingLevel: ctx.thinkingLevel ?? "off",
            });
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
          description: "Send a message from the main agent to a subagent.",
          promptSnippet: "Send an instruction or question to a subagent",
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

  async spawn(options: SpawnSubagentOptions): Promise<SubagentSnapshot> {
    const running = [...this.records.values()].filter((record) =>
      ["starting", "running"].includes(record.snapshot.status),
    ).length;
    if (running >= MAX_RUNNING_AGENTS) throw new Error(`At most ${MAX_RUNNING_AGENTS} subagents can run at once`);
    if (this.records.size >= MAX_RETAINED_AGENTS) throw new Error(`At most ${MAX_RETAINED_AGENTS} subagents can be retained`);

    const worktree = await this.withWorktreeLock(() => createWorktree(this.mainCwd, options.name));
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
      transcript: emptyTranscript(),
      startedAt: now,
      updatedAt: now,
      usage: emptyAgentUsage(),
    };
    const record: RuntimeRecord = { snapshot };
    this.records.set(id, record);
    this.persist({ event: "spawned", id, at: now, snapshot: snapshotMetadata(snapshot) });
    this.emit();

    try {
      await this.ensureRuntime(record);
      this.appendLine(record, { kind: "text", role: "user", text: options.task });
      this.updateStatus(record, "running");
      void withSearchRoute(record.session!.sessionId, () => record.session!.prompt(options.task)).catch((error) => {
        this.updateStatus(record, "failed", String(error));
        this.notifyMain(record, "failed", String(error));
      });
      return cloneSnapshot(record);
    } catch (error) {
      this.updateStatus(record, "failed", String(error));
      throw error;
    }
  }

  private async ensureRuntime(record: RuntimeRecord): Promise<void> {
    if (record.session) return;
    if (!existsSync(record.snapshot.worktree.path)) throw new Error(`Missing worktree: ${record.snapshot.worktree.path}`);

    const model = this.resolveModel(record.snapshot.modelId);
    const sessionDir = join(this.agentDir, "subagents", this.parentSessionId);
    const SessionManagerClass = (await import("@earendil-works/pi-coding-agent")).SessionManager;
    const sessionManager = record.snapshot.sessionFile && existsSync(record.snapshot.sessionFile)
      ? SessionManagerClass.open(record.snapshot.sessionFile, sessionDir)
      : SessionManagerClass.create(record.snapshot.worktree.path, sessionDir);
    const services = await createAgentSessionServices({
      cwd: record.snapshot.worktree.path,
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [...this.childExtensionFactories, this.childExtension(record.snapshot.id)],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: record.snapshot.thinkingLevel as any,
      tools: [
        "read", "write", "edit", "bash",
        "spawn_subagent", "message_agent", "list_subagents", "finish_subagent",
      ],
    });
    record.session = result.session;
    record.snapshot.sessionFile = result.session.sessionFile;
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
    this.persist({
      event: "spawned",
      id: record.snapshot.id,
      at: Date.now(),
      snapshot: snapshotMetadata(record.snapshot),
    });
  }

  private findRecord(target: string): RuntimeRecord | undefined {
    return this.records.get(target) ?? [...this.records.values()].find((record) => record.snapshot.name === target);
  }

  async sendUserMessage(
    id: string,
    text: string,
    images: ImageContent[] = [],
    displayText = text,
  ): Promise<void> {
    const record = this.findRecord(id);
    if (!record) throw new Error(`Unknown subagent: ${id}`);
    await this.ensureRuntime(record);
    const pending: PendingLine = {
      id: randomUUID().slice(0, 12),
      line: { kind: "text", role: "user", text: displayText },
      deliveryText: text,
    };
    this.addPending(record, pending);
    this.updateStatus(record, "running");
    if (record.session!.isStreaming) {
      try {
        await withSearchRoute(record.session!.sessionId, () => record.session!.steer(text, images));
      } catch (error) {
        this.dropPending(record, pending.id);
        throw error;
      }
    } else void withSearchRoute(
      record.session!.sessionId,
      () => record.session!.prompt(text, { images }),
    ).catch((error) => {
      this.dropPending(record, pending.id);
      this.updateStatus(record, "failed", String(error));
      this.notifyMain(record, "failed", String(error));
    });
  }

  async abortAgent(id: string): Promise<void> {
    const record = this.findRecord(id);
    if (!record?.session) return;
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
      this.wakeMain(customMessage, customMessage.content);
    } else if (recipient) {
      await this.ensureRuntime(recipient);
      if (!recipient.api) throw new Error(`Agent message API is unavailable: ${recipient.snapshot.name}`);
      this.addPending(recipient, pending);
      withSearchRoute(recipient.session!.sessionId, () => {
        recipient.api!.sendMessage(customMessage, { deliverAs: "steer", triggerTurn: true });
      });
      this.updateStatus(recipient, "running");
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
  ): void {
    const api = this.mainApi;
    if (!api) return;
    // The explicit main-session binding makes the structured custom message a
    // reliable wake signal. Do not add a user-message fallback because it
    // creates a second visible turn after the custom message already wakes one.
    withSearchRoute(this.parentSessionId, () => {
      api.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
    });
  }

  private notifyMain(record: RuntimeRecord, status: SubagentStatus, summary?: string): void {
    if (!this.mainApi) return;
    const content = [
      `Subagent ${record.snapshot.name} ${status}.`,
      `id: ${record.snapshot.id}`,
      `branch: ${record.snapshot.worktree.branch}`,
      `worktree: ${record.snapshot.worktree.path}`,
      summary ? `summary: ${summary}` : "",
    ].filter(Boolean).join("\n");
    const data: AgentMessageData = {
      id: randomUUID().slice(0, 12),
      sender: record.snapshot.name,
      recipient: "main",
      text: content,
      at: Date.now(),
    };
    this.wakeMain(
      {
        customType: AGENT_MESSAGE_CUSTOM_TYPE,
        content,
        display: true,
        details: data,
      },
      content,
    );
    this.emit({ type: "main-line", line: this.agentMessageLine(data) });
  }

  private formatAgentList(): string {
    const agents = this.getAgents();
    if (!agents.length) return "No subagents.";
    return agents.map((agent) =>
      `${agent.id}  ${agent.name}  ${agent.status}\n  ${agent.worktree.branch}\n  ${agent.worktree.path}`,
    ).join("\n");
  }

  async stop(id: string, status: SubagentStatus = "stopped", persist = true): Promise<void> {
    const record = this.findRecord(id);
    if (!record) return;
    if (record.dispose) await record.dispose();
    record.snapshot.transcript.pending = [];
    if (persist) this.updateStatus(record, status);
    else {
      record.snapshot.status = status;
      record.snapshot.updatedAt = Date.now();
    }
  }

  private async stopAll(status: SubagentStatus, persist: boolean): Promise<void> {
    for (const record of this.records.values()) {
      if (record.dispose) await record.dispose();
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
    const managedAgent = this.findRecord(target);
    if (managedAgent && ["starting", "running"].includes(managedAgent.snapshot.status)) {
      throw new Error(`Stop ${managedAgent.snapshot.name} before ${action}`);
    }
    const record = managedAgent?.snapshot.worktree
      ?? (await listWorktrees(cwd)).find((item) => item.name === target || item.branch === target);
    if (!record) throw new Error(`Unknown worktree: ${target}`);
    if (action === "status") return textResult(await worktreeStatus(cwd, record), record);
    if (action === "merge") {
      return this.withWorktreeLock(async () => {
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
        if (managedAgent) await this.stop(managedAgent.snapshot.id, "stopped");
        await removeWorktree(cwd, record, force);
        if (managedAgent) this.forgetManagedAgent(managedAgent);
        return textResult(`Removed ${record.name}`, record);
      });
    }
    throw new Error(`Unknown worktree action: ${action}`);
  }
}

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessageKind, Line, PendingLine } from "../transcript";
import type { WorktreeRecord } from "../worktree";
import type { AgentUsage } from "../agent-usage";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  EXTERNAL_TRIGGER_CUSTOM_TYPE,
  type ExternalTriggerEventData,
} from "../triggers/types";

export const SUBAGENT_CUSTOM_TYPE = "pum.subagent";
export const AGENT_MESSAGE_CUSTOM_TYPE = "pum.agent_message";
export const AGENT_MESSAGE_DISPLAY_TYPE = "pum.agent_message_display";
export const TOOL_EVENT_CUSTOM_TYPE = "pum.tool_event";
/** A display-only notice PUM wrote into an agent's transcript, replayed on resume. */
export const AGENT_NOTICE_CUSTOM_TYPE = "pum.agent_notice";
export const TRIGGER_EVENT_CUSTOM_TYPE = EXTERNAL_TRIGGER_CUSTOM_TYPE;
/** Hidden user-message prefix used only to guarantee that the main loop wakes. */
export const SUBAGENT_WAKE_PREFIX = "[PUM internal subagent wake]";

/** A plain worker, or the goal judge that reviews after a settled turn. */
export type SubagentRole = "worker" | "judge" | "afk";

/**
 * Roles PUM drives for itself. They never join the managed tree, never count
 * toward capacity, and never own a worktree, so every place that walks the
 * user's agents has to skip them.
 */
export function isInternalRole(role: SubagentRole | undefined): boolean {
  return role === "judge" || role === "afk";
}

export type SubagentStatus =
  | "starting"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type AgentStream = { kind: "assistant" | "thinking"; text: string } | null;

export type AgentTranscript = {
  lines: Line[];
  stream: AgentStream;
  pending: PendingLine[];
};

export type SpawnContextMode = "fresh" | "fork";

export type ForkOrigin = {
  sourceSessionId: string;
  cutoffEntryId: string | null;
  sourceAgentId: string | null;
};

/** Immutable runtime capture. Only origin is persisted in the subagent snapshot. */
export type ForkSource = {
  origin: ForkOrigin;
  sourceSessionFile?: string;
  entries: readonly SessionEntry[];
};

export type SubagentSnapshot = {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  worktree: WorktreeRecord;
  /** True when PUM created an isolated worktree. Missing legacy values mean true for workers. */
  usesWorktree?: boolean;
  sessionFile?: string;
  /** The retained agent that spawned this agent. Missing legacy values mean main. */
  parentAgentId: string | null;
  modelId: string;
  thinkingLevel: string;
  /** True when the child must not mutate files or delegate filesystem mutation. Missing legacy values mean false. */
  readonly?: boolean;
  /** Set for a goal judge. Judges review; they never count as workers and never delegate. */
  role?: SubagentRole;
  /** Present only when this child inherited an exact requester conversation branch. */
  forkOrigin?: ForkOrigin;
  transcript: AgentTranscript;
  summary?: string;
  startedAt: number;
  updatedAt: number;
  runStartedAt?: number;
  usage: AgentUsage;
};

export type SubagentSettlement = {
  id: string;
  messageId: string;
  agentId: string;
  parentAgentId: string | null;
  status: "idle" | "completed" | "failed";
  summary?: string;
  agentName?: string;
  requesterName?: string;
  activityGeneration: number;
  content: string;
  createdAt: number;
  response?: string;
  respondedAt?: number;
  acknowledgedAt?: number;
};

export type SubagentRegistryEvent = {
  event: "spawned" | "status" | "usage" | "activity" | "finish" | "settlement" | "removed";
  id: string;
  at: number;
  snapshot?: Omit<SubagentSnapshot, "transcript">;
  status?: SubagentStatus;
  summary?: string;
  usage?: AgentUsage;
  activityGeneration?: number;
  idleNotifiedGeneration?: number;
  finishSummary?: string | null;
  settlement?: SubagentSettlement;
};

export type AgentMessageData = {
  id: string;
  sender: string;
  recipient: string;
  text: string;
  at: number;
  kind?: AgentMessageKind;
};

export type TriggerEventData = ExternalTriggerEventData & {
  id: string;
  text: string;
};

export type SubagentManagerEvent =
  | { type: "changed" }
  | { type: "news-changed" }
  | { type: "main-line"; line: Line }
  | { type: "main-pending-add"; pending: PendingLine }
  | { type: "main-pending-resolve"; id: string }
  | { type: "main-pending-drop"; id: string }
  | {
    type: "trigger-target";
    sessionId: string;
    agentId: string | null;
    available: boolean;
    settled: boolean;
  };

export type SpawnSubagentOptions = {
  task: string;
  name?: string;
  modelId: string;
  thinkingLevel: string;
  readonly?: boolean;
  /** True creates an isolated worktree. The default runs the agent in the launch project. */
  createWorktree?: boolean;
  role?: SubagentRole;
  parentAgentId?: string | null;
  context?: SpawnContextMode;
  /** Runtime-only immutable branch capture. This value is not persisted. */
  forkSource?: ForkSource;
  /** Runtime-only judge sink. Set before the first turn so no verdict can race it. */
  onGoalVerdict?: (raw: unknown) => void;
  /** Receives the delegate's single AFK answer. Set before the first turn. */
  onAfkAnswer?: (raw: unknown) => void;
};

export type RoutedPrompt = {
  text: string;
  images?: ImageContent[];
};

/** A move the main agent asked for through the worktree tool. */
export type RelocationRequest =
  | { action: "start"; directory?: string }
  | { action: "return" };

/**
 * What the App decided. `accepted` false means nothing was scheduled, and the
 * message says why, so the model learns the rule instead of retrying blind.
 */
export type RelocationRequestResult = {
  accepted: boolean;
  message: string;
};


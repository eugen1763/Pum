import type { ImageContent } from "@earendil-works/pi-ai";
import type { Line, PendingLine } from "../transcript";
import type { WorktreeRecord } from "../worktree";
import type { AgentUsage } from "../agent-usage";
import {
  EXTERNAL_TRIGGER_CUSTOM_TYPE,
  type ExternalTriggerEventData,
} from "../triggers/types";

export const SUBAGENT_CUSTOM_TYPE = "pum.subagent";
export const AGENT_MESSAGE_CUSTOM_TYPE = "pum.agent_message";
export const AGENT_MESSAGE_DISPLAY_TYPE = "pum.agent_message_display";
export const TOOL_EVENT_CUSTOM_TYPE = "pum.tool_event";
export const TRIGGER_EVENT_CUSTOM_TYPE = EXTERNAL_TRIGGER_CUSTOM_TYPE;
/** Hidden user-message prefix used only to guarantee that the main loop wakes. */
export const SUBAGENT_WAKE_PREFIX = "[PUM internal subagent wake]";

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

export type SubagentSnapshot = {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  worktree: WorktreeRecord;
  sessionFile?: string;
  /** The retained agent that spawned this agent. Missing legacy values mean main. */
  parentAgentId: string | null;
  modelId: string;
  thinkingLevel: string;
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
  activityGeneration: number;
  content: string;
  createdAt: number;
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
  kind?: "message" | "acknowledgement" | "idle" | "completion" | "status" | "user-instruction" | "reminder";
};

export type TriggerEventData = ExternalTriggerEventData & {
  id: string;
  text: string;
};

export type SubagentManagerEvent =
  | { type: "changed" }
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
  createWorktree?: boolean;
  parentAgentId?: string | null;
};

export type RoutedPrompt = {
  text: string;
  images?: ImageContent[];
};

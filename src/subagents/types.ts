import type { ImageContent } from "@earendil-works/pi-ai";
import type { Line } from "../transcript";
import type { WorktreeRecord } from "../worktree";

export const SUBAGENT_CUSTOM_TYPE = "pum.subagent";
export const AGENT_MESSAGE_CUSTOM_TYPE = "pum.agent_message";
export const AGENT_MESSAGE_DISPLAY_TYPE = "pum.agent_message_display";
export const TOOL_EVENT_CUSTOM_TYPE = "pum.tool_event";

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
};

export type SubagentSnapshot = {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  worktree: WorktreeRecord;
  sessionFile?: string;
  modelId: string;
  thinkingLevel: string;
  transcript: AgentTranscript;
  summary?: string;
  startedAt: number;
  updatedAt: number;
  runStartedAt?: number;
};

export type SubagentRegistryEvent = {
  event: "spawned" | "status" | "removed";
  id: string;
  at: number;
  snapshot?: Omit<SubagentSnapshot, "transcript">;
  status?: SubagentStatus;
  summary?: string;
};

export type AgentMessageData = {
  id: string;
  sender: string;
  recipient: string;
  text: string;
  at: number;
};

export type SubagentManagerEvent =
  | { type: "changed" }
  | { type: "main-line"; line: Line };

export type SpawnSubagentOptions = {
  task: string;
  name?: string;
  modelId: string;
  thinkingLevel: string;
  createWorktree?: boolean;
};

export type RoutedPrompt = {
  text: string;
  images?: ImageContent[];
};

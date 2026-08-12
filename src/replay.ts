import type { Line } from "./transcript";
import { isRejectedToolResult, rejectedToolReason } from "./check-mode";
import { bashResultDisplay, editCounts, toolArg, type ToolCall } from "./tool-line";
import { questionnaireDetail } from "./questionnaire";
import { messageCacheDetail } from "./message-cache";
import {
  WEB_SEARCH_CUSTOM_TYPE,
  type SearchCallRecord,
} from "./web-search";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  AGENT_MESSAGE_DISPLAY_TYPE,
  SUBAGENT_WAKE_PREFIX,
  TOOL_EVENT_CUSTOM_TYPE,
  TRIGGER_EVENT_CUSTOM_TYPE,
  type AgentMessageData,
  type TriggerEventData,
} from "./subagents/types";

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("")
    .trim();
  const markers = content
    .filter((b: any) => b?.type === "image")
    .map((_b: any, index: number) => `[Image #${index + 1}]`)
    .join(" ");
  return [text, markers].filter(Boolean).join(" ");
};

function agentMessageOf(entry: any): AgentMessageData | undefined {
  const isDisplay = entry?.type === "custom" && entry.customType === AGENT_MESSAGE_DISPLAY_TYPE;
  const isMessage = entry?.type === "custom_message" && entry.customType === AGENT_MESSAGE_CUSTOM_TYPE;
  if (!isDisplay && !isMessage) return undefined;
  const data = isDisplay ? entry.data : entry.details;
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.sender !== "string" || typeof data.recipient !== "string") return undefined;
  return {
    id: typeof data.id === "string" ? data.id : `${entry.id ?? "message"}`,
    sender: data.sender,
    recipient: data.recipient,
    text: typeof data.text === "string" ? data.text : textOf(entry.content),
    at: typeof data.at === "number" ? data.at : 0,
  };
}

function triggerEventOf(entry: any): TriggerEventData | undefined {
  const isEntry = entry?.type === "custom" && entry.customType === TRIGGER_EVENT_CUSTOM_TYPE;
  const isMessage = entry?.type === "custom_message" && entry.customType === TRIGGER_EVENT_CUSTOM_TYPE;
  if (!isEntry && !isMessage) return undefined;
  const data = isEntry ? entry.data : entry.details;
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.id !== "string"
    || typeof data.triggerId !== "string"
    || typeof data.name !== "string"
    || typeof data.target?.sessionId !== "string"
    || (data.target.agentId !== null && typeof data.target.agentId !== "string")
    || typeof data.text !== "string"
    || typeof data.at !== "number") return undefined;
  return data as TriggerEventData;
}

function toolEventOf(entry: any): ToolCall | undefined {
  if (entry?.type !== "custom" || entry.customType !== TOOL_EVENT_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  if (!data || typeof data.id !== "string" || typeof data.name !== "string") return undefined;
  if (!["running", "ok", "error", "rejected"].includes(data.state)) return undefined;
  return {
    id: data.id,
    name: data.name,
    arg: typeof data.arg === "string" ? data.arg : "",
    state: data.state,
    detail: typeof data.detail === "string" ? data.detail : undefined,
  };
}

function searchRecordOf(entry: any): SearchCallRecord | undefined {
  if (entry?.type !== "custom" || entry.customType !== WEB_SEARCH_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object" || typeof data.id !== "string") return undefined;
  if (![
    "running",
    "ok",
    "error",
  ].includes(data.state)) return undefined;
  return {
    id: data.id,
    query: typeof data.query === "string" ? data.query : "",
    state: data.state,
  };
}

/**
 * Rebuild transcript lines from a restored session's active entries, so
 * `pum -r` shows the conversation rather than an empty pane. Messages come
 * from pi and are typed loosely, so every access here is defensive.
 */
export function replayEntries(
  entries: readonly any[],
  cwd: string,
  showThinking: boolean,
): Line[] {
  const lines: Line[] = [];
  const calls = new Map<string, ToolCall>();
  const searchCalls = new Map<string, ToolCall>();
  const customCalls = new Map<string, ToolCall>();
  const agentMessages = new Set<string>();

  for (const entry of entries) {
    const agentMessage = agentMessageOf(entry);
    if (agentMessage) {
      if (!agentMessages.has(agentMessage.id)) {
        agentMessages.add(agentMessage.id);
        lines.push({
          kind: "agent-message",
          sender: agentMessage.sender,
          recipient: agentMessage.recipient,
          text: agentMessage.text,
          messageId: agentMessage.id,
        });
      }
      continue;
    }

    const triggerEvent = triggerEventOf(entry);
    if (triggerEvent) {
      if (!agentMessages.has(triggerEvent.id)) {
        agentMessages.add(triggerEvent.id);
        lines.push({
          kind: "agent-message",
          sender: `trigger:${triggerEvent.name}`,
          recipient: triggerEvent.target.agentId ?? "main",
          text: triggerEvent.text,
        });
      }
      continue;
    }

    const customCall = toolEventOf(entry);
    if (customCall) {
      const existing = customCalls.get(customCall.id);
      if (existing) Object.assign(existing, customCall);
      else {
        customCalls.set(customCall.id, customCall);
        lines.push({ kind: "tool", call: customCall });
      }
      continue;
    }

    const search = searchRecordOf(entry);
    if (search) {
      const existing = searchCalls.get(search.id);
      if (existing) {
        existing.state = search.state;
        if (search.query) existing.arg = search.query;
      } else {
        const call: ToolCall = {
          id: search.id,
          name: "web_search",
          arg: search.query,
          state: search.state,
        };
        searchCalls.set(search.id, call);
        lines.push({ kind: "tool", call });
      }
      continue;
    }

    // Accept raw AgentMessages too; this keeps the replay helper useful for
    // callers that already have `agent.state.messages`.
    const message = entry?.type === "message" ? entry.message : entry;

    if (message?.role === "user") {
      const text = textOf(message.content);
      if (text.startsWith(SUBAGENT_WAKE_PREFIX)) continue;
      if (text) lines.push({ kind: "text", role: "user", text });
      continue;
    }

    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text" && block.text?.trim()) {
          lines.push({ kind: "text", role: "assistant", text: block.text.trim() });
        } else if (showThinking && block?.type === "thinking" && block.thinking?.trim()) {
          lines.push({ kind: "text", role: "thinking", text: block.thinking.trim() });
        } else if (block?.type === "toolCall") {
          const call: ToolCall = {
            id: block.id,
            name: block.name,
            arg: toolArg(block.name, block.arguments, cwd),
            // Anything replayed has already finished; a matching result may
            // downgrade this to an error below.
            state: "ok",
          };
          calls.set(block.id, call);
          lines.push({ kind: "tool", call });
        }
      }
      continue;
    }

    if (message?.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call) {
        call.state = isRejectedToolResult(message)
          ? "rejected"
          : message.isError
            ? "error"
            : "ok";
        if (call.name === "bash" && call.state !== "rejected") {
          const bashResult = bashResultDisplay(message);
          call.output = bashResult.output;
          call.exitCode = bashResult.exitCode;
        }
        if (call.state === "rejected") call.detail = rejectedToolReason(message);
        else if (call.name === "edit" || call.name === "apply_patch") call.detail = editCounts(message);
        else if (call.name === "questionnaire") call.detail = questionnaireDetail(message);
        else if (call.name.startsWith("message_cache_")) call.detail = messageCacheDetail(message);
      }
    }
  }

  return lines;
}

/** Backwards-compatible name for replaying a list of messages. */
export const replayMessages = replayEntries;

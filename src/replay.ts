import type { Line } from "./transcript";
import { isRejectedToolResult, rejectedToolReason } from "./check-mode";
import { bashResultDisplay, editCounts, toolArgs, type ToolCall } from "./tool-line";
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
  AGENT_NOTICE_CUSTOM_TYPE,
  TOOL_EVENT_CUSTOM_TYPE,
  TRIGGER_EVENT_CUSTOM_TYPE,
  type AgentMessageData,
  type TriggerEventData,
} from "./subagents/types";
import {
  MANAGED_SHELL_COMPLETION_TYPE,
  MANAGED_SHELL_CUSTOM_TYPE,
  type ManagedShellCompletionMessage,
  type ManagedShellLifecycleEvent,
} from "./shells/types";
import { settledUserBashCall } from "./user-bash";

/** Shown on a replayed tool call whose turn ended before a result was stored. */
export const INTERRUPTED_TOOL_DETAIL = "interrupted";

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

function managedShellEventOf(entry: any): ManagedShellLifecycleEvent | undefined {
  if (entry?.type !== "custom" || entry.customType !== MANAGED_SHELL_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object") return undefined;
  if (data.version !== 1
    || typeof data.shellId !== "string"
    || typeof data.name !== "string"
    || typeof data.owner?.sessionId !== "string"
    || (data.owner.agentId !== null && typeof data.owner.agentId !== "string")
    || typeof data.owner.label !== "string"
    || !["started", "exited", "failed", "terminated", "unavailable"].includes(data.state)
    || typeof data.executable !== "string"
    || !Array.isArray(data.args)
    || data.args.some((arg: unknown) => typeof arg !== "string")
    || typeof data.cwd !== "string"
    || typeof data.at !== "number"
    || typeof data.startedAt !== "number") return undefined;
  return data as ManagedShellLifecycleEvent;
}

function managedShellCompletionOf(entry: any): ManagedShellCompletionMessage | undefined {
  if (entry?.type !== "custom_message" || entry.customType !== MANAGED_SHELL_COMPLETION_TYPE) return undefined;
  const data = entry.details;
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.id !== "string"
    || typeof data.shellId !== "string"
    || typeof data.name !== "string"
    || typeof data.owner?.sessionId !== "string"
    || (data.owner.agentId !== null && typeof data.owner.agentId !== "string")
    || typeof data.owner.label !== "string"
    || typeof data.text !== "string"
    || typeof data.at !== "number") return undefined;
  return data as ManagedShellCompletionMessage;
}

function managedShellReplayText(event: ManagedShellLifecycleEvent): string {
  const label = `Managed shell ${event.name} (${event.shellId})`;
  if (event.state === "started") {
    return `${label} started: ${[event.executable, ...event.args].join(" ")}`;
  }
  if (event.state === "terminated") return `${label} was terminated intentionally.`;
  if (event.state === "unavailable") {
    return `${label} became unavailable${event.reason ? `: ${event.reason}` : "."}`;
  }
  const result = event.signal ? `signal ${event.signal}` : `exit code ${event.exitCode ?? "unknown"}`;
  return event.state === "failed"
    ? `${label} failed with ${result}.`
    : `${label} exited with ${result}.`;
}

/** A display-only notice PUM wrote into a transcript. Never model context. */
function agentNoticeOf(entry: any): Line | undefined {
  if (entry?.type !== "custom" || entry.customType !== AGENT_NOTICE_CUSTOM_TYPE) return undefined;
  const line = entry.data?.line;
  if (!line || typeof line.text !== "string" || line.kind !== "text") return undefined;
  const role = line.role === "error" ? "error" : "system";
  return { kind: "text", role, text: line.text };
}

function toolEventOf(entry: any): ToolCall | undefined {
  if (entry?.type !== "custom" || entry.customType !== TOOL_EVENT_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  if (!data || typeof data.id !== "string" || typeof data.name !== "string") return undefined;
  if (!["running", "ok", "error", "rejected"].includes(data.state)) return undefined;
  return {
    id: data.id,
    name: data.name,
    // Synthetic tool events persist one flat display string.
    args: typeof data.arg === "string" && data.arg ? [data.arg] : [],
    state: data.state,
    detail: typeof data.detail === "string" ? data.detail : undefined,
  };
}

function searchRecordOf(entry: any): SearchCallRecord | undefined {
  if (entry?.type !== "custom" || entry.customType !== WEB_SEARCH_CUSTOM_TYPE) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object" || typeof data.id !== "string") return undefined;
  if (!["running", "ok", "error"].includes(data.state)) return undefined;
  return {
    id: data.id,
    query: typeof data.query === "string" ? data.query : "",
    state: data.state,
  };
}

/** Rebuild transcript lines from a restored session's active entries. */
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
  const managedShells = new Map<string, ManagedShellLifecycleEvent>();

  for (const entry of entries) {
    const shellCompletion = managedShellCompletionOf(entry);
    if (shellCompletion) {
      if (!agentMessages.has(shellCompletion.id)) {
        agentMessages.add(shellCompletion.id);
        lines.push({
          kind: "agent-message",
          sender: `shell:${shellCompletion.name}`,
          recipient: shellCompletion.owner.agentId ?? "main",
          text: shellCompletion.text,
          messageId: shellCompletion.id,
        });
      }
      continue;
    }

    const shellEvent = managedShellEventOf(entry);
    if (shellEvent) {
      managedShells.set(shellEvent.shellId, shellEvent);
      lines.push({ kind: "text", role: "system", text: managedShellReplayText(shellEvent) });
      continue;
    }

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

    const notice = agentNoticeOf(entry);
    if (notice) {
      lines.push(notice);
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
        if (search.query) existing.args = [search.query];
      } else {
        const call: ToolCall = {
          id: search.id,
          name: "web_search",
          args: [search.query],
          state: search.state,
        };
        searchCalls.set(search.id, call);
        lines.push({ kind: "tool", call });
      }
      continue;
    }

    const message = entry?.type === "message" ? entry.message : entry;

    if (message?.role === "bashExecution" && typeof message.command === "string") {
      const call: ToolCall = {
        id: `user-bash:${entry?.id ?? lines.length}`,
        name: "bash",
        args: [message.command.split("\n")[0]!.trim()],
        state: "running",
        input: { command: message.command },
      };
      Object.assign(call, settledUserBashCall({
        output: typeof message.output === "string" ? message.output : "",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined,
        cancelled: message.cancelled === true,
        truncated: message.truncated === true,
        fullOutputPath: typeof message.fullOutputPath === "string" ? message.fullOutputPath : undefined,
      }));
      lines.push({ kind: "tool", call });
      continue;
    }

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
            args: toolArgs(block.name, block.arguments, cwd),
            // Nothing proves a replayed call succeeded until its persisted
            // result says so. A call whose turn was cancelled or crashed never
            // gets one, and statsFromEntries already counts that as
            // interrupted, so replay must not show it as a green check.
            state: "error",
            detail: INTERRUPTED_TOOL_DETAIL,
            input: block.arguments,
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
        call.result = message;
        call.isError = message.isError === true;
        call.state = isRejectedToolResult(message)
          ? "rejected"
          : message.isError
            ? "error"
            : "ok";
        if (call.name === "bash" && call.state !== "rejected") {
          const bashResult = bashResultDisplay(message);
          call.exitCode = bashResult.exitCode;
        }
        // The result decides the note, so drop the interrupted placeholder.
        call.detail = undefined;
        if (call.state === "rejected") call.detail = rejectedToolReason(message);
        else if (call.name === "edit" || call.name === "apply_patch" || call.name === "apply_path") call.detail = editCounts(message);
        else if (call.name === "questionnaire") call.detail = questionnaireDetail(message);
        else if (call.name.startsWith("message_cache_")) call.detail = messageCacheDetail(message);
      }
    }
  }

  for (const event of managedShells.values()) {
    if (event.state !== "started") continue;
    lines.push({
      kind: "text",
      role: "system",
      text: `Managed shell ${event.name} (${event.shellId}) is no longer available after restart.`,
    });
  }

  return lines;
}

/** Backwards-compatible name for replaying a list of messages. */
export const replayMessages = replayEntries;

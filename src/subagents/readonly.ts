import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { rejectedToolDetails } from "../check-mode";
import { TODO_TOOL_NAMES } from "../todo-tools";

const SAFE_TOOLS = new Set([
  "read",
  "bash",
  "questionnaire",
  "finish_subagent",
  "enable_tools",
  "list_subagents",
  "stop_subagent",
  "message_cache_list",
  "message_cache_read",
  "list_triggers",
  "inspect_trigger",
  "pause_trigger",
  "cancel_trigger",
  "web_search",
  "goal_verdict",
  // Todo tools touch one companion file the child already owns. Listing a task
  // is not a project mutation, so a readonly child keeps its own plan.
  ...TODO_TOOL_NAMES,
]);

export function readonlyToolBlockReason(
  toolName: string,
  input: Record<string, unknown> = {},
): string | undefined {
  if (SAFE_TOOLS.has(toolName)) return undefined;
  if (toolName === "worktree") {
    return ["list", "status"].includes(String(input.action))
      ? undefined
      : `readonly child cannot run worktree ${String(input.action ?? "mutation")}`;
  }
  return `readonly child cannot use ${toolName}`;
}

/** Fail closed for every child tool path that can bypass readonly filesystem controls. */
export function readonlySubagentExtension(readonly: boolean): InlineExtension {
  return {
    name: "pum-readonly-subagent-guard",
    factory(pi) {
      if (!readonly) return;
      const rejected = new Map<string, string>();
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n## Readonly child\n\n`
          + "- Inspect files and run non-mutating commands only.\n"
          + "- Do not use or delegate filesystem mutation.\n"
          + "- File mutation tools and mutation-capable child services are blocked.\n"
          + "- Bash runs only with native sandbox enforcement and read-only project roots.",
      }));
      pi.on("tool_call", (event) => {
        const reason = readonlyToolBlockReason(
          event.toolName,
          event.input as Record<string, unknown>,
        );
        if (!reason) return;
        const visibleReason = `Readonly subagent blocked ${event.toolName}: ${reason}`;
        rejected.set(event.toolCallId, visibleReason);
        return { block: true, reason: visibleReason };
      });
      pi.on("tool_result", (event) => {
        const reason = rejected.get(event.toolCallId);
        if (!reason) return;
        return { details: rejectedToolDetails(event.details, reason) };
      });
      pi.on("message_end", (event) => {
        const message = event.message as any;
        if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") return;
        const reason = rejected.get(message.toolCallId);
        if (!reason) return;
        rejected.delete(message.toolCallId);
        return { message: { ...message, details: rejectedToolDetails(message.details, reason) } };
      });
    },
  };
}

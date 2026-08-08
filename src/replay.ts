import type { Line } from "./transcript";
import { editCounts, toolArg, type ToolCall } from "./tool-line";

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("")
    .trim();
};

/**
 * Rebuild transcript lines from a restored session's messages, so `pum -r`
 * shows the conversation rather than an empty pane. Messages come from pi and
 * are typed loosely, so every access here is defensive.
 */
export function replayMessages(
  messages: readonly any[],
  cwd: string,
  showThinking: boolean,
): Line[] {
  const lines: Line[] = [];
  const calls = new Map<string, ToolCall>();

  for (const message of messages) {
    if (message?.role === "user") {
      const text = textOf(message.content);
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
        call.state = message.isError ? "error" : "ok";
        if (call.name === "edit") call.detail = editCounts(message);
      }
    }
  }

  return lines;
}

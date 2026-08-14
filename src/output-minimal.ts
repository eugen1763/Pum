import type { Line } from "./transcript";
import type { ToolCall } from "./tool-line";

export type MinimalToolSummaryLine = {
  kind: "tool-summary";
  text: string;
  calls: ToolCall[];
};

export type MinimalTranscriptLine = Line | MinimalToolSummaryLine;

type ToolPhrase = {
  singular: string;
  plural(count: number): string;
};

const counted = (verb: string, singular: string, plural = `${singular}s`): ToolPhrase => ({
  singular: `${verb} 1 ${singular}`,
  plural: (count) => `${verb} ${count} ${plural}`,
});

const repeated = (label: string): ToolPhrase => ({
  singular: label,
  plural: (count) => `${label} ${count} times`,
});

/** Friendly minimal-mode text for every tool currently registered by PUM. */
const TOOL_PHRASES: Readonly<Record<string, ToolPhrase>> = {
  read: counted("Read", "file"),
  write: counted("Wrote", "file"),
  edit: counted("Edited", "file"),
  apply_patch: counted("Applied", "patch", "patches"),
  bash: counted("Ran", "command"),
  web_search: counted("Ran", "web search", "web searches"),
  questionnaire: counted("Asked", "questionnaire"),
  enable_tools: counted("Enabled", "tool group"),

  spawn_subagent: counted("Spawned", "subagent"),
  message_agent: counted("Sent", "agent message"),
  list_subagents: repeated("Listed subagents"),
  stop_subagent: counted("Stopped", "subagent"),
  finish_subagent: counted("Finished", "subagent task"),
  worktree: counted("Ran", "worktree operation"),

  create_trigger: counted("Created", "trigger"),
  list_triggers: repeated("Listed triggers"),
  inspect_trigger: counted("Inspected", "trigger"),
  pause_trigger: counted("Paused", "trigger"),
  resume_trigger: counted("Resumed", "trigger"),
  cancel_trigger: counted("Cancelled", "trigger"),
  invoke_trigger: counted("Ran", "trigger"),

  message_cache_list: repeated("Listed the message cache"),
  message_cache_read: counted("Read", "cached message"),
  message_cache_add: counted("Added", "cached message"),
  message_cache_delete: counted("Deleted", "cached message"),
  message_cache_send: counted("Sent", "cached task batch", "cached task batches"),

  start_shell: counted("Started", "shell"),
  list_shells: repeated("Listed shells"),
  inspect_shell: counted("Inspected", "shell"),
  get_shell_output: repeated("Read shell output"),
  kill_shell: counted("Killed", "shell"),
};

function fallbackToolLabel(name: string): string {
  const words = name.replaceAll("_", " ").trim();
  return words || "unknown";
}

/** Summarize one tool type without exposing its arguments. */
export function minimalToolPhrase(name: string, count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Tool summary count must be a positive integer");
  }
  const phrase = TOOL_PHRASES[name];
  if (phrase) return count === 1 ? phrase.singular : phrase.plural(count);
  const label = fallbackToolLabel(name);
  return count === 1 ? `Completed 1 ${label} call` : `Completed ${count} ${label} calls`;
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return `${phrases[0]}.`;
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}.`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}.`;
}

/**
 * Summarize one consecutive run of successful tool calls.
 *
 * Tool types stay in first-occurrence order. Repeated types combine even when
 * another successful tool type occurs between them.
 */
export function summarizeSuccessfulToolCalls(calls: readonly ToolCall[]): MinimalToolSummaryLine {
  if (calls.length === 0 || calls.some((call) => call.state !== "ok")) {
    throw new Error("A minimal tool summary requires one or more successful calls");
  }
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const phrases = [...counts].map(([name, count]) => minimalToolPhrase(name, count));
  return {
    kind: "tool-summary",
    text: joinPhrases(phrases),
    calls: calls.map((call) => ({ ...call })),
  };
}

/**
 * Convert transcript lines for minimal output mode.
 *
 * Every non-tool line and every non-successful tool call ends a success run.
 * Running, failed, and rejected calls remain unchanged with their details.
 */
export function minimalTranscriptLines(lines: readonly Line[]): MinimalTranscriptLine[] {
  const result: MinimalTranscriptLine[] = [];
  let successful: ToolCall[] = [];

  const flush = () => {
    if (successful.length === 0) return;
    result.push(summarizeSuccessfulToolCalls(successful));
    successful = [];
  };

  for (const line of lines) {
    if (line.kind === "tool" && line.call.state === "ok") {
      successful.push(line.call);
      continue;
    }
    flush();
    result.push(line);
  }
  flush();
  return result;
}

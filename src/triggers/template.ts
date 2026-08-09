import type { ExternalTriggerEventData, TriggerSnapshot } from "./types";

export const DEFAULT_TRIGGER_MESSAGE_TEMPLATE = [
  "External trigger {{name}} ({{triggerId}}) finished.",
  "Exit code: {{exitCode}}",
  "Output: {{outputPath}}",
  "{{reason}}",
].join("\n");

export type TriggerTemplateValues = {
  triggerId: string;
  name: string;
  sessionId: string;
  agentId: string;
  state: string;
  fireCount: string;
  pendingCount: string;
  coalescedCount: string;
  exitCode: string;
  signal: string;
  outputPath: string;
  outputBytes: string;
  outputTruncated: string;
  reason: string;
};

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

export function triggerTemplateValues(snapshot: TriggerSnapshot, event: ExternalTriggerEventData): TriggerTemplateValues {
  const result = event.result;
  return {
    triggerId: snapshot.id,
    name: snapshot.name,
    sessionId: snapshot.target.sessionId,
    agentId: snapshot.target.agentId ?? "main",
    state: event.state,
    fireCount: String(event.fireCount),
    pendingCount: String(event.pendingCount),
    coalescedCount: String(event.coalescedCount),
    exitCode: result ? String(result.exitCode) : "",
    signal: result?.signal ?? "",
    outputPath: result?.output?.path ?? "",
    outputBytes: result?.output ? String(result.output.bytes) : "",
    outputTruncated: result?.output?.truncated ? "yes" : "no",
    reason: event.reason ?? "",
  };
}

/** Render known literal placeholders. This function does not evaluate expressions or shell text. */
export function renderTriggerTemplate(template: string, values: TriggerTemplateValues): string {
  return template.replace(PLACEHOLDER, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key as keyof TriggerTemplateValues] : match,
  ).trim();
}

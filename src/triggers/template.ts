import type { ExternalTriggerEventData, TriggerSnapshot } from "./types";

export const DEFAULT_TRIGGER_MESSAGE_TEMPLATE = [
  "External trigger {{triggerName}} ({{triggerId}}) finished.",
  "Exit code: {{exitCode}}",
  "Output: {{outputFile}}",
].join("\n");

export const TRIGGER_TEMPLATE_FIELDS = [
  "triggerName",
  "triggerId",
  "exitCode",
  "signal",
  "durationMs",
  "fireCount",
  "outputFile",
  "startedAt",
  "finishedAt",
  "executable",
  "args",
  "outputTruncated",
] as const;

export type TriggerTemplateField = (typeof TRIGGER_TEMPLATE_FIELDS)[number];
export type TriggerTemplateValues = Record<TriggerTemplateField, string>;

const FIELD_SET = new Set<string>(TRIGGER_TEMPLATE_FIELDS);
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/** Reject anything except the documented literal `{{field}}` placeholders. */
export function validateTriggerTemplate(template: string): void {
  if (!template.trim()) throw new Error("Trigger template is required");
  const stripped = template.replace(PLACEHOLDER, (_match, field: string) => {
    if (!FIELD_SET.has(field)) throw new Error(`Unknown trigger template field: ${field}`);
    return "";
  });
  if (stripped.includes("{{") || stripped.includes("}}")) {
    throw new Error("Malformed trigger template; use simple {{field}} placeholders only");
  }
}

export function triggerTemplateValues(
  snapshot: TriggerSnapshot,
  event: ExternalTriggerEventData,
): TriggerTemplateValues {
  const result = event.result;
  return {
    triggerId: snapshot.id,
    triggerName: snapshot.name,
    fireCount: String(event.fireCount),
    exitCode: result?.exitCode === null || result?.exitCode === undefined ? "" : String(result.exitCode),
    signal: result?.signal ?? "",
    durationMs: result ? String(result.durationMs) : "",
    outputFile: result?.output?.path ?? "",
    startedAt: result ? new Date(result.startedAt).toISOString() : "",
    finishedAt: result ? new Date(result.finishedAt).toISOString() : "",
    executable: snapshot.executable,
    args: JSON.stringify(snapshot.args),
    outputTruncated: result?.output?.truncated ? "yes" : "no",
  };
}

/** Render validated placeholders without expressions, traversal, shell expansion, or evaluation. */
export function renderTriggerTemplate(template: string, values: TriggerTemplateValues): string {
  validateTriggerTemplate(template);
  return template.replace(PLACEHOLDER, (_match, key: string) => values[key as TriggerTemplateField]).trim();
}

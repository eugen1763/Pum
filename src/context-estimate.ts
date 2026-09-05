import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Deliberately conservative heuristics, not a tokenizer or a provider guarantee. */
export const CONTEXT_IMAGE_TOKENS = 1200;
export const CONTEXT_MESSAGE_TOKENS = 16;
export const CONTEXT_CALIBRATION_MIN_TOKENS = 1024;
export const CONTEXT_CALIBRATION_MAX_FACTOR = 2;
export const estimateContextText = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3);

export function estimateContextMessage(message: AgentMessage): number {
  let tokens = CONTEXT_MESSAGE_TOKENS;
  switch (message.role) {
    case "bashExecution":
      return tokens + estimateContextText(message.command) + estimateContextText(message.output);
    case "branchSummary":
    case "compactionSummary":
      return tokens + estimateContextText(message.summary);
    case "user":
    case "custom":
    case "toolResult":
    case "assistant":
      if (typeof message.content === "string") return tokens + estimateContextText(message.content);
      for (const part of message.content) {
        if (part.type === "image") tokens += CONTEXT_IMAGE_TOKENS;
        else if (part.type === "text") tokens += estimateContextText(part.text);
        else if (part.type === "thinking") tokens += estimateContextText(part.thinking);
        else if (part.type === "toolCall") tokens += estimateContextText(part.name + JSON.stringify(part.arguments));
      }
  }
  return tokens;
}

/** Only runtime-paired assistant usage may call this validator. Cost, nested
 * tool usage, and total-only/all-zero placeholders are not calibration evidence. */
export function contextUsage(value: unknown): { total: number; input: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
  if (!values.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  const [input, output, read, write, total] = values as number[];
  const prompt = input! + read! + write!;
  const components = prompt + output!;
  if (prompt <= 0 || !Number.isSafeInteger(components)) return undefined;
  // Providers can normalize total differently. Taking the larger count is
  // conservative; a disagreeing total cannot train the prompt-only ratio.
  return { total: Math.max(components, total!), input: total! > components ? 0 : prompt };
}

export function contextCalibration(inputTokens: number, estimatedInputTokens: number) {
  const eligible = Number.isSafeInteger(inputTokens) && inputTokens > 0
    && Number.isSafeInteger(estimatedInputTokens) && estimatedInputTokens >= CONTEXT_CALIBRATION_MIN_TOKENS;
  const ratio = eligible ? inputTokens / estimatedInputTokens : 1;
  return { factor: Math.max(1, Math.min(CONTEXT_CALIBRATION_MAX_FACTOR, ratio)),
    limited: ratio > CONTEXT_CALIBRATION_MAX_FACTOR, eligible };
}

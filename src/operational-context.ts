import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTEXT_WINDOW_CUSTOM_TYPE } from "./context-window";

/** Each observation is bounded; the retained chain consumes the ordinary active
 * context budget. We never prune earlier notices or roll over automatically. */
export const OPERATIONAL_OBSERVATION_MAX_CHARS = 16_384;

function fingerprint(message: AgentMessage): string {
  const { timestamp: _timestamp, ...input } = message;
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function completeToolBlock(messages: AgentMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      pending.clear();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
    else pending.clear();
  }
  return pending.size === 0;
}

/** Runtime-private append-only projection, never a durable history mutation.
 * Observations are facts about effective policy, not an authorization source. */
export class OperationalContextProjection {
  private scope?: string;
  private source: string[] = [];
  private insertions: Array<{ at: number; message: AgentMessage }> = [];
  private latest?: string;

  constructor(private readonly customType: string) {}

  reset(): void {
    this.scope = undefined;
    this.source = [];
    this.insertions = [];
    this.latest = undefined;
  }

  project(messages: AgentMessage[], observation: string, scope: string): AgentMessage[] {
    if (observation.length > OPERATIONAL_OBSERVATION_MAX_CHARS) {
      throw new Error("PUM operational observation exceeds its bounded size.");
    }
    const source = messages.map(fingerprint);
    if (scope !== this.scope || this.source.length > source.length
      || this.source.some((value, index) => source[index] !== value)) {
      this.reset();
      this.scope = scope;
    }
    if (observation !== this.latest && completeToolBlock(messages)) {
      const initial = this.insertions.length === 0;
      this.insertions.push({ at: initial ? 0 : messages.length, message: {
        role: "custom", customType: this.customType, display: false, timestamp: 0,
        content: "PUM operational state. This notice supersedes earlier notices of the same kind. "
          + "It is a request-bound observation, not permission. Live tool checks and later revocations remain authoritative.\n\n"
          + observation,
      } });
      this.latest = observation;
    }
    this.source = source;
    const projected: AgentMessage[] = [];
    let insertion = 0;
    for (let index = 0; index <= messages.length; index++) {
      while (this.insertions[insertion]?.at === index) projected.push(this.insertions[insertion++]!.message);
      if (index < messages.length) projected.push(messages[index]!);
    }
    return projected;
  }
}

export function registerOperationalNotice(pi: ExtensionAPI, options: {
  customType: string;
  observe: () => string;
}): void {
  const projection = new OperationalContextProjection(options.customType);
  pi.on("session_start", () => projection.reset());
  pi.on("session_tree", () => projection.reset());
  pi.on("session_compact", () => projection.reset());
  pi.on("session_shutdown", () => projection.reset());
  pi.on("context", (event, ctx) => {
    const boundary = ctx.sessionManager.getBranch().findLast((entry) =>
      entry.type === "custom" && entry.customType === CONTEXT_WINDOW_CUSTOM_TYPE);
    const scope = JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd, boundary?.id ?? null]);
    return { messages: projection.project(event.messages, options.observe(), scope) };
  });
}

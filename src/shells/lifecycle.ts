import {
  MANAGED_SHELL_COMPLETION_TYPE,
  MANAGED_SHELL_CUSTOM_TYPE,
  type ManagedShellCompletionMessage,
  type ManagedShellLifecycleEvent,
  type ManagedShellOwnerSelector,
} from "./types";

export type ManagedShellLifecyclePersistence = {
  append(owner: ManagedShellOwnerSelector, customType: string, data: unknown): void;
};

export type ManagedShellCompletionDelivery = {
  deliver(message: {
    customType: typeof MANAGED_SHELL_COMPLETION_TYPE;
    content: string;
    display: true;
    details: ManagedShellCompletionMessage;
  }): Promise<void> | void;
};

/**
 * Persists shell transitions and delivers one owner wake-up for a natural exit.
 * The process manager remains authoritative for process and output state.
 */
export class ManagedShellLifecycleController {
  private readonly delivered = new Set<string>();
  private readonly terminalRecorded = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly persistence: ManagedShellLifecyclePersistence,
    private readonly delivery: ManagedShellCompletionDelivery,
  ) {}

  record(event: ManagedShellLifecycleEvent): void {
    this.persistence.append(event.owner, MANAGED_SHELL_CUSTOM_TYPE, event);
  }

  async recordExit(event: ManagedShellLifecycleEvent, intentional: boolean): Promise<void> {
    if (!intentional && event.state !== "exited") {
      throw new Error("A natural managed-shell exit must use the exited state");
    }
    if (intentional && event.state !== "killed") {
      throw new Error("An intentional managed-shell exit must use the killed state");
    }

    const noticeId = event.noticeId ?? `managed-shell-exit:${event.shellId}`;
    const persisted = { ...event, noticeId };
    if (!this.terminalRecorded.has(noticeId)) {
      this.terminalRecorded.add(noticeId);
      this.record(persisted);
    }
    if (intentional || this.delivered.has(noticeId)) return;

    const active = this.inFlight.get(noticeId);
    if (active) return active;

    const message: ManagedShellCompletionMessage = {
      id: noticeId,
      shellId: event.shellId,
      name: event.name,
      owner: { ...event.owner },
      text: completionText(persisted),
      at: event.at,
    };
    const pending = Promise.resolve(this.delivery.deliver({
      customType: MANAGED_SHELL_COMPLETION_TYPE,
      content: message.text,
      display: true,
      details: message,
    })).then(() => {
      this.delivered.add(noticeId);
    }).finally(() => {
      this.inFlight.delete(noticeId);
    });
    this.inFlight.set(noticeId, pending);
    return pending;
  }

  /** Restore successful delivery ids before a manager retries pending exits. */
  restore(entries: readonly unknown[]): void {
    for (const entry of entries as readonly any[]) {
      if (entry?.type !== "custom_message" || entry.customType !== MANAGED_SHELL_COMPLETION_TYPE) continue;
      const id = entry.details?.id;
      if (typeof id === "string") this.delivered.add(id);
    }
  }
}

export function completionText(event: ManagedShellLifecycleEvent): string {
  const result = event.signal
    ? `signal ${event.signal}`
    : `exit code ${event.exitCode ?? "unknown"}`;
  const runtime = Math.max(0, event.runtimeMs ?? event.at - event.startedAt);
  const output = event.output;
  const lines = [
    `Managed shell ${event.name} (${event.shellId}) exited with ${result}.`,
    `Runtime: ${runtime} ms.`,
  ];
  if (output) {
    lines.push(`Output: ${output.bytes} bytes${output.truncated ? " (truncated)" : ""}.`);
    lines.push(`Path: ${output.path}`);
    if (output.tail?.trim()) lines.push(`Recent output:\n${output.tail.trim()}`);
  }
  return lines.join("\n");
}

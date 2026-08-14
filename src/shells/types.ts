export const MANAGED_SHELL_CUSTOM_TYPE = "pum.managed_shell";
export const MANAGED_SHELL_COMPLETION_TYPE = "pum.managed_shell_completion";

export type ManagedShellOwner = {
  sessionId: string;
  agentId: string | null;
  label: string;
};

export type ManagedShellOutputSummary = {
  path: string;
  bytes: number;
  truncated: boolean;
  tail?: string;
};

export type ManagedShellLifecycleState = "started" | "exited" | "killed" | "unavailable";

/** Durable session data for customType `pum.managed_shell`. */
export type ManagedShellLifecycleEvent = {
  version: 1;
  shellId: string;
  name: string;
  owner: ManagedShellOwner;
  state: ManagedShellLifecycleState;
  executable: string;
  args: string[];
  cwd: string;
  at: number;
  startedAt: number;
  finishedAt: number | null;
  runtimeMs: number | null;
  exitCode: number | null;
  signal: string | null;
  output?: ManagedShellOutputSummary;
  noticeId?: string;
  reason?: string;
};

export type ManagedShellCompletionMessage = {
  id: string;
  shellId: string;
  name: string;
  owner: ManagedShellOwner;
  text: string;
  at: number;
};

export type ManagedShellOwnerSelector = Pick<ManagedShellOwner, "sessionId" | "agentId">;

/** Lifecycle boundary used by App and SubagentManager integration. */
export interface ManagedShellOwnerLifecycle {
  invalidateOwner(owner: ManagedShellOwnerSelector, reason?: string): Promise<void>;
  invalidateSession(sessionId: string, reason?: string): Promise<void>;
  shutdown(): Promise<void>;
}

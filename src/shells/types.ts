export const DEFAULT_SHELL_RUNNING_LIMIT = 5;
export const DEFAULT_SHELL_RETAINED_LIMIT = 20;
export const DEFAULT_SHELL_OUTPUT_LIMIT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_SHELL_TERMINATION_GRACE_MS = 2_000;

export const MANAGED_SHELL_CUSTOM_TYPE = "pum.managed_shell";
export const MANAGED_SHELL_COMPLETION_TYPE = "pum.managed_shell_completion";

export type ShellId = string;
export type ShellState = "starting" | "running" | "exited" | "failed" | "terminated";

export type ShellOwner = {
  sessionId: string;
  agentId: string | null;
  label: string;
};

export type ShellOutputMetadata = {
  path: string;
  bytes: number;
  truncated: boolean;
  exists: boolean;
};

export type ShellSnapshot = {
  id: ShellId;
  name: string;
  owner: ShellOwner;
  executable: string;
  args: string[];
  cwd: string;
  state: ShellState;
  createdAt: number;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  ready: boolean;
  readyAt: number | null;
  output: ShellOutputMetadata;
};

export type CreateShellInput = {
  id?: ShellId;
  name?: string;
  owner: ShellOwner;
  executable: string;
  args?: readonly string[];
  cwd: string;
  /** Authoritative owning project or worktree boundary. */
  projectCwd?: string;
  env?: Readonly<Record<string, string>>;
  waitFor?: string;
  waitTimeoutMs?: number;
};

export type ShellProcessExit = { exitCode: number | null; signal: string | null };

export type ShellProcessSpawnRequest = {
  executable: string;
  args: readonly string[];
  cwd: string;
  projectCwd: string;
  env: Readonly<Record<string, string>>;
  onStdout(chunk: Uint8Array): void;
  onStderr(chunk: Uint8Array): void;
};

export interface ShellProcessHandle {
  readonly completed: Promise<ShellProcessExit>;
  kill(signal?: string): void;
}

export interface ShellProcessAdapter {
  spawn(request: ShellProcessSpawnRequest): ShellProcessHandle | Promise<ShellProcessHandle>;
}

export type ShellSafetyRequest = {
  proposal: {
    kind: "process";
    source: "managed-shell";
    executable: string;
    args: readonly string[];
    cwd: string;
    operation: "start";
    shellName?: string;
  };
  requester:
    | { kind: "main"; sessionId: string; cwd: string }
    | { kind: "subagent"; sessionId: string; agentId: string; cwd: string };
};

export interface ShellSafetyChecker {
  check(request: ShellSafetyRequest): Promise<void> | void;
}

export interface ShellOutputWriter {
  readonly path: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  remove(): Promise<void>;
}

export interface ShellFileOperations {
  createPrivateOutput(shellId: string): Promise<ShellOutputWriter>;
  readOutput(path: string): Promise<Uint8Array>;
}

export interface ShellClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type GetShellOutputOptions = {
  lineLimit: number;
  waitPattern?: string;
  timeoutMs?: number;
};

export type ShellOutputResult = {
  shell: ShellSnapshot;
  tail: string;
  matchingLines?: string[];
  matched?: boolean;
  timedOut?: boolean;
};

export type ShellManagerEvent =
  | { type: "changed"; snapshot: ShellSnapshot }
  | { type: "removed"; id: ShellId };

export type ShellManagerOptions = {
  process: ShellProcessAdapter;
  files: ShellFileOperations;
  clock: ShellClock;
  safety?: ShellSafetyChecker;
  environment?: Readonly<Record<string, string | undefined>>;
  runningLimit?: number;
  retainedLimit?: number;
  outputLimitBytes?: number;
  terminationGraceMs?: number;
  createId?: () => string;
  onCompleted?: (snapshot: ShellSnapshot) => Promise<void> | void;
};

export interface PublicShellManager {
  subscribe(listener: (event: ShellManagerEvent) => void): () => void;
  list(owner?: ShellOwner): ShellSnapshot[];
  inspect(id: ShellId, owner?: ShellOwner): ShellSnapshot;
  getOutput(id: ShellId, options: GetShellOutputOptions, owner?: ShellOwner): Promise<ShellOutputResult>;
  create(input: CreateShellInput): Promise<ShellSnapshot>;
  terminate(id: ShellId, owner?: ShellOwner): Promise<ShellSnapshot>;
  remove(id: ShellId, owner?: ShellOwner): Promise<void>;
  invalidateSession(sessionId: string): Promise<void>;
  invalidateAgent(sessionId: string, agentId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export type ManagedShellLifecycleState = "started" | "exited" | "failed" | "terminated" | "unavailable";

/** Durable session data for customType `pum.managed_shell`. */
export type ManagedShellLifecycleEvent = {
  version: 1;
  shellId: ShellId;
  name: string;
  owner: ShellOwner;
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
  output?: ShellOutputMetadata & { tail?: string };
  noticeId?: string;
  reason?: string;
};

export type ManagedShellCompletionMessage = {
  id: string;
  shellId: ShellId;
  name: string;
  owner: ShellOwner;
  text: string;
  at: number;
};

export type ShellLifecycleManager = Pick<
  PublicShellManager,
  "invalidateSession" | "invalidateAgent" | "shutdown"
>;

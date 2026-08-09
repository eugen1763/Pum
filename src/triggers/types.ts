export const EXTERNAL_TRIGGER_CUSTOM_TYPE = "pum.external_trigger" as const;
export const MIN_TRIGGER_REPEAT_MS = 60_000;
export const DEFAULT_TRIGGER_LIMIT = 100;
export const DEFAULT_RUNNING_LIMIT = 3;
export const DEFAULT_PENDING_LIMIT = 5;
export const DEFAULT_DELIVERED_LIMIT = 10;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

export type TriggerId = string;
export type TriggerState =
  | "idle"
  | "running"
  | "paused"
  | "waiting"
  | "expired"
  | "cancelled"
  | "unavailable";

export type TriggerRequester =
  | { kind: "main"; sessionId: string; cwd: string }
  | { kind: "subagent"; sessionId: string; agentId: string; cwd: string };

export type TriggerTarget = {
  sessionId: string;
  agentId: string | null;
  label: string;
};

export type TriggerInvocationMode = "run" | "fire";

export type TriggerOutputMetadata = {
  path: string;
  bytes: number;
  truncated: boolean;
  exists: boolean;
};

export type TriggerLastResult = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  synthetic: boolean;
  manual: boolean;
  output?: TriggerOutputMetadata;
};

export type TriggerSnapshot = {
  id: TriggerId;
  name: string;
  state: TriggerState;
  target: TriggerTarget;
  executable: string;
  args: string[];
  cwd?: string;
  mode: "once" | "repeat";
  restartDelayMs: number | null;
  createdAt: number;
  expiresAt?: number;
  nextRestartAt: number | null;
  fireCount: number;
  maxFires: number;
  pendingCount: number;
  coalescedCount: number;
  output?: TriggerOutputMetadata;
  lastResult?: TriggerLastResult;
  paused: boolean;
};

export type CreateTriggerInput = {
  id?: TriggerId;
  name: string;
  target: TriggerTarget;
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  mode?: "once" | "repeat";
  restartDelayMs?: number | null;
  expiresAt?: number;
  maxFires?: number;
  messageTemplate?: string;
};

export type TriggerAuthContext = TriggerRequester;

export type ExternalTriggerEventState =
  | "created"
  | "paused"
  | "resumed"
  | "started"
  | "waiting"
  | "delivered"
  | "settled"
  | "cancelled"
  | "expired"
  | "failed"
  | "coalesced"
  | "target-invalidated";

/** Session entry data for customType `pum.external_trigger`. */
export type ExternalTriggerEventData = {
  version: 1;
  triggerId: TriggerId;
  name: string;
  state: ExternalTriggerEventState;
  target: TriggerTarget;
  at: number;
  fireCount: number;
  pendingCount: number;
  coalescedCount: number;
  result?: TriggerLastResult;
  deliveryId?: string;
  turnId?: string;
  reason?: string;
};

export type ExternalTriggerCustomEvent = {
  type: "custom";
  customType: typeof EXTERNAL_TRIGGER_CUSTOM_TYPE;
  data: ExternalTriggerEventData;
};

export type TriggerSafetyOperation = "create" | "start" | "resume" | "repeat" | "invoke-run";
export type TriggerProcessProposal = {
  kind: "process";
  source: "external-trigger";
  executable: string;
  args: readonly string[];
  cwd?: string;
  operation: TriggerSafetyOperation;
  triggerName?: string;
};
export type TriggerSafetyRequest = {
  proposal: TriggerProcessProposal;
  triggerId: TriggerId;
  env: Readonly<Record<string, string>>;
  target: TriggerTarget;
  requester: TriggerRequester;
};

export type TriggerSafetyResult = { safe: boolean; reason?: string };
export interface TriggerSafetyChecker {
  check(request: TriggerSafetyRequest): Promise<TriggerSafetyResult> | TriggerSafetyResult;
}

export type ResolvedTriggerTarget = { target: TriggerTarget; value: unknown };
export interface TriggerTargetResolver {
  resolve(target: TriggerTarget): Promise<ResolvedTriggerTarget | undefined> | ResolvedTriggerTarget | undefined;
}

export type TriggerDeliveryRequest = {
  event: ExternalTriggerEventData;
  target: ResolvedTriggerTarget;
  message: string;
  outputPath?: string;
};
export type TriggerDeliveryResult = { deliveryId: string; turnId?: string };
export interface TriggerDeliveryAdapter {
  deliver(request: TriggerDeliveryRequest): Promise<TriggerDeliveryResult>;
}

export type ProcessSpawnRequest = {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
  onStdout(chunk: Uint8Array): void;
  onStderr(chunk: Uint8Array): void;
};
export type ProcessExit = { exitCode: number | null; signal: string | null };
export interface TriggerProcessHandle {
  readonly completed: Promise<ProcessExit>;
  kill(signal?: string): void;
}
export interface TriggerProcessAdapter { spawn(request: ProcessSpawnRequest): TriggerProcessHandle }

export interface TriggerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TriggerOutputWriter {
  readonly path: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  remove(): Promise<void>;
}
export interface TriggerFileOperations { createPrivateOutput(triggerId: string): Promise<TriggerOutputWriter> }

export type TriggerManagerEvent =
  | { type: "changed"; snapshot: TriggerSnapshot }
  | { type: "removed"; id: TriggerId }
  | { type: "external"; event: ExternalTriggerCustomEvent };

export interface PublicTriggerManager {
  subscribe(listener: (event: TriggerManagerEvent) => void): () => void;
  getTriggers(requester?: TriggerRequester): TriggerSnapshot[];
  inspect(id: string, requester?: TriggerRequester): TriggerSnapshot;
  create(input: CreateTriggerInput, requester: TriggerRequester): Promise<TriggerSnapshot>;
  pause(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot>;
  resume(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot>;
  cancel(id: string, requester?: TriggerRequester): Promise<void>;
  invoke(id: string, mode: TriggerInvocationMode, requester?: TriggerRequester): Promise<TriggerSnapshot | void>;
  invalidateSession(sessionId: string): Promise<void> | void;
  invalidateAgent(sessionId: string, agentId: string): Promise<void> | void;
  markTargetSettled(sessionId: string, agentId: string | null): Promise<void> | void;
  shutdown(): Promise<void>;
}

export type TriggerManagerOptions = {
  process: TriggerProcessAdapter;
  clock: TriggerClock;
  safety: TriggerSafetyChecker;
  targets: TriggerTargetResolver;
  delivery: TriggerDeliveryAdapter;
  files: TriggerFileOperations;
  environment?: Readonly<Record<string, string | undefined>>;
  triggerLimit?: number;
  runningLimit?: number;
  pendingLimit?: number;
  deliveredLimit?: number;
  outputLimitBytes?: number;
  createId?: () => string;
  onPersistEvent?: (event: ExternalTriggerCustomEvent) => void;
};

import type { CheckPathAccessMode } from "../check-policy";

export type SandboxMode = "auto" | "require" | "off";
export type SandboxCapabilityState = "enforced" | "unavailable" | "error";
export type SandboxBackendId = "bubblewrap" | "mxc";
export type SandboxNetwork = "deny" | "host";

export type SandboxCapability = {
  state: SandboxCapabilityState;
  backend: SandboxBackendId;
  reason?: string;
};

export type SandboxPolicyAccess = {
  resolvedPath: string;
  mode: CheckPathAccessMode;
  source: "operand" | "redirection" | "executable";
  stage: number;
  external: boolean;
};

/** Canonical policy derived from the approved command and authoritative PUM state. */
export type SandboxPolicy = {
  version: 1;
  exactCommand: string;
  cwd: string;
  readOnlyPaths: string[];
  readWritePaths: string[];
  deniedPaths: string[];
  privateTemp: string;
  environment: Record<string, string>;
  executable: string;
  args: string[];
  network: SandboxNetwork;
  rationale: string;
  accesses: SandboxPolicyAccess[];
  networkCommands?: string[];
};

export type SandboxProcessExit = {
  exitCode: number | null;
  signal: string | null;
};

export type SandboxProcessOptions = {
  onStdout(chunk: Uint8Array): void;
  onStderr(chunk: Uint8Array): void;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  stdin?: Uint8Array;
};

export type SandboxProcessHandle = {
  completed: Promise<SandboxProcessExit>;
  kill(): void;
};

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  probe(): Promise<SandboxCapability>;
  spawn(policy: SandboxPolicy, options: SandboxProcessOptions): SandboxProcessHandle;
}

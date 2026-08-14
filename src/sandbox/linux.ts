import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { posix } from "node:path";
import type {
  SandboxBackend,
  SandboxCapability,
  SandboxPolicy,
  SandboxProcessHandle,
  SandboxProcessOptions,
} from "./types";

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

type BubblewrapMount = {
  source: string;
  target: string;
  mode: "read-only" | "read-write";
};

export interface BubblewrapSpawnRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: Uint8Array;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
}

export interface BubblewrapProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface BubblewrapProcessHandle {
  pid?: number;
  completed: Promise<BubblewrapProcessResult>;
  kill: (signal: NodeJS.Signals) => void;
}

export interface BubblewrapProcessAdapter {
  spawn: (request: BubblewrapSpawnRequest) => BubblewrapProcessHandle;
}

export interface BubblewrapProbeOptions {
  platform?: NodeJS.Platform;
  executable?: string;
  timeoutMs?: number;
  processAdapter?: BubblewrapProcessAdapter;
}

export interface BubblewrapBackendOptions {
  executable?: string;
  platform?: NodeJS.Platform;
  killGraceMs?: number;
  processAdapter?: BubblewrapProcessAdapter;
  probeTimeoutMs?: number;
  systemMounts?: readonly string[];
  pathKind?: (path: string) => "file" | "directory" | undefined;
}

export class NodeBubblewrapProcessAdapter implements BubblewrapProcessAdapter {
  spawn(request: BubblewrapSpawnRequest): BubblewrapProcessHandle {
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: [request.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (request.stdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(request.stdin);
    }
    child.stdout?.on("data", request.onStdout);
    child.stderr?.on("data", request.onStderr);

    const completed = new Promise<BubblewrapProcessResult>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });

    return {
      pid: child.pid,
      completed,
      kill(signal) {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      },
    };
  }
}

function assertNoNul(label: string, value: string): void {
  if (value.includes("\0")) throw new Error(`${label} contains NUL`);
}

function normalizeAbsolutePath(label: string, value: string): string {
  assertNoNul(label, value);
  if (!posix.isAbsolute(value)) throw new Error(`${label} must be an absolute path: ${value}`);
  return posix.normalize(value);
}

function isWithin(root: string, value: string): boolean {
  const child = posix.relative(root, value);
  return child === "" || (!child.startsWith("../") && child !== ".." && !posix.isAbsolute(child));
}

function defaultSystemMounts(): string[] {
  return ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/nix"].filter(existsSync);
}

function sandboxEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_KEY.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (value !== undefined) {
      assertNoNul(`Environment variable ${key}`, value);
      result[key] = value;
    }
  }
  return result;
}

function addMount(
  mounts: BubblewrapMount[],
  targetIndexes: Map<string, number>,
  mount: Omit<BubblewrapMount, "target"> & { target?: string },
): void {
  const source = normalizeAbsolutePath("Mount source", mount.source);
  const target = normalizeAbsolutePath("Mount target", mount.target ?? mount.source);
  const normalized = { source, target, mode: mount.mode };
  const prior = targetIndexes.get(target);
  if (prior === undefined) {
    targetIndexes.set(target, mounts.length);
    mounts.push(normalized);
  } else {
    mounts[prior] = normalized;
  }
}

function policyMounts(policy: SandboxPolicy, systemMounts?: readonly string[]): BubblewrapMount[] {
  const mounts: BubblewrapMount[] = [];
  const targetIndexes = new Map<string, number>();
  for (const path of systemMounts ?? defaultSystemMounts()) {
    addMount(mounts, targetIndexes, { source: path, mode: "read-only" });
  }
  for (const path of policy.readOnlyPaths) {
    addMount(mounts, targetIndexes, { source: path, mode: "read-only" });
  }
  // The shell executable must be reachable, or every sandboxed command fails
  // with an exec error while PUM reports enforcement. A shell outside the
  // system mounts (for example /run/current-system/sw/bin/bash on NixOS or
  // /home/linuxbrew/.linuxbrew/bin/bash) needs its directory bound read-only.
  // Add it before the writable roots: mount order is security policy, so
  // system and read-only mounts stay first.
  const executable = normalizeAbsolutePath("Command executable", policy.executable);
  const coveredByWritable = policy.readWritePaths.some(
    (path) => isWithin(normalizeAbsolutePath("Writable root", path), executable),
  );
  if (!coveredByWritable && !mounts.some((mount) => isWithin(mount.source, executable))) {
    addMount(mounts, targetIndexes, { source: posix.dirname(executable), mode: "read-only" });
  }
  for (const path of policy.readWritePaths) {
    addMount(mounts, targetIndexes, { source: path, mode: "read-write" });
  }
  return mounts;
}

function defaultPathKind(path: string): "file" | "directory" | undefined {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "directory" : "file";
  } catch {
    return undefined;
  }
}

function deniedPathArgs(
  paths: readonly string[],
  pathKind: (path: string) => "file" | "directory" | undefined,
  writableRoots: readonly string[],
): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  const remounted = new Set<string>();
  const normalizedWritableRoots = writableRoots.map((path) => normalizeAbsolutePath("Writable root", path));
  for (const rawPath of paths) {
    const path = normalizeAbsolutePath("Denied path", rawPath);
    if (seen.has(path)) continue;
    seen.add(path);
    const kind = pathKind(path);
    if (kind === "directory") args.push("--tmpfs", path);
    else if (kind === "file") args.push("--ro-bind", "/dev/null", path);
    else {
      const writableRoot = normalizedWritableRoots
        .filter((root) => isWithin(root, path))
        .sort((left, right) => right.length - left.length)[0];
      if (!writableRoot) continue;

      // A bind mask needs a destination and can create that destination in the
      // host-backed writable mount. Remount the nearest existing ancestor
      // read-only instead. The missing denied path then stays absent and cannot
      // be created, without adding a host placeholder.
      let ancestor = posix.dirname(path);
      while (ancestor !== writableRoot && pathKind(ancestor) !== "directory") {
        const parent = posix.dirname(ancestor);
        if (parent === ancestor || !isWithin(writableRoot, parent)) {
          ancestor = writableRoot;
          break;
        }
        ancestor = parent;
      }
      if (!remounted.has(ancestor)) {
        remounted.add(ancestor);
        args.push("--remount-ro", ancestor);
      }
    }
  }
  return args;
}

/** Build the complete Bubblewrap argv from an authoritative sandbox policy. */
export function buildBubblewrapArgv(
  policy: SandboxPolicy,
  options: Pick<BubblewrapBackendOptions, "systemMounts" | "pathKind"> = {},
): string[] {
  if (policy.version !== 1) throw new Error(`Unsupported sandbox policy version: ${policy.version}`);
  assertNoNul("Exact command", policy.exactCommand);
  const cwd = normalizeAbsolutePath("Working directory", policy.cwd);
  const executable = normalizeAbsolutePath("Command executable", policy.executable);
  for (const argument of policy.args) assertNoNul("Command argument", argument);
  const privateTemp = normalizeAbsolutePath("Private temp", policy.privateTemp);
  const mounts = policyMounts(policy, options.systemMounts);
  if (!mounts.some((mount) => isWithin(mount.source, cwd))) {
    throw new Error(`Working directory is not visible in the sandbox: ${cwd}`);
  }

  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop", "ALL",
    "--proc", "/proc",
    "--dev", "/dev",
  ];
  if (policy.network === "deny") args.push("--unshare-net");
  for (const mount of mounts) {
    args.push(mount.mode === "read-only" ? "--ro-bind" : "--bind", mount.source, mount.target);
  }
  // Keep private and denied mounts last so earlier allow mounts cannot expose them.
  args.push("--tmpfs", privateTemp);
  args.push(...deniedPathArgs(
    policy.deniedPaths,
    options.pathKind ?? defaultPathKind,
    [...policy.readWritePaths, privateTemp],
  ));
  args.push("--chdir", cwd, "--", executable, ...policy.args);
  return args;
}

function timeoutMilliseconds(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const milliseconds = timeoutSeconds * 1000;
  if (milliseconds > MAX_TIMEOUT_MS) throw new Error("Invalid timeout: value is too large");
  return milliseconds;
}

export async function probeBubblewrap(options: BubblewrapProbeOptions = {}): Promise<SandboxCapability> {
  const executable = options.executable ?? "bwrap";
  if ((options.platform ?? process.platform) !== "linux") {
    return { state: "unavailable", backend: "bubblewrap", reason: "Bubblewrap requires Linux" };
  }

  const adapter = options.processAdapter ?? new NodeBubblewrapProcessAdapter();
  const probeExecutable = existsSync("/bin/true") ? "/bin/true" : "/usr/bin/true";
  const probeMountArgs = defaultSystemMounts().flatMap((path) => ["--ro-bind", path, path]);
  const output: Buffer[] = [];
  const child = adapter.spawn({
    executable,
    cwd: "/",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-net",
      "--cap-drop", "ALL",
      "--proc", "/proc",
      "--dev", "/dev",
      ...probeMountArgs,
      "--", probeExecutable,
    ],
    onStdout: (chunk) => output.push(chunk),
    onStderr: (chunk) => output.push(chunk),
  });
  try {
    const handle = managedSandboxHandle(child, {
      onStdout: () => {},
      onStderr: () => {},
      timeoutSeconds: (options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS) / 1000,
    }, DEFAULT_KILL_GRACE_MS);
    const result = await handle.completed;
    if (result.exitCode === 0) return { state: "enforced", backend: "bubblewrap" };
    const detail = Buffer.concat(output).toString("utf8").trim();
    return {
      state: "unavailable",
      backend: "bubblewrap",
      reason: detail || `Bubblewrap probe exited with code ${result.exitCode}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: reason.includes("ENOENT") ? "unavailable" : "error",
      backend: "bubblewrap",
      reason,
    };
  }
}

function managedSandboxHandle(
  child: BubblewrapProcessHandle,
  options: SandboxProcessOptions,
  killGraceMs: number,
): SandboxProcessHandle {
  let stoppedBy: "abort" | "timeout" | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let killHandle: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: "abort" | "timeout") => {
    if (stoppedBy) return;
    stoppedBy = reason;
    child.kill("SIGTERM");
    killHandle = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
  };
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = timeoutMilliseconds(options.timeoutSeconds);
  if (timeoutMs !== undefined) timeoutHandle = setTimeout(() => stop("timeout"), timeoutMs);

  const completed = child.completed.then((result) => {
    if (stoppedBy === "abort" || options.signal?.aborted) throw new Error("aborted");
    if (stoppedBy === "timeout") throw new Error(`timeout:${options.timeoutSeconds}`);
    return { exitCode: result.exitCode, signal: result.signal };
  }).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (killHandle) clearTimeout(killHandle);
    options.signal?.removeEventListener("abort", onAbort);
  });

  return { completed, kill: () => stop("abort") };
}

/** Create the reusable Linux Bubblewrap backend for the native sandbox layer. */
export function createBubblewrapBackend(options: BubblewrapBackendOptions = {}): SandboxBackend {
  const executable = options.executable ?? "bwrap";
  const adapter = options.processAdapter ?? new NodeBubblewrapProcessAdapter();
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
    throw new Error("Kill grace must be a non-negative number");
  }

  return {
    id: "bubblewrap",
    probe: () => probeBubblewrap({
      executable,
      platform: options.platform,
      timeoutMs: options.probeTimeoutMs,
      processAdapter: adapter,
    }),
    spawn(policy, processOptions) {
      if (processOptions.signal?.aborted) throw new Error("aborted");
      const args = buildBubblewrapArgv(policy, {
        systemMounts: options.systemMounts,
        pathKind: options.pathKind,
      });
      const child = adapter.spawn({
        executable,
        args,
        cwd: policy.cwd,
        env: sandboxEnvironment(policy.environment),
        stdin: processOptions.stdin,
        onStdout: (chunk) => processOptions.onStdout(chunk),
        onStderr: (chunk) => processOptions.onStderr(chunk),
      });
      return managedSandboxHandle(child, processOptions, killGraceMs);
    },
  };
}

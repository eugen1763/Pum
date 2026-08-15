import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

export const CLAUDEBOX_EXECUTABLE_ENV = "PUM_CLAUDEBOX";

export type OuterSandboxInvocation = {
  executable: string;
  args: string[];
};

export type OuterSandboxProbe = {
  available: boolean;
  executable: string;
  reason?: string;
};

type SpawnLike = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export function claudeboxExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment[CLAUDEBOX_EXECUTABLE_ENV]?.trim();
  if (configured?.includes("\0")) throw new Error(`${CLAUDEBOX_EXECUTABLE_ENV} contains a NUL byte`);
  return configured || "claudebox";
}

export function probeOuterSandboxRuntime(options: {
  environment?: Readonly<Record<string, string | undefined>>;
  probe?: typeof spawnSync;
} = {}): OuterSandboxProbe {
  const executable = claudeboxExecutable(options.environment);
  const probe = options.probe ?? spawnSync;
  const runProbe = (args: string[]) => probe(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  const failureReason = (result: ReturnType<typeof spawnSync>): string => {
    if (result.error) return result.error.message;
    const stderr = result.stderr?.toString().trim();
    if (stderr) return stderr;
    return result.signal
      ? `probe terminated by ${result.signal}`
      : `probe exited with status ${result.status ?? "unknown"}`;
  };

  const protocol = runProbe(["--pum-protocol-version"]);
  if (protocol.error || protocol.status !== 0) {
    return { available: false, executable, reason: failureReason(protocol) };
  }
  const version = protocol.stdout?.toString().trim();
  if (version !== "1") {
    return {
      available: false,
      executable,
      reason: `unsupported PUM launcher protocol: ${version || "missing"}`,
    };
  }

  const runtime = runProbe(["--pum-runtime-check"]);
  if (runtime.error || runtime.status !== 0) {
    return { available: false, executable, reason: failureReason(runtime) };
  }
  const runtimeStatus = runtime.stdout?.toString().trim();
  if (runtimeStatus !== "ok") {
    return {
      available: false,
      executable,
      reason: `unexpected runtime check response: ${runtimeStatus || "missing"}`,
    };
  }
  return { available: true, executable };
}

export function runOuterSandbox(
  invocation: OuterSandboxInvocation,
  spawnProcess: SpawnLike = spawn,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.executable, invocation.args, {
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(new Error(`claudebox terminated by ${signal ?? "an unknown signal"}`));
    });
  });
}

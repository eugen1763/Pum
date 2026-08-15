import type { ChildProcess } from "node:child_process";
import { join, win32 } from "node:path";
import type {
  ContainerConfig,
  PlatformSupport,
  SandboxPolicy as MxcPolicy,
} from "@microsoft/mxc-sdk";
import type {
  SandboxBackend,
  SandboxCapability,
  SandboxPolicy,
  SandboxProcessHandle,
  SandboxProcessOptions,
} from "./types.js";

type MxcSdk = typeof import("@microsoft/mxc-sdk");
type MxcSdkLoader = () => Promise<MxcSdk>;

const REQUIRED_UI_CAPABILITIES = [
  "canBlockClipboardRead",
  "canBlockClipboardWrite",
  "canBlockInputInjection",
  "canBlockInputMethodChanges",
  "canBlockExternalUiObjects",
  "canBlockGlobalUiNamespace",
  "canBlockDesktopSwitching",
  "canBlockLogoffOrShutdown",
  "canBlockSystemParameterChanges",
  "canBlockDisplaySettingsChanges",
] as const;

const loadMxcSdk: MxcSdkLoader = async () => {
  // MXC 0.7 resolves `whoami /user` through a shell during module import.
  // Bun caches the default child-process environment, so changing PATH here
  // does not affect MXC after node:child_process has already been imported.
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const system32 = join(systemRoot ?? "C:\\Windows", "System32");
  const previousCwd = process.cwd();
  const specifier = import.meta.resolve("@microsoft/mxc-sdk");
  try {
    // Bun can synchronously require this ESM package. Keep the cwd change
    // synchronous so no unrelated work can observe the temporary directory.
    process.chdir(system32);
    return require(specifier) as MxcSdk;
  } finally {
    process.chdir(previousCwd);
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(reason: string): SandboxCapability {
  return { state: "unavailable", backend: "mxc", reason };
}

function failed(reason: string): SandboxCapability {
  return { state: "error", backend: "mxc", reason };
}

function validateNativeSupport(support: PlatformSupport): SandboxCapability {
  if (!support.isSupported || !support.availableMethods.includes("processcontainer")) {
    return unavailable(support.reason || "MXC ProcessContainer is not available");
  }
  if (!support.isolationTier) {
    return unavailable("The MXC native ProcessContainer probe did not return an isolation tier");
  }
  if (support.isolationTier !== "base-container") {
    return unavailable(
      `MXC BaseContainer/CreateProcessInSandbox is unavailable (reported tier: ${support.isolationTier}). ` +
      "PUM does not use the AppContainer DACL fallback because it can change host ACLs.",
    );
  }
  const ui = support.uiCapabilities;
  if (!ui) {
    return unavailable("The MXC native probe did not return UI restriction capabilities");
  }
  const missing = REQUIRED_UI_CAPABILITIES.filter((capability) => !ui[capability]);
  if (missing.length > 0) {
    return unavailable(`MXC cannot enforce required UI restrictions: ${missing.join(", ")}`);
  }
  return { state: "enforced", backend: "mxc" };
}

/**
 * Quote one argv element for the Windows CreateProcess command-line grammar.
 * This is the inverse convention used by CommandLineToArgvW and the Microsoft C runtime.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) return argument;

  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

/** MXC currently accepts only one command-line string, not executable and argv separately. */
export function quoteWindowsCommandLine(executable: string, args: readonly string[]): string {
  if (!executable) throw new Error("Sandbox executable is required");
  return [quoteWindowsArgument(executable), ...args.map(quoteWindowsArgument)].join(" ");
}

function uniqueWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const identity = path.replace(/[\\/]+$/u, "").toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(path);
  }
  return result;
}

/** A drive root (C:\) or a UNC share root is its own parent directory. */
function isBroadWindowsRoot(path: string): boolean {
  return win32.dirname(path) === path;
}

function windowsRuntimePaths(executable: string): string[] {
  const executableDirectory = win32.dirname(executable);
  // A tool inside a bin directory usually references sibling lib/share trees,
  // so grant its parent. Never grant a drive or UNC root: C:\bin\bash.exe
  // would otherwise expose the whole volume. Fall back to the bin directory.
  const candidate = win32.basename(executableDirectory).toLowerCase() === "bin"
    && !isBroadWindowsRoot(win32.dirname(executableDirectory))
    ? win32.dirname(executableDirectory)
    : executableDirectory;
  return isBroadWindowsRoot(candidate) ? [] : [candidate];
}

function sandboxEnvironment(policy: SandboxPolicy): string[] {
  const entries = Object.entries(policy.environment).filter(
    ([name]) => name.toUpperCase() !== "TEMP" && name.toUpperCase() !== "TMP",
  );
  entries.push(["TEMP", policy.privateTemp], ["TMP", policy.privateTemp]);
  return entries.map(([name, value]) => `${name}=${value}`);
}

/** Build the exact stable MXC 0.7 ProcessContainer configuration used for a run. */
export function buildWindowsMxcConfig(
  sdk: Pick<MxcSdk, "createConfigFromPolicy">,
  policy: SandboxPolicy,
  timeoutSeconds?: number,
): ContainerConfig {
  const timeoutMs = timeoutSeconds === undefined ? 0 : Math.ceil(timeoutSeconds * 1000);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  if (timeoutMs > 2_147_483_647) {
    throw new Error("Invalid timeout: maximum is 2147483.647 seconds");
  }

  const mxcPolicy: MxcPolicy = {
    version: "0.7.0-alpha",
    filesystem: {
      readonlyPaths: uniqueWindowsPaths([...policy.readOnlyPaths, ...windowsRuntimePaths(policy.executable)]),
      readwritePaths: uniqueWindowsPaths([...policy.readWritePaths, policy.privateTemp]),
      deniedPaths: uniqueWindowsPaths(policy.deniedPaths),
      clearPolicyOnExit: true,
    },
    network: {
      allowOutbound: policy.network === "host",
      allowLocalNetwork: policy.network === "host",
    },
    ui: {
      allowWindows: false,
      clipboard: "none",
      allowInputInjection: false,
    },
    timeoutMs,
  };

  // SDK 0.7 declares concrete backends, but its implementation builds Windows
  // ProcessContainer only through the abstract "process" intent.
  const config = sdk.createConfigFromPolicy(mxcPolicy, "process");
  config.process = {
    commandLine: quoteWindowsCommandLine(policy.executable, policy.args),
    cwd: policy.cwd,
    env: sandboxEnvironment(policy),
    timeout: timeoutMs,
  };
  config.lifecycle = { destroyOnExit: true, preservePolicy: false };
  config.processContainer = {
    ...(config.processContainer ?? {}),
    leastPrivilege: true,
    capabilities:
      policy.network === "host" ? ["internetClient", "privateNetworkClientServer"] : [],
    ui: {
      isolation: "container",
      desktopSystemControl: false,
      systemSettings: "none",
      ime: false,
    },
  };
  if (config.network) config.network.enforcementMode = "capabilities";
  return config;
}

export async function probeWindowsSandbox(
  loader: MxcSdkLoader = loadMxcSdk,
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxCapability> {
  if (platform !== "win32") return unavailable("MXC ProcessContainer requires Windows");
  let sdk: MxcSdk;
  try {
    sdk = await loader();
  } catch (error) {
    return unavailable(`Optional dependency @microsoft/mxc-sdk is unavailable: ${errorMessage(error)}`);
  }
  try {
    return validateNativeSupport(sdk.getPlatformSupport());
  } catch (error) {
    return failed(`MXC native availability probe failed: ${errorMessage(error)}`);
  }
}

function startSandboxProcess(
  sdk: MxcSdk,
  policy: SandboxPolicy,
  options: SandboxProcessOptions,
  onChild: (child: ChildProcess) => void,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const config = buildWindowsMxcConfig(sdk, policy, options.timeoutSeconds);
      child = sdk.spawnSandboxFromConfig(config, { usePty: false }, policy.cwd) as ChildProcess;
      onChild(child);
    } catch (error) {
      reject(error);
      return;
    }

    let timedOut = false;
    let stderrTail = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const kill = () => child.kill();
    const onAbort = () => kill();
    if (options.timeoutSeconds !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        kill();
      // MXC enforces process.timeout inside the sandbox and tears down its
      // Windows Job Object. This watchdog is only for a stuck executor.
      }, options.timeoutSeconds * 1000 + 5_000);
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => options.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      options.onStderr(chunk);
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      // The watchdog timer is the real timeout signal. The stderr sniff only
      // recognizes MXC's internal enforcement, so gate it on an actually
      // configured timeout. Otherwise a plain non-zero exit whose stderr
      // happens to contain "process timed out after Nms" is misreported.
      const stderrTimeout = options.timeoutSeconds !== undefined
        && exitCode !== 0
        && /(?:script|process|command) timed out after \d+ms/iu.test(stderrTail);
      if (timedOut || stderrTimeout) {
        reject(new Error(`timeout:${options.timeoutSeconds}`));
        return;
      }
      resolve({ exitCode, signal });
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ? Buffer.from(options.stdin) : undefined);
  });
}

export class MxcSandboxBackend implements SandboxBackend {
  readonly id = "mxc" as const;
  readonly #loader: MxcSdkLoader;
  readonly #platform: NodeJS.Platform;

  constructor(options: { loader?: MxcSdkLoader; platform?: NodeJS.Platform } = {}) {
    this.#loader = options.loader ?? loadMxcSdk;
    this.#platform = options.platform ?? process.platform;
  }

  probe(): Promise<SandboxCapability> {
    return probeWindowsSandbox(this.#loader, this.#platform);
  }

  spawn(policy: SandboxPolicy, options: SandboxProcessOptions): SandboxProcessHandle {
    let child: ChildProcess | undefined;
    let killRequested = false;
    const completed = (async () => {
      if (this.#platform !== "win32") throw new Error("MXC ProcessContainer requires Windows");
      if (options.signal?.aborted) throw new Error("aborted");
      const sdk = await this.#loader();
      const capability = validateNativeSupport(sdk.getPlatformSupport());
      if (capability.state !== "enforced") throw new Error(capability.reason);
      return startSandboxProcess(sdk, policy, options, (spawned) => {
        child = spawned;
        if (killRequested) child.kill();
      });
    })();
    return {
      completed,
      kill: () => {
        killRequested = true;
        child?.kill();
      },
    };
  }
}

export function createWindowsSandboxBackend(
  options: { loader?: MxcSdkLoader; platform?: NodeJS.Platform } = {},
): SandboxBackend {
  return new MxcSandboxBackend(options);
}

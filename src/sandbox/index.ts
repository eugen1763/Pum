import {
  createBashTool,
  getShellConfig,
  SettingsManager,
  type BashOperations,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_DIR } from "../config";
import { analyzeCheckPolicy } from "../check-policy";
import { getCheckModeConfig } from "../check-mode";
import { buildSandboxPolicy, decideSandboxMode } from "../sandbox-policy";
import type { CheckModeProfile } from "../settings";
import type { SandboxBackend, SandboxCapability, SandboxMode } from "./types";
import { createBubblewrapBackend } from "./linux";
import { createWindowsSandboxBackend } from "./windows";

export type SandboxControllerOptions = {
  backend?: SandboxBackend;
  platform?: NodeJS.Platform;
  mode?: SandboxMode;
  agentDir?: string;
};

export type SandboxExtensionOptions = {
  readonly?: boolean;
};

function platformBackend(platform: NodeJS.Platform): SandboxBackend | undefined {
  if (platform === "linux") return createBubblewrapBackend({ platform });
  if (platform === "win32") return createWindowsSandboxBackend({ platform });
  return undefined;
}

function unsupportedCapability(platform: NodeJS.Platform): SandboxCapability {
  return {
    state: "unavailable",
    backend: platform === "win32" ? "mxc" : "bubblewrap",
    reason: `Native Bash sandboxing is not supported on ${platform}`,
  };
}

async function gitMetadataReadOnlyRoots(cwd: string): Promise<string[]> {
  const dotGit = join(cwd, ".git");
  try {
    const metadata = await lstat(dotGit);
    if (metadata.isDirectory()) return [await realpath(dotGit)];
    if (!metadata.isFile()) return [];
    const pointer = await readFile(dotGit, "utf8");
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/im);
    if (!match) return [];
    const gitDir = await realpath(resolve(cwd, match[1]!));
    try {
      const commonPointer = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      if (!commonPointer) return [gitDir];
      return [gitDir, await realpath(resolve(gitDir, commonPointer))];
    } catch {
      return [gitDir];
    }
  } catch {
    return [];
  }
}

function findExecutable(executable: string, platform: NodeJS.Platform): string {
  if (isAbsolute(executable)) return resolve(executable);
  const command = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [executable], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  const found = result.status === 0
    ? result.stdout.trim().split(/\r?\n/u).find(Boolean)
    : undefined;
  if (!found || !isAbsolute(found)) throw new Error(`Sandbox shell executable could not be resolved: ${executable}`);
  return resolve(found);
}

export class SandboxController {
  readonly #backend?: SandboxBackend;
  readonly #platform: NodeJS.Platform;
  readonly #agentDir: string;
  #mode: SandboxMode;
  #probe?: Promise<SandboxCapability>;
  readonly #settings = new Map<string, SettingsManager>();
  readonly #warningListeners = new Set<(warning: string) => void>();
  #warningEmitted = false;

  constructor(options: SandboxControllerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#backend = options.backend ?? platformBackend(this.#platform);
    this.#mode = options.mode ?? "auto";
    this.#agentDir = options.agentDir ?? AGENT_DIR;
  }

  setMode(mode: SandboxMode): void {
    this.#mode = mode;
  }

  get mode(): SandboxMode {
    return this.#mode;
  }

  subscribeWarnings(listener: (warning: string) => void): () => void {
    this.#warningListeners.add(listener);
    return () => this.#warningListeners.delete(listener);
  }

  #emitWarning(warning: string): void {
    if (this.#warningEmitted) return;
    this.#warningEmitted = true;
    for (const listener of this.#warningListeners) listener(warning);
  }

  probe(): Promise<SandboxCapability> {
    return this.#probe ??= this.#backend?.probe()
      ?? Promise.resolve(unsupportedCapability(this.#platform));
  }

  async startupWarning(checkMode: CheckModeProfile): Promise<string | undefined> {
    if (checkMode === "off") return undefined;
    if (this.#mode === "off") return undefined;
    const capability = await this.probe();
    const decision = decideSandboxMode(this.#mode, capability);
    if (decision.warning) {
      this.#warningEmitted = true;
      return decision.warning;
    }
    if (decision.action === "block") {
      this.#warningEmitted = true;
      return `${decision.reason}. Checked Bash commands will be blocked.`;
    }
    return undefined;
  }

  extension(options: SandboxExtensionOptions = {}): InlineExtension {
    const base = createBashTool(process.cwd());
    const controller = this;
    const readonly = options.readonly === true;
    return {
      name: readonly ? "pum-readonly-native-bash-sandbox" : "pum-native-bash-sandbox",
      factory: (pi) => {
        pi.registerTool({
          ...base,
          description: `${base.description} PUM applies native OS sandboxing when Check mode and Sandbox settings require it.`
            + (readonly ? " This readonly child receives no writable project or additional roots." : ""),
          execute: async (id, params, signal, onUpdate, ctx) => {
            const cwd = ctx.cwd;
            let settings = controller.#settings.get(cwd);
            if (!settings) {
              settings = SettingsManager.create(cwd, controller.#agentDir);
              controller.#settings.set(cwd, settings);
            }
            const shellPath = settings.getShellPath();
            const commandPrefix = settings.getShellCommandPrefix();
            const check = getCheckModeConfig();
            if (readonly && controller.#mode === "off") {
              throw new Error("Readonly Bash is blocked while the PUM Sandbox setting is Off");
            }
            if (!readonly && (check.profile === "off" || controller.#mode === "off")) {
              const local = createBashTool(cwd, { shellPath, commandPrefix });
              return (local.execute as any)(id, params, signal, onUpdate, ctx);
            }

            const capability = await controller.probe();
            const decision = decideSandboxMode(controller.#mode, capability);
            if (decision.action === "block") throw new Error(decision.reason);
            if (decision.action === "direct") {
              if (readonly) {
                throw new Error(
                  `Readonly Bash requires native sandbox enforcement: ${capability.reason ?? `sandbox backend ${capability.backend} is ${capability.state}`}`,
                );
              }
              if (decision.warning) controller.#emitWarning(decision.warning);
              const local = createBashTool(cwd, { shellPath, commandPrefix });
              return (local.execute as any)(id, params, signal, onUpdate, ctx);
            }
            if (!controller.#backend) throw new Error("Sandbox backend is unavailable");

            const shell = getShellConfig(shellPath);
            const executable = findExecutable(shell.shell, controller.#platform);
            const operations: BashOperations = {
              exec: async (command, executionCwd, options) => {
                const executionCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
                const result = analyzeCheckPolicy({
                  command: executionCommand,
                  cwd: executionCwd,
                  profile: (check.profile === "off" ? "balanced" : check.profile) as Exclude<typeof check.profile, "off">,
                  allowedPaths: check.additionalPaths,
                  protectedPaths: [controller.#agentDir],
                });
                if (result.decision === "block") {
                  throw new Error(`Sandbox policy hard block: ${result.reason}`);
                }

                const privateTemp = await mkdtemp(join(tmpdir(), "pum-sandbox-"));
                const commandFromStdin = shell.commandTransport === "stdin";
                const args = commandFromStdin ? [...shell.args] : [...shell.args, executionCommand];
                try {
                  const additionalReadOnlyRoots = readonly
                    ? await gitMetadataReadOnlyRoots(executionCwd)
                    : [];
                  const policy = buildSandboxPolicy({
                    command,
                    executionCommand,
                    cwd: executionCwd,
                    additionalRoots: check.additionalPaths,
                    result,
                    executable,
                    args,
                    stdin: commandFromStdin,
                    privateTemp,
                    environment: readonly
                      ? { ...options.env, GIT_OPTIONAL_LOCKS: "0" }
                      : options.env,
                    pumConfigRoot: controller.#agentDir,
                    platform: controller.#platform,
                    readonlyRoots: readonly,
                    additionalReadOnlyRoots,
                  });
                  const handle = controller.#backend!.spawn(policy, {
                    onStdout: options.onData,
                    onStderr: options.onData,
                    signal: options.signal,
                    timeoutSeconds: options.timeout,
                    stdin: commandFromStdin ? Buffer.from(executionCommand) : undefined,
                  });
                  const completed = await handle.completed;
                  return { exitCode: completed.exitCode };
                } finally {
                  await rm(privateTemp, { recursive: true, force: true }).catch(() => {});
                }
              },
            };
            const sandboxed = createBashTool(cwd, { operations });
            return (sandboxed.execute as any)(id, params, signal, onUpdate, ctx);
          },
        });
      },
    };
  }
}

export * from "./types";
export { createBubblewrapBackend, probeBubblewrap, buildBubblewrapArgv } from "./linux";
export { createWindowsSandboxBackend, probeWindowsSandbox, buildWindowsMxcConfig } from "./windows";

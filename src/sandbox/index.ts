import {
  createBashTool,
  getShellConfig,
  SettingsManager,
  type BashOperations,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_DIR } from "../config";
import { analyzeCheckPolicy } from "../check-policy";
import { getCheckModeConfig } from "../check-mode";
import { buildSandboxPolicy, decideSandboxMode } from "../sandbox-policy";
import type { SandboxBackend, SandboxCapability, SandboxMode } from "./types";
import { createBubblewrapBackend } from "./linux";
import { createWindowsSandboxBackend } from "./windows";

export type SandboxControllerOptions = {
  backend?: SandboxBackend;
  platform?: NodeJS.Platform;
  mode?: SandboxMode;
  agentDir?: string;
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

  async startupWarning(): Promise<string | undefined> {
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

  extension(): InlineExtension {
    const base = createBashTool(process.cwd());
    const controller = this;
    return {
      name: "pum-native-bash-sandbox",
      factory: (pi) => {
        pi.registerTool({
          ...base,
          description: `${base.description} PUM applies native OS sandboxing when Check mode and Sandbox settings require it.`,
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
            if (check.profile === "off" || controller.#mode === "off") {
              const local = createBashTool(cwd, { shellPath, commandPrefix });
              return (local.execute as any)(id, params, signal, onUpdate, ctx);
            }

            const capability = await controller.probe();
            const decision = decideSandboxMode(controller.#mode, capability);
            if (decision.action === "block") throw new Error(decision.reason);
            if (decision.action === "direct") {
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
                  profile: check.profile as Exclude<typeof check.profile, "off">,
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
                    environment: options.env,
                    pumConfigRoot: controller.#agentDir,
                    platform: controller.#platform,
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

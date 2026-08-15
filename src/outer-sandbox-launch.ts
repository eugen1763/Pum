import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR } from "./config";
import {
  buildOuterSandboxLaunchPlan,
  OUTER_SANDBOX_ENV,
  OUTER_SANDBOX_MARKER,
  type OuterSandboxLaunchPlan,
  type OuterSandboxMode,
  type OuterSandboxMount,
} from "./outer-sandbox";
import {
  claudeboxExecutable,
  probeOuterSandboxRuntime,
  runOuterSandbox,
} from "./outer-sandbox-process";
import { isPathInsideOrSame, pathIdentity } from "./platform";

export const OUTER_SANDBOX_MODE_ENV = "PUM_OUTER_SANDBOX_MODE";
export const OUTER_SANDBOX_ROOTS_ENV = "PUM_OUTER_SANDBOX_ROOTS";

export type OuterSandboxContext = {
  mode: OuterSandboxMode;
  roots: OuterSandboxMount[];
};

export type LaunchPumOuterSandboxOptions = {
  mode: OuterSandboxMode;
  cwd: string;
  mounts: readonly string[];
  childArgs: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  executable?: string;
  runtimeExecutable?: string;
  entrypoint?: string;
  agentDir?: string;
  packageRoot?: string;
};

function canonicalFile(input: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(input));
  } catch {
    throw new Error(`${label} does not exist: ${input}`);
  }
  if (!lstatSync(canonical).isFile()) throw new Error(`${label} is not a file: ${input}`);
  return canonical;
}

function packageRuntimeRoot(entrypoint: string): string {
  const segments = resolve(entrypoint).split(sep);
  const nodeModules = segments.lastIndexOf("node_modules");
  if (nodeModules >= 0) return segments.slice(0, nodeModules + 1).join(sep) || sep;
  return fileURLToPath(new URL("..", import.meta.url));
}

function forwardedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["COLORTERM", "LANG", "LC_ALL", "NO_COLOR"]) {
    const value = source[name];
    if (value !== undefined && !value.includes("\0")) result[name] = value;
  }
  return result;
}

function mountArgument(mount: OuterSandboxMount): string {
  return `${mount.path}:${mount.mode}`;
}

export function outerSandboxContext(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OuterSandboxContext | undefined {
  if (environment[OUTER_SANDBOX_ENV] !== OUTER_SANDBOX_MARKER) return undefined;
  const mode = environment[OUTER_SANDBOX_MODE_ENV];
  if (mode !== "write" && mode !== "read") {
    throw new Error("Outer sandbox launch mode is missing or invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(environment[OUTER_SANDBOX_ROOTS_ENV] ?? "[]");
  } catch {
    throw new Error("Outer sandbox roots are invalid");
  }
  if (!Array.isArray(parsed)) throw new Error("Outer sandbox roots are invalid");
  const roots = parsed.map((value): OuterSandboxMount => {
    if (!value || typeof value !== "object") throw new Error("Outer sandbox root is invalid");
    const path = (value as { path?: unknown }).path;
    const mountMode = (value as { mode?: unknown }).mode;
    if (typeof path !== "string" || !path || path.includes("\0") || (mountMode !== "ro" && mountMode !== "rw")) {
      throw new Error("Outer sandbox root is invalid");
    }
    return { path, mode: mountMode };
  });
  return { mode, roots };
}

/** Build the complete PUM-in-claudebox invocation without starting it. */
export async function buildPumOuterSandboxPlan(
  options: LaunchPumOuterSandboxOptions,
): Promise<OuterSandboxLaunchPlan> {
  const environment = options.environment ?? process.env;
  if (environment[OUTER_SANDBOX_ENV] !== undefined) {
    throw new Error("PUM already runs inside an outer sandbox");
  }
  const runtimeExecutable = canonicalFile(
    options.runtimeExecutable ?? process.execPath,
    "PUM runtime executable",
  );
  const entrypointInput = options.entrypoint ?? process.argv[1];
  if (!entrypointInput) throw new Error("PUM entrypoint could not be resolved");
  const entrypoint = canonicalFile(entrypointInput, "PUM entrypoint");
  const agentDir = resolve(options.agentDir ?? AGENT_DIR);
  const packageRoot = resolve(options.packageRoot ?? packageRuntimeRoot(entrypoint));

  const childArgs = [...options.childArgs];
  const userPlan = await buildOuterSandboxLaunchPlan({
    mode: options.mode,
    cwd: options.cwd,
    mounts: options.mounts,
    command: [runtimeExecutable, entrypoint, ...childArgs],
    environment: {},
    executable: options.executable ?? claudeboxExecutable(environment),
  });

  if (options.mode === "read" && isPathInsideOrSame(userPlan.cwd, agentDir)) {
    throw new Error("pum sr requires PUM_DIR outside the read-only project directory");
  }
  mkdirSync(agentDir, { recursive: true });
  const internalMounts = [
    `${agentDir}:rw`,
    `${dirname(runtimeExecutable)}:ro`,
    `${packageRoot}:ro`,
  ];
  const launchEnvironment = {
    ...forwardedEnvironment(environment),
    PUM_DIR: agentDir,
    [OUTER_SANDBOX_MODE_ENV]: options.mode,
    [OUTER_SANDBOX_ROOTS_ENV]: JSON.stringify(userPlan.mounts),
  };

  return buildOuterSandboxLaunchPlan({
    mode: options.mode,
    cwd: userPlan.cwd,
    mounts: [...userPlan.mounts.map(mountArgument), ...internalMounts],
    command: userPlan.command,
    environment: launchEnvironment,
    executable: userPlan.executable,
  });
}

export async function launchPumOuterSandbox(
  options: LaunchPumOuterSandboxOptions,
): Promise<number> {
  if (process.platform !== "linux") {
    throw new Error("pum sandbox mode requires Linux. On Windows, run pum inside WSL 2");
  }
  const environment = options.environment ?? process.env;
  const executable = options.executable ?? claudeboxExecutable(environment);
  const probe = probeOuterSandboxRuntime({ environment: {
    ...environment,
    PUM_CLAUDEBOX: executable,
  } });
  if (!probe.available) {
    throw new Error(`claudebox is unavailable: ${probe.reason ?? "runtime probe failed"}. Run 'pum ss' for setup help`);
  }
  const plan = await buildPumOuterSandboxPlan({ ...options, executable });
  return runOuterSandbox({ executable: plan.executable, args: plan.args });
}

export function outerSandboxAdditionalRoots(
  context: OuterSandboxContext,
  cwd: string,
): string[] {
  const project = pathIdentity(cwd);
  return [...new Set(context.roots
    .map((root) => pathIdentity(root.path))
    .filter((path) => path !== project))];
}

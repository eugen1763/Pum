import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { pathIdentity } from "./platform";

export const OUTER_SANDBOX_ENV = "PUM_OUTER_SANDBOX";
export const OUTER_SANDBOX_MARKER = "claudebox";

export type OuterSandboxMode = "write" | "read";
export type OuterSandboxMountMode = "ro" | "rw";

export type OuterSandboxMount = {
  path: string;
  mode: OuterSandboxMountMode;
};

export type OuterSandboxLaunchPlan = {
  executable: string;
  args: string[];
  cwd: string;
  mounts: OuterSandboxMount[];
  environment: Record<string, string>;
  command: string[];
};

export type BuildOuterSandboxPlanOptions = {
  mode: OuterSandboxMode;
  cwd: string;
  mounts?: readonly string[];
  command: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  executable?: string;
};

type ParsedMountArgument = {
  path: string;
  mode?: OuterSandboxMountMode;
};

function defaultMountMode(mode: OuterSandboxMode): OuterSandboxMountMode {
  return mode === "write" ? "rw" : "ro";
}

function assertText(value: string, label: string): void {
  if (!value || value.includes("\0")) throw new Error(`${label} is invalid`);
}

/** Parse only a final :ro or :rw suffix. Other colons remain part of the path. */
export function parseOuterSandboxMountArgument(argument: string): ParsedMountArgument {
  assertText(argument, "Outer sandbox mount");
  const match = /^(.*):(ro|rw)$/u.exec(argument);
  if (!match) return { path: argument };
  if (!match[1]) throw new Error("Outer sandbox mount path is empty");
  return { path: match[1], mode: match[2] as OuterSandboxMountMode };
}

async function canonicalDirectory(input: string, base: string, label: string): Promise<string> {
  assertText(input, label);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(base, input);
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new Error(`${label} does not exist: ${input}`);
  }

  // A different resolved identity means that at least one path component is a
  // symbolic link or junction. Reject the complete input instead of silently
  // changing the requested mount boundary.
  if (pathIdentity(absolute) !== pathIdentity(canonical)) {
    throw new Error(`${label} contains a symbolic link or junction: ${input}`);
  }

  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) throw new Error(`${label} is not a directory: ${input}`);
  return canonical;
}

function mergeMount(
  mounts: Map<string, OuterSandboxMount>,
  path: string,
  mode: OuterSandboxMountMode,
): void {
  const identity = pathIdentity(path);
  const current = mounts.get(identity);
  if (!current || (current.mode === "ro" && mode === "rw")) {
    mounts.set(identity, { path, mode });
  }
}

function launchEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (Object.prototype.hasOwnProperty.call(source, OUTER_SANDBOX_ENV)) {
    throw new Error("PUM already runs inside an outer sandbox");
  }

  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\0")) {
      throw new Error(`Outer sandbox environment entry is invalid: ${name}`);
    }
    entries.push([name, value]);
  }
  entries.push([OUTER_SANDBOX_ENV, OUTER_SANDBOX_MARKER]);
  entries.sort(([first], [second]) => first.localeCompare(second));
  return Object.fromEntries(entries);
}

/** Build the complete deterministic claudebox invocation without starting it. */
export async function buildOuterSandboxLaunchPlan(
  options: BuildOuterSandboxPlanOptions,
): Promise<OuterSandboxLaunchPlan> {
  const executable = options.executable ?? "claudebox";
  assertText(executable, "Outer sandbox executable");
  if (options.command.length === 0 || !options.command[0] || options.command[0].includes("\0")) {
    throw new Error("Outer sandbox command is required");
  }
  if (options.command.some((argument) => argument.includes("\0"))) {
    throw new Error("Outer sandbox command argument is invalid");
  }

  const cwdBase = isAbsolute(options.cwd) ? parse(options.cwd).root : process.cwd();
  const cwd = await canonicalDirectory(options.cwd, cwdBase, "Outer sandbox working directory");
  const fallbackMode = defaultMountMode(options.mode);
  const mounts = new Map<string, OuterSandboxMount>();
  mergeMount(mounts, cwd, fallbackMode);

  for (const argument of options.mounts ?? []) {
    const parsed = parseOuterSandboxMountArgument(argument);
    const path = await canonicalDirectory(parsed.path, cwd, "Outer sandbox mount");
    mergeMount(mounts, path, parsed.mode ?? fallbackMode);
  }
  // The launch command owns the current-directory permission. An extra mount
  // argument can change another directory, but it cannot override the cwd.
  mounts.set(pathIdentity(cwd), { path: cwd, mode: fallbackMode });

  const orderedMounts = [...mounts.values()]
    .sort((first, second) => first.path.localeCompare(second.path));
  const environment = launchEnvironment(options.environment ?? {});
  const args = ["--no-mount-home", "--cwd", cwd];
  for (const mount of orderedMounts) args.push("--mount", `${mount.path}:${mount.mode}`);
  for (const [name, value] of Object.entries(environment)) args.push("--env", `${name}=${value}`);
  args.push("--exec", "--", ...options.command);

  return {
    executable,
    args,
    cwd,
    mounts: orderedMounts,
    environment,
    command: [...options.command],
  };
}

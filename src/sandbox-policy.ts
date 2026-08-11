import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { AGENT_DIR } from "./config";
import type { CheckPolicyResult } from "./check-policy";
import { isPathInsideOrSame, pathIdentity, type RuntimePlatform } from "./platform";
import type {
  SandboxCapability,
  SandboxMode,
  SandboxPolicy,
  SandboxPolicyAccess,
} from "./sandbox/types";

export type BuildSandboxPolicyOptions = {
  /** Exact command accepted by Check mode and any required user approval. */
  command: string;
  /** Authoritative configured prefix plus command actually passed to the shell. */
  executionCommand?: string;
  /** Authoritative project working directory. */
  cwd: string;
  /** Canonical Check mode roots for the launch project. */
  additionalRoots?: readonly string[];
  /** Deterministic Check mode result for the exact command. */
  result: CheckPolicyResult;
  /** Resolved shell executable. A backend must not select a shell. */
  executable: string;
  /** Complete shell arguments. For stdin-transport shells the command is supplied separately. */
  args: readonly string[];
  /** The resolved shell receives the exact command on stdin instead of argv. */
  stdin?: boolean;
  /** Private temporary directory prepared by the controller. */
  privateTemp: string;
  environment?: Readonly<Record<string, string | undefined>>;
  pumConfigRoot?: string;
  home?: string;
  platform?: RuntimePlatform;
  /** Mount project and additional roots read-only instead of read-write. */
  readonlyRoots?: boolean;
  /** Extra trusted roots needed for read-only inspection, such as managed worktree Git metadata. */
  additionalReadOnlyRoots?: readonly string[];
};

const SENSITIVE_ENVIRONMENT = /(?:^|_)(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|PASS(?:WORD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/i;
/** A valid POSIX environment variable name. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INJECTION_ENVIRONMENT = new Set([
  "BASH_ENV", "BUN_OPTIONS", "ENV", "GIT_CONFIG_COUNT", "NODE_OPTIONS", "PERL5OPT",
  "PROMPT_COMMAND", "PYTHONINSPECT", "PYTHONPATH", "RUBYOPT", "SHELLOPTS", "ZDOTDIR",
]);

export function isSandboxEnvironmentVariableDenied(name: string): boolean {
  const upper = name.toUpperCase();
  return SENSITIVE_ENVIRONMENT.test(upper)
    || INJECTION_ENVIRONMENT.has(upper)
    || upper.startsWith("AWS_")
    || upper.startsWith("AZURE_")
    || upper.startsWith("GOOGLE_")
    || upper.startsWith("GITHUB_")
    || upper.startsWith("NPM_")
    || upper.startsWith("PUM_")
    || upper.startsWith("PI_SESSION_");
}

/** Remove credentials, PUM/session metadata, and runtime injection variables. */
export function sanitizeSandboxEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => value !== undefined
      && !name.includes("\0")
      // Drop names that are not valid POSIX identifiers. An exported bash
      // function arrives as BASH_FUNC_foo%% and would let a function named
      // git or ls shadow the analyzed command; the Linux backend also hard
      // throws on such names.
      && ENVIRONMENT_NAME.test(name)
      && !isSandboxEnvironmentVariableDenied(name))
    .map(([name, value]) => [name, value!] as const)
    .sort(([first], [second]) => first.localeCompare(second)));
}

function pathApi(path: string, platform: RuntimePlatform): typeof posix {
  return platform === "win32" || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? win32
    : posix;
}

function canonicalPath(path: string, cwd: string, platform: RuntimePlatform): string {
  const paths = pathApi(cwd, platform);
  const absolute = paths.isAbsolute(path) ? path : paths.resolve(cwd, path);
  return pathIdentity(absolute, platform);
}

function uniquePaths(paths: readonly string[], platform: RuntimePlatform): string[] {
  return [...new Set(paths.map((path) => pathIdentity(path, platform)))]
    .sort((first, second) => first.localeCompare(second));
}

/** Remove narrower paths when a root with the same permission already contains them. */
function collapseSamePermissionRoots(paths: readonly string[], platform: RuntimePlatform): string[] {
  const unique = uniquePaths(paths, platform);
  return unique.filter((candidate) => !unique.some((parent) => (
    parent !== candidate && isPathInsideOrSame(parent, candidate, platform)
  )));
}

function deniedCredentialPaths(roots: readonly string[], home: string, platform: RuntimePlatform): string[] {
  const directoryNames = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"];
  // The deterministic layer's isCredentialSensitivePath matches /^\.env(?:\..+)?$/
  // at any path segment. A backend denied path is one concrete path, not a
  // recursive glob, so PUM masks every known .env variant at each writable
  // root's top level. LIMIT: a nested .env below a root (for example
  // packages/api/.env) cannot be enumerated by this pure policy function and is
  // not masked by name here; the mount masks below still cover the root itself.
  const fileNames = [
    ".env", ".env.local", ".env.development", ".env.development.local",
    ".env.production", ".env.production.local", ".env.test", ".env.test.local",
    ".env.staging", ".env.staging.local",
    ".git-credentials", ".npmrc", ".pypirc", ".netrc", "auth.json", "credentials.json",
  ];
  const denied: string[] = [];
  for (const root of [...roots, home]) {
    const paths = pathApi(root, platform);
    denied.push(...directoryNames.map((name) => paths.join(root, name)));
    denied.push(...fileNames.map((name) => paths.join(root, name)));
  }
  if (platform !== "win32") {
    denied.push("/root", "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d", "/etc/ssh");
  }
  return uniquePaths(denied, platform);
}

function canonicalAccesses(
  result: CheckPolicyResult,
  cwd: string,
  platform: RuntimePlatform,
): SandboxPolicyAccess[] {
  return result.accesses.map(({ resolvedPath, mode, source, stage, external }) => ({
    resolvedPath: canonicalPath(resolvedPath, cwd, platform),
    mode,
    source,
    stage,
    external,
  }));
}

/** Build a backend-neutral policy from authoritative inputs and deterministic Check mode output. */
export function buildSandboxPolicy(options: BuildSandboxPolicyOptions): SandboxPolicy {
  const platform = options.platform ?? process.platform;
  if (!options.command || options.command.includes("\0")) throw new Error("Sandbox command is invalid");
  const executionCommand = options.executionCommand ?? options.command;
  if (options.result.exactCommand !== executionCommand) throw new Error("Sandbox command does not match the Check mode analysis");
  if (!options.executable || options.executable.includes("\0")) throw new Error("Sandbox executable is invalid");
  if (!pathApi(options.cwd, platform).isAbsolute(options.executable)) throw new Error("Sandbox executable must be resolved");
  if (options.args.some((argument) => argument.includes("\0"))) throw new Error("Sandbox arguments are invalid");
  if (!options.stdin && !options.args.includes(executionCommand)) {
    throw new Error("Sandbox arguments must contain the exact command");
  }
  if (!options.result.analysis.complete || options.result.analysis.truncated || !options.result.analysis.syntaxBalanced) {
    throw new Error("Sandbox policy requires complete Check mode analysis");
  }
  if (options.result.decision === "block") {
    throw new Error(`Sandbox policy cannot grant a blocked command: ${options.result.reason}`);
  }

  const cwd = canonicalPath(options.cwd, options.cwd, platform);
  const authorizedRoots = collapseSamePermissionRoots([
    cwd,
    ...(options.additionalRoots ?? []).map((root) => canonicalPath(root, cwd, platform)),
  ], platform);
  const readWritePaths = options.readonlyRoots ? [] : authorizedRoots;
  const accesses = canonicalAccesses(options.result, cwd, platform);
  const readOnlyPaths = collapseSamePermissionRoots([
    ...(options.readonlyRoots ? authorizedRoots : []),
    ...(options.additionalReadOnlyRoots ?? []).map((root) => canonicalPath(root, cwd, platform)),
    ...accesses
      .filter((access) => access.external && access.mode === "read")
      .map((access) => access.resolvedPath)
      .filter((path) => !authorizedRoots.some((root) => isPathInsideOrSame(root, path, platform))),
  ], platform);
  const deniedPaths = uniquePaths([
    canonicalPath(options.pumConfigRoot ?? AGENT_DIR, cwd, platform),
    ...deniedCredentialPaths(authorizedRoots, options.home ?? homedir(), platform),
  ], platform);

  const privateTemp = canonicalPath(options.privateTemp, cwd, platform);
  const environment = sanitizeSandboxEnvironment(options.environment ?? process.env);
  environment.TEMP = privateTemp;
  environment.TMP = privateTemp;
  if (platform !== "win32") environment.TMPDIR = privateTemp;

  return {
    version: 1,
    exactCommand: options.command,
    cwd,
    readOnlyPaths,
    readWritePaths,
    deniedPaths,
    privateTemp,
    environment,
    executable: canonicalPath(options.executable, cwd, platform),
    args: [...options.args],
    network: options.readonlyRoots
      ? "deny"
      : options.result.network.access === "host" ? "host" : "deny",
    rationale: options.result.reason,
    accesses,
    networkCommands: [...options.result.network.commands],
  };
}

export type SandboxModeDecision = {
  action: "direct" | "sandbox" | "block";
  warning?: string;
  reason?: string;
};

/** Resolve one capability probe. The caller displays an automatic fallback warning once. */
export function decideSandboxMode(
  mode: SandboxMode,
  capability: SandboxCapability,
): SandboxModeDecision {
  if (mode === "off") return { action: "direct" };
  if (capability.state === "enforced") return { action: "sandbox" };
  const reason = capability.reason ?? `sandbox backend ${capability.backend} is ${capability.state}`;
  if (mode === "require") {
    return { action: "block", reason: `Sandbox enforcement is required: ${reason}` };
  }
  return {
    action: "direct",
    warning: `Sandbox enforcement is unavailable. PUM will use deterministic Check mode only. ${reason}`,
  };
}

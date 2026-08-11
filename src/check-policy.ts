import { existsSync, lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export type CheckPolicyProfile = "strict" | "balanced" | "ask";
export type CheckPolicyDecision = "allow" | "ask" | "block";
export type CheckPolicySeverity = "hard-block" | "review";

export type CheckPolicyFindingCode =
  | "analysis-limit"
  | "unbalanced-shell"
  | "outside-project"
  | "escaping-symlink"
  | "credential-access"
  | "privilege-escalation"
  | "persistence"
  | "remote-script-execution"
  | "external-read-exfiltration"
  | "destructive-git"
  | "broad-deletion"
  | "unsafe-npm-install"
  | "unsafe-npm-pack"
  | "suspicious-execution"
  | "shell-complexity"
  | "mutation"
  | "unknown-path-access"
  | "unrecognized-command";

export type CheckPolicyFinding = {
  code: CheckPolicyFindingCode;
  severity: CheckPolicySeverity;
  message: string;
  stage?: number;
  path?: string;
};

export type CheckPathAccessMode = "read" | "write" | "execute" | "location" | "unknown";

export type CheckPathAccess = {
  path: string;
  /** Deterministic absolute path resolved during Check mode analysis. */
  resolvedPath: string;
  mode: CheckPathAccessMode;
  source: "operand" | "redirection" | "executable";
  stage: number;
  external: boolean;
};

export type CheckNetworkIntent = {
  access: "none" | "host";
  commands: string[];
};

export type BashOperator = {
  operator: ";;&" | ";;" | ";&" | ";" | "newline" | "&&" | "||" | "&" | "|" | "|&";
  start: number;
  end: number;
  nesting: number;
};

export type BashRedirection = {
  operator: string;
  start: number;
  end: number;
  target?: string;
  targetStart?: number;
  targetEnd?: number;
};

export type BashSubstitution = {
  kind: "command" | "backtick" | "process-input" | "process-output";
  start: number;
  end: number;
  text: string;
};

export type BashStage = {
  index: number;
  start: number;
  end: number;
  text: string;
  operatorBefore?: BashOperator["operator"];
  operatorAfter?: BashOperator["operator"];
  pipeline: number;
  argv: string[];
  envAssignments: Record<string, string>;
  redirections: BashRedirection[];
  substitutions: BashSubstitution[];
  mutationIntent: string[];
};

export type BashAnalysis = {
  complete: boolean;
  syntaxBalanced: boolean;
  truncated: boolean;
  operators: BashOperator[];
  stages: BashStage[];
  redirections: BashRedirection[];
  substitutions: BashSubstitution[];
  mutationIntent: { possible: boolean; indicators: string[] };
  errors: string[];
};

export type CheckPolicyResult = {
  /** Exact command text, or canonical direct argv text, that produced this result. */
  exactCommand: string;
  profile: CheckPolicyProfile;
  decision: CheckPolicyDecision;
  reason: string;
  findings: CheckPolicyFinding[];
  accesses: CheckPathAccess[];
  analysis: BashAnalysis;
  network: CheckNetworkIntent;
};

export type CheckPolicyLimits = {
  maxCommandChars: number;
  maxStages: number;
  maxAnnotations: number;
  maxTokensPerStage: number;
  maxTokenChars: number;
};

export type CheckPolicyFileSystem = {
  exists(path: string): boolean;
  isSymbolicLink(path: string): boolean;
  realpath(path: string): string;
};

export type AnalyzeCheckPolicyOptions = {
  command: string;
  cwd: string;
  /** Canonical directory roots explicitly added for this launch project. */
  allowedPaths?: readonly string[];
  profile?: CheckPolicyProfile;
  limits?: Partial<CheckPolicyLimits>;
  fileSystem?: CheckPolicyFileSystem;
  /** Canonical sensitive roots that no checked command may access. */
  protectedPaths?: readonly string[];
  /** Exact canonical files exempt from their protected root. No directory is ever exempt. */
  allowedProtectedFiles?: readonly string[];
};

export type ProcessCheckOperation = "create" | "start" | "resume" | "repeat" | "invoke-run";

export type ProcessCheckProposal = {
  kind: "process";
  source: "external-trigger";
  executable: string;
  /** Process arguments. The executable is not included. */
  args: readonly string[];
  cwd: string;
  operation: ProcessCheckOperation;
  /** Display context only. This field is not part of the safety identity. */
  triggerName?: string;
};

export type AnalyzeExecutablePolicyOptions = Pick<ProcessCheckProposal, "executable" | "args" | "cwd"> & {
  projectCwd?: string;
  /** Canonical directory roots explicitly added for this launch project. */
  allowedPaths?: readonly string[];
  profile?: CheckPolicyProfile;
  limits?: Partial<CheckPolicyLimits>;
  fileSystem?: CheckPolicyFileSystem;
  /** Canonical sensitive roots that no checked process may access. */
  protectedPaths?: readonly string[];
  /** Exact canonical files exempt from their protected root. No directory is ever exempt. */
  allowedProtectedFiles?: readonly string[];
};

export const DEFAULT_CHECK_POLICY_LIMITS: Readonly<CheckPolicyLimits> = Object.freeze({
  maxCommandChars: 64_000,
  maxStages: 256,
  maxAnnotations: 1_024,
  maxTokensPerStage: 256,
  maxTokenChars: 8_192,
});

const nodeFileSystem: CheckPolicyFileSystem = {
  exists: existsSync,
  isSymbolicLink: (path) => lstatSync(path).isSymbolicLink(),
  realpath: realpathSync,
};

const MUTATION_COMMANDS = new Map<string, string>([
  ["rm", "deletion command"], ["rmdir", "deletion command"], ["unlink", "deletion command"],
  ["shred", "destructive deletion command"], ["mv", "filesystem move"], ["cp", "filesystem copy"],
  ["install", "filesystem install"], ["mkdir", "directory creation"], ["touch", "file timestamp or creation"],
  ["truncate", "file truncation"], ["dd", "raw copy or overwrite"], ["tee", "file output"],
  ["chmod", "permission change"], ["chown", "ownership change"], ["chgrp", "group change"],
  ["setfacl", "access-control change"], ["sed", "possible in-place edit"], ["perl", "possible in-place edit"],
]);

const SHELL_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "pwsh", "powershell", "cmd"]);
const REMOTE_COMMANDS = new Set(["curl", "wget", "fetch", "invoke-webrequest", "iwr"]);
const STDIN_NETWORK_COMMANDS = new Set(["nc", "ncat", "netcat", "socat", "ssh"]);
const PATH_OPERAND_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "stat", "file", "ls", "tree", "du", "wc", "realpath",
  "readlink", "rm", "rmdir", "unlink", "shred", "mv", "cp", "install", "mkdir", "touch", "truncate",
  "chmod", "chown", "chgrp", "setfacl", "tee", "sed", "perl",
  "node", "bun", "deno", "python", "python3", "ruby", "perl", "php", "java",
  "cd", "chdir", "set-location",
]);
const PRIVILEGE_COMMANDS = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
const PERSISTENCE_COMMANDS = new Set(["crontab", "at", "schtasks", "launchctl"]);
const CREDENTIAL_COMMANDS = new Set(["pass", "secret-tool", "security", "cmdkey", "keychain"]);
const CREDENTIAL_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".pypirc", ".netrc",
  "credentials", "credentials.json", "auth.json", "id_rsa", "id_ed25519", "known_hosts",
]);
const SAFE_READ_COMMANDS = new Set([
  "pwd", "printf", "echo", "true", "false", "test", "[", "ls", "tree", "cat", "head", "tail",
  "wc", "stat", "file", "du", "realpath", "readlink", "grep", "rg", "git",
]);
const EXPLICIT_READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "stat", "file", "ls", "tree", "du", "wc", "realpath", "readlink",
]);
const DATA_OPERAND_COMMANDS = new Set(["printf", "echo"]);

type NpmPackCommand = {
  valid: boolean;
  reason?: string;
  packageSpec?: string;
  cache?: string;
  packDestination: string;
};

type NpmInstallCommand = {
  valid: boolean;
  reason?: string;
  packageSpec?: string;
  prefix?: string;
  cache?: string;
};

function isExactRegistryPackageVersion(value: string): boolean {
  const packageName = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)`;
  const numericIdentifier = String.raw`(?:0|[1-9]\d*)`;
  const prereleaseIdentifier = String.raw`(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
  const buildIdentifier = String.raw`[0-9a-zA-Z-]+`;
  const version = String.raw`${numericIdentifier}\.${numericIdentifier}\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*)?(?:\+${buildIdentifier}(?:\.${buildIdentifier})*)?`;
  return new RegExp(`^${packageName}@${version}$`).test(value);
}

function npmInstallCommand(argv: string[]): NpmInstallCommand | undefined {
  if (commandName(argv[0]) !== "npm" || argv[1] !== "install") return undefined;
  const positionals: string[] = [];
  let prefix: string | undefined;
  let cache: string | undefined;
  let ignoreScriptsCount = 0;
  const pathOptions = new Map([["--prefix", "prefix"], ["--cache", "cache"]] as const);

  for (let index = 2; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--ignore-scripts") {
      ignoreScriptsCount++;
      continue;
    }
    const separate = pathOptions.get(value as "--prefix" | "--cache");
    if (separate) {
      const path = argv[++index];
      if (!path || path.startsWith("-")) return { valid: false, reason: `${value} requires one explicit path` };
      if (separate === "prefix") {
        if (prefix !== undefined) return { valid: false, reason: "npm install --prefix must occur exactly once" };
        prefix = path;
      } else {
        if (cache !== undefined) return { valid: false, reason: "npm install --cache must occur exactly once" };
        cache = path;
      }
      continue;
    }
    const attached = /^(--prefix|--cache)=(.*)$/.exec(value);
    if (attached) {
      if (!attached[2]) return { valid: false, reason: `${attached[1]} requires one explicit path` };
      if (attached[1] === "--prefix") {
        if (prefix !== undefined) return { valid: false, reason: "npm install --prefix must occur exactly once" };
        prefix = attached[2];
      } else {
        if (cache !== undefined) return { valid: false, reason: "npm install --cache must occur exactly once" };
        cache = attached[2];
      }
      continue;
    }
    if (value.startsWith("-")) {
      return { valid: false, reason: `npm install option ${value} is not in the deterministic allowlist` };
    }
    positionals.push(value);
  }

  if (ignoreScriptsCount !== 1) {
    return { valid: false, reason: "npm install must disable lifecycle scripts exactly once with --ignore-scripts" };
  }
  if (!prefix) return { valid: false, reason: "npm install must set an explicit approved --prefix path" };
  if (!cache) return { valid: false, reason: "npm install must set an explicit approved --cache path" };
  if ([prefix, cache].some((path) => /[*?\[\]{}]/.test(path))) {
    return { valid: false, reason: "npm install write paths must not contain shell expansion patterns" };
  }
  if (positionals.length !== 1 || !isExactRegistryPackageVersion(positionals[0]!)) {
    return { valid: false, reason: "npm install must use one exact registry package version" };
  }
  return { valid: true, packageSpec: positionals[0], prefix, cache };
}

function npmPackCommand(argv: string[]): NpmPackCommand | undefined {
  if (commandName(argv[0]) !== "npm" || argv[1] !== "pack") return undefined;
  const positionals: string[] = [];
  let cache: string | undefined;
  let packDestination = ".";
  let packDestinationSet = false;
  let ignoreScripts = false;
  const booleanOptions = new Set(["--dry-run", "--json", "--ignore-scripts"]);
  const pathOptions = new Map([["--cache", "cache"], ["--pack-destination", "packDestination"]] as const);

  for (let index = 2; index < argv.length; index++) {
    const value = argv[index]!;
    if (booleanOptions.has(value)) {
      if (value === "--ignore-scripts") ignoreScripts = true;
      continue;
    }
    const separate = pathOptions.get(value as "--cache" | "--pack-destination");
    if (separate) {
      const path = argv[++index];
      if (!path || path.startsWith("-")) return { valid: false, reason: `${value} requires one explicit path`, packDestination };
      if (separate === "cache") {
        if (cache !== undefined) return { valid: false, reason: "npm pack --cache must occur exactly once", packDestination };
        cache = path;
      } else {
        if (packDestinationSet) return { valid: false, reason: "npm pack --pack-destination must occur at most once", packDestination };
        packDestination = path;
        packDestinationSet = true;
      }
      continue;
    }
    const attached = /^(--cache|--pack-destination)=(.*)$/.exec(value);
    if (attached) {
      if (!attached[2]) return { valid: false, reason: `${attached[1]} requires one explicit path`, packDestination };
      if (attached[1] === "--cache") {
        if (cache !== undefined) return { valid: false, reason: "npm pack --cache must occur exactly once", packDestination };
        cache = attached[2];
      } else {
        if (packDestinationSet) return { valid: false, reason: "npm pack --pack-destination must occur at most once", packDestination };
        packDestination = attached[2];
        packDestinationSet = true;
      }
      continue;
    }
    if (value === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (value.startsWith("-")) return { valid: false, reason: `npm pack option ${value} is not in the deterministic allowlist`, packDestination };
    positionals.push(value);
  }

  if (!ignoreScripts) return { valid: false, reason: "npm pack must disable lifecycle scripts with --ignore-scripts", packDestination };
  if (!cache) return { valid: false, reason: "npm pack must set an explicit project-local --cache path", packDestination };
  if (positionals.length > 1) return { valid: false, reason: "npm pack accepts at most one deterministic package spec", cache, packDestination };
  if (positionals[0] && !isExactRegistryPackageVersion(positionals[0])) {
    return { valid: false, reason: "npm pack package spec must be an exact registry package version", cache, packDestination };
  }
  return { valid: true, packageSpec: positionals[0], cache, packDestination };
}

function commandName(argv0: string | undefined): string {
  if (!argv0) return "";
  const basename = argv0.replaceAll("\\", "/").split("/").at(-1) ?? argv0;
  return basename.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function npmSubcommand(argv: string[]): string | undefined {
  if (commandName(argv[0]) !== "npm") return undefined;
  const valueOptions = new Set(["--cache", "--prefix", "--registry", "--userconfig"]);
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (valueOptions.has(value)) {
      index++;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value.toLowerCase();
  }
  return undefined;
}

function effectiveArgv(argv: string[]): string[] {
  let current = argv;
  for (let depth = 0; depth < 4; depth++) {
    const name = commandName(current[0]);
    if (name === "env") {
      let index = 1;
      while (index < current.length && (current[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[index]!))) index++;
      current = current.slice(index);
      continue;
    }
    if (name === "command" || name === "builtin" || name === "nohup") {
      let index = 1;
      while (index < current.length && current[index]!.startsWith("-")) index++;
      current = current.slice(index);
      continue;
    }
    if (name === "nice") {
      let index = 1;
      if (current[index] === "-n" || current[index] === "--adjustment") index += 2;
      else while (index < current.length && /^-\d+$/.test(current[index]!)) index++;
      current = current.slice(index);
      continue;
    }
    break;
  }
  return current;
}

function mergeLimits(input?: Partial<CheckPolicyLimits>): CheckPolicyLimits {
  const limits = { ...DEFAULT_CHECK_POLICY_LIMITS, ...input };
  for (const key of Object.keys(limits) as Array<keyof CheckPolicyLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) limits[key] = DEFAULT_CHECK_POLICY_LIMITS[key];
  }
  return limits;
}

function trimRange(command: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(command[start]!)) start++;
  while (end > start && /\s/.test(command[end - 1]!)) end--;
  return [start, end];
}

type Token = { value: string; start: number; end: number; redirection?: string };

function backslashEscapesNext(text: string, index: number, quote: "'" | "\"" | null): boolean {
  if (quote === "'") return false;
  if (quote === "\"") return text[index + 1] !== undefined && "$`\"\\\n".includes(text[index + 1]!);
  return true;
}

function tokenizeStage(text: string, absoluteStart: number, limits: CheckPolicyLimits): { tokens: Token[]; balanced: boolean; truncated: boolean } {
  const tokens: Token[] = [];
  let value = "";
  let tokenStart = -1;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let truncated = false;

  const append = (part: string, index: number) => {
    if (tokenStart < 0) tokenStart = index;
    if (value.length + part.length <= limits.maxTokenChars) value += part;
    else truncated = true;
  };
  const finish = (end: number) => {
    if (tokenStart < 0) return;
    if (tokens.length < limits.maxTokensPerStage) tokens.push({ value, start: absoluteStart + tokenStart, end: absoluteStart + end });
    else truncated = true;
    value = "";
    tokenStart = -1;
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (escaped) {
      append(char, index);
      escaped = false;
      continue;
    }
    if (char === "\\" && backslashEscapesNext(text, index, quote)) {
      if (tokenStart < 0) tokenStart = index;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else append(char, index);
      continue;
    }
    if (char === "'" || char === "\"") {
      if (tokenStart < 0) tokenStart = index;
      quote = char;
      continue;
    }
    if ((char === "$" && text[index + 1] === "(") || ((char === "<" || char === ">") && text[index + 1] === "(")) {
      append(`${char}(`, index);
      substitutionDepth++;
      index++;
      continue;
    }
    if (char === ")" && substitutionDepth > 0) {
      append(char, index);
      substitutionDepth--;
      continue;
    }
    if (/\s/.test(char) && substitutionDepth === 0) {
      finish(index);
      continue;
    }
    const redirect = substitutionDepth === 0
      ? text.slice(index).match(/^(?:(?:\d+)?(?:<<<|<<-?|>>|<>|>\||>&|<&|>|<)|&>>?)/)?.[0]
      : undefined;
    if (redirect) {
      finish(index);
      if (tokens.length < limits.maxTokensPerStage) {
        tokens.push({ value: redirect, start: absoluteStart + index, end: absoluteStart + index + redirect.length, redirection: redirect });
      } else truncated = true;
      index += redirect.length - 1;
      continue;
    }
    append(char, index);
  }
  finish(text.length);
  return { tokens, balanced: !quote && !escaped && substitutionDepth === 0, truncated };
}

function mutationIndicators(argv: string[], redirections: BashRedirection[]): string[] {
  const name = commandName(argv[0]);
  const indicators: string[] = [];
  const generic = MUTATION_COMMANDS.get(name);
  if (generic) {
    if ((name !== "sed" && name !== "perl") || argv.slice(1).some((arg) => /^-[^-]*i/.test(arg) || arg === "--in-place")) indicators.push(generic);
  }
  if (redirections.some((item) => item.operator.includes(">"))) indicators.push("output redirection");
  if (name === "git" && argv[1] && !new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"]).has(argv[1])) {
    indicators.push("Git state change");
  }
  if (npmInstallCommand(argv)?.valid) indicators.push("package installation or cache output");
  if (npmPackCommand(argv)?.valid) indicators.push("package archive or cache output");
  return [...new Set(indicators)];
}

/** Parse a complete command string. The result uses bounded arrays and bounded token text. */
export function analyzeBashCommand(command: string, requestedLimits?: Partial<CheckPolicyLimits>): BashAnalysis {
  const limits = mergeLimits(requestedLimits);
  if (command.length > limits.maxCommandChars) {
    return {
      complete: false, syntaxBalanced: false, truncated: true, operators: [], stages: [], redirections: [],
      substitutions: [], mutationIntent: { possible: false, indicators: [] },
      errors: [`command exceeds ${limits.maxCommandChars} characters`],
    };
  }

  const operators: BashOperator[] = [];
  const redirections: BashRedirection[] = [];
  const substitutions: BashSubstitution[] = [];
  const stageRanges: Array<{ start: number; end: number; before?: BashOperator["operator"]; after?: BashOperator["operator"]; pipeline: number }> = [];
  const errors: string[] = [];
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let backtickStart: number | undefined;
  let stageStart = 0;
  let operatorBefore: BashOperator["operator"] | undefined;
  let pipeline = 0;
  let annotations = 0;
  let truncated = false;

  const addAnnotation = <T>(list: T[], value: T) => {
    annotations++;
    if (annotations <= limits.maxAnnotations) list.push(value);
    else truncated = true;
  };
  const addStage = (end: number, after?: BashOperator["operator"]) => {
    const [start, trimmedEnd] = trimRange(command, stageStart, end);
    if (trimmedEnd > start) {
      if (stageRanges.length < limits.maxStages) stageRanges.push({ start, end: trimmedEnd, before: operatorBefore, after, pipeline });
      else truncated = true;
    }
    if (after === "|" || after === "|&") pipeline++;
    else pipeline = 0;
  };

  for (let index = 0; index < command.length;) {
    const char = command[index]!;
    if (escaped) { escaped = false; index++; continue; }
    if (char === "\\" && backslashEscapesNext(command, index, quote)) { escaped = true; index++; continue; }
    if (char === "`" && quote !== "'") {
      if (backtickStart === undefined) backtickStart = index;
      else {
        addAnnotation(substitutions, { kind: "backtick", start: backtickStart, end: index + 1, text: command.slice(backtickStart + 1, index) });
        backtickStart = undefined;
      }
      index++;
      continue;
    }
    if (backtickStart !== undefined) { index++; continue; }
    const substitution = quote !== "'" && command.startsWith("$(", index) ? "command"
      : !quote && command.startsWith("<(" , index) ? "process-input"
      : !quote && command.startsWith(">(", index) ? "process-output" : undefined;
    if (substitution) {
      const start = index;
      let depth = 1;
      let innerQuote: "'" | "\"" | null = null;
      let innerEscaped = false;
      index += 2;
      while (index < command.length && depth > 0) {
        const inner = command[index]!;
        if (innerEscaped) { innerEscaped = false; index++; continue; }
        if (inner === "\\" && innerQuote !== "'") { innerEscaped = true; index++; continue; }
        if (innerQuote) { if (inner === innerQuote) innerQuote = null; index++; continue; }
        if (inner === "'" || inner === "\"") { innerQuote = inner; index++; continue; }
        if (inner === "(") depth++;
        else if (inner === ")") depth--;
        index++;
      }
      if (depth === 0) addAnnotation(substitutions, { kind: substitution, start, end: index, text: command.slice(start + 2, index - 1) });
      else errors.push(`unterminated ${substitution} substitution at ${start}`);
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      index++;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; index++; continue; }
    if (char === "(") { parenDepth++; index++; continue; }
    if (char === ")") { if (parenDepth === 0) errors.push(`unexpected ) at ${index}`); else parenDepth--; index++; continue; }
    if (char === "{") { braceDepth++; index++; continue; }
    if (char === "}") { if (braceDepth === 0) errors.push(`unexpected } at ${index}`); else braceDepth--; index++; continue; }

    const redirect = command.slice(index).match(/^(?:(?:\d+)?(?:<<<|<<-?|>>|<>|>\||>&|<&|>|<)|&>>?)/)?.[0];
    if (redirect) {
      addAnnotation(redirections, { operator: redirect, start: index, end: index + redirect.length });
      index += redirect.length;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1]!))) {
      const newline = command.indexOf("\n", index);
      if (newline < 0) { addStage(index); stageStart = command.length; index = command.length; continue; }
      const operator = { operator: "newline" as const, start: newline, end: newline + 1, nesting: parenDepth + braceDepth };
      addAnnotation(operators, operator);
      if (operator.nesting === 0) {
        addStage(index, "newline");
        stageStart = newline + 1;
        operatorBefore = "newline";
      }
      index = newline + 1;
      continue;
    }
    const rawOperator = [";;&", "&&", "||", "|&", ";;", ";&", ";", "|", "&", "\n"].find((item) => command.startsWith(item, index));
    if (rawOperator) {
      const normalized = rawOperator === "\n" ? "newline" : rawOperator as BashOperator["operator"];
      const nesting = parenDepth + braceDepth;
      const operator = { operator: normalized, start: index, end: index + rawOperator.length, nesting };
      addAnnotation(operators, operator);
      if (nesting === 0) {
        addStage(index, normalized);
        stageStart = index + rawOperator.length;
        operatorBefore = normalized;
      }
      index += rawOperator.length;
      continue;
    }
    index++;
  }
  addStage(command.length);

  if (quote) errors.push("unterminated quote");
  if (escaped) errors.push("trailing escape");
  if (backtickStart !== undefined) errors.push(`unterminated backtick substitution at ${backtickStart}`);
  if (parenDepth) errors.push("unbalanced parentheses");
  if (braceDepth) errors.push("unbalanced braces");
  if (truncated) errors.push("analysis annotation limit exceeded");

  const stages: BashStage[] = stageRanges.map((range, index) => {
    const text = command.slice(range.start, range.end);
    const tokenized = tokenizeStage(text, range.start, limits);
    if (!tokenized.balanced) errors.push(`stage ${index} tokenization is unbalanced`);
    if (tokenized.truncated) { truncated = true; errors.push(`stage ${index} token limit exceeded`); }
    const stageRedirections: BashRedirection[] = [];
    const argv: string[] = [];
    const envAssignments: Record<string, string> = {};
    for (let tokenIndex = 0; tokenIndex < tokenized.tokens.length; tokenIndex++) {
      const token = tokenized.tokens[tokenIndex]!;
      if (token.redirection) {
        const target = tokenized.tokens[tokenIndex + 1];
        const redirection: BashRedirection = { operator: token.redirection, start: token.start, end: token.end };
        if (target && !target.redirection) {
          redirection.target = target.value;
          redirection.targetStart = target.start;
          redirection.targetEnd = target.end;
          tokenIndex++;
        }
        stageRedirections.push(redirection);
        continue;
      }
      const assignment = argv.length === 0 ? token.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s) : null;
      if (assignment) envAssignments[assignment[1]!] = assignment[2]!;
      else argv.push(token.value);
    }
    const stageSubstitutions = substitutions.filter((item) => item.start >= range.start && item.end <= range.end);
    const indicators = mutationIndicators(argv, stageRedirections);
    return {
      index, start: range.start, end: range.end, text, operatorBefore: range.before, operatorAfter: range.after,
      pipeline: range.pipeline, argv, envAssignments, redirections: stageRedirections, substitutions: stageSubstitutions,
      mutationIntent: indicators,
    };
  });
  const indicators = [...new Set(stages.flatMap((stage) => stage.mutationIntent))];
  const syntaxBalanced = errors.every((error) => error.includes("limit"));
  return {
    complete: !truncated && syntaxBalanced,
    syntaxBalanced,
    truncated,
    operators,
    stages,
    redirections: stages.flatMap((stage) => stage.redirections),
    substitutions,
    mutationIntent: { possible: indicators.length > 0, indicators },
    errors,
  };
}

function pathFlavor(value: string, cwd: string): typeof posix | typeof win32 {
  const windowsSyntax = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  return windowsSyntax(value) || windowsSyntax(cwd) ? win32 : posix;
}

/** A lone drive-letter component such as /c or /d is a Git Bash / MSYS root. */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || /^\/[A-Za-z](?:\/|$)/.test(value);
}

/** Translate a Git Bash / MSYS drive path like /d/dev/Pum to D:\\dev\\Pum. */
function translateMsysDrivePath(value: string): string | undefined {
  const match = /^\/[A-Za-z](?:\/(.*))?$/.exec(value);
  if (!match) return undefined;
  return `${value[1]!.toUpperCase()}:\\${(match[1] ?? "").replaceAll("/", "\\")}`;
}

/** Translate a chain of unambiguous MSYS drives. Every component stays literal otherwise. */
function translateWindowsContextPath(value: string): string {
  return translateMsysDrivePath(value) ?? value;
}

type NormalizedWindowsContext = {
  cwd: string;
  projectCwd: string;
  allowedPaths: string[];
  protectedPaths: string[];
};

/**
 * Unify Git Bash / MSYS spellings with native Windows drive paths so the
 * session cwd, project roots, and protected roots share one identity. When no
 * path is Windows-like the values pass through unchanged, so POSIX policy
 * stays byte-for-byte the same.
 */
function normalizeWindowsContext(
  cwd: string,
  projectCwd: string,
  allowedPaths: readonly string[] = [],
  protectedPaths: readonly string[] = [],
): NormalizedWindowsContext {
  const windowsContext = isWindowsStylePath(cwd) || isWindowsStylePath(projectCwd)
    || allowedPaths.some(isWindowsStylePath) || protectedPaths.some(isWindowsStylePath);
  if (!windowsContext) {
    return { cwd, projectCwd, allowedPaths: [...allowedPaths], protectedPaths: [...protectedPaths] };
  }
  return {
    cwd: translateWindowsContextPath(cwd),
    projectCwd: translateWindowsContextPath(projectCwd),
    allowedPaths: allowedPaths.map(translateWindowsContextPath),
    protectedPaths: protectedPaths.map(translateWindowsContextPath),
  };
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function looksLikePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("~") || value.startsWith("/")
    || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("./")
    || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\")
    || value.includes("/") || value.includes("\\");
}

function normalizedAbsolute(
  value: string,
  cwd: string,
  projectCwd = cwd,
  allowedPaths: readonly string[] = [],
): { absolute: string; root: string; inside: boolean; additional: boolean } {
  const flavor = pathFlavor(value, cwd);
  const operand = flavor === win32 ? translateWindowsContextPath(value) : value;
  const roots = [projectCwd, ...allowedPaths]
    .map((root) => flavor.resolve(root))
    .sort((first, second) => second.length - first.length);
  const expanded = operand === "~" || operand.startsWith("~/") || operand.startsWith("~\\") ? operand : operand;
  const absolute = flavor.resolve(cwd, expanded);
  const root = roots.find((candidate) => {
    const relative = flavor.relative(candidate, absolute);
    return relative === "" || (!relative.startsWith("..") && !flavor.isAbsolute(relative));
  }) ?? flavor.resolve(projectCwd);
  const relative = flavor.relative(root, absolute);
  const inside = relative === "" || (!relative.startsWith("..") && !flavor.isAbsolute(relative));
  return {
    absolute,
    root,
    inside,
    additional: flavor.relative(flavor.resolve(projectCwd), root) !== "",
  };
}

function isAllowedRoot(value: string, cwd: string, projectCwd: string, allowedPaths: readonly string[]): boolean {
  const flavor = pathFlavor(value, cwd);
  const operand = flavor === win32 ? translateWindowsContextPath(value) : value;
  const absolute = flavor.resolve(cwd, operand);
  return [projectCwd, ...allowedPaths]
    .some((root) => flavor.relative(flavor.resolve(root), absolute) === "");
}

export function isCredentialSensitivePath(value: string): boolean {
  const lower = value.toLowerCase().replaceAll("\\", "/");
  const segments = lower.split("/").filter(Boolean);
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) return true;
  return segments.some((segment) => /^\.env(?:\..+)?$/.test(segment))
    || lower.includes("secrets/") || lower.endsWith("/shadow") || lower.endsWith("/passwd");
}

function isNullDevice(value: string): boolean {
  return value === "/dev/null";
}

function pathOperands(stage: BashStage): string[] {
  const name = commandName(stage.argv[0]);
  const values = stage.redirections.flatMap((item) => item.target ? [item.target] : []);
  if (DATA_OPERAND_COMMANDS.has(name)) return [...new Set(values)];
  const pathValueOptions = new Set(["-C", "--cwd", "--directory", "--chdir", "--git-dir", "--work-tree", "--prefix"]);
  for (let index = 1; index < stage.argv.length; index++) {
    const value = stage.argv[index]!;
    if (value === "--") {
      values.push(...stage.argv.slice(index + 1));
      break;
    }
    if (pathValueOptions.has(value) && stage.argv[index + 1]) {
      values.push(stage.argv[++index]!);
      continue;
    }
    const optionPath = value.match(/^(?:--cwd|--directory|--chdir|--git-dir|--work-tree|--prefix)=(.+)$/)?.[1];
    if (optionPath) {
      values.push(optionPath);
      continue;
    }
    if (value.startsWith("-") || isUrl(value)) continue;
    if (PATH_OPERAND_COMMANDS.has(name) || looksLikePath(value)) values.push(value);
  }
  return [...new Set(values)];
}

type ClassifiedAccess = Omit<CheckPathAccess, "stage" | "external" | "resolvedPath">;

function positionalOperands(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--") return [...values, ...argv.slice(index + 1)];
    if (!value.startsWith("-") || value === "-") values.push(value);
  }
  return values;
}

function grepReadOperands(argv: string[]): ClassifiedAccess[] {
  const accesses: ClassifiedAccess[] = [];
  let hasExplicitPattern = false;
  let consumedPattern = false;
  const valueOptions = new Set(["-A", "-B", "-C", "-m", "--after-context", "--before-context", "--context", "--max-count", "--type", "-t", "-T", "-g", "--glob"]);
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--") {
      const remaining = argv.slice(index + 1);
      if (!hasExplicitPattern && !consumedPattern) remaining.shift();
      accesses.push(...remaining.map((path) => ({ path, mode: "read" as const, source: "operand" as const })));
      break;
    }
    if (["-e", "--regexp"].includes(value)) {
      hasExplicitPattern = true;
      index++;
      continue;
    }
    if (["-f", "--file"].includes(value) && argv[index + 1]) {
      hasExplicitPattern = true;
      accesses.push({ path: argv[++index]!, mode: "read", source: "operand" });
      continue;
    }
    const fileOption = value.match(/^(?:--file|-f)=(.+)$/)?.[1];
    if (fileOption) {
      hasExplicitPattern = true;
      accesses.push({ path: fileOption, mode: "read", source: "operand" });
      continue;
    }
    if (["--pre"].includes(value) && argv[index + 1]) {
      accesses.push({ path: argv[++index]!, mode: "execute", source: "operand" });
      continue;
    }
    const preProgram = value.match(/^--pre=(.+)$/)?.[1];
    if (preProgram) {
      accesses.push({ path: preProgram, mode: "execute", source: "operand" });
      continue;
    }
    if (valueOptions.has(value)) {
      index++;
      continue;
    }
    if (value.startsWith("-")) continue;
    if (!hasExplicitPattern && !consumedPattern) {
      consumedPattern = true;
      continue;
    }
    accesses.push({ path: value, mode: "read", source: "operand" });
  }
  return accesses;
}

function interpreterAccesses(name: string, argv: string[]): ClassifiedAccess[] {
  const accesses: ClassifiedAccess[] = [];
  const inlineFlags = name === "cmd" ? new Set(["/c", "/k"])
    : name === "powershell" || name === "pwsh" ? new Set(["-c", "-command", "-encodedcommand", "-enc"])
    : new Set(["-c", "-e", "-E", "--eval", "--print", "-p"]);
  const executionOptions = new Set(["-r", "--require", "--import", "--loader", "--preload", "--import-map", "--rcfile", "--init-file", "-file"]);
  let inline = false;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    const lower = value.toLowerCase();
    if (inlineFlags.has(lower)) {
      inline = true;
      index++;
      continue;
    }
    if (executionOptions.has(lower) && argv[index + 1]) {
      accesses.push({ path: argv[++index]!, mode: "execute", source: "operand" });
      continue;
    }
    const executionOption = value.match(/^(?:--require|--import|--loader|--preload|--import-map|--rcfile|--init-file)=(.+)$/i)?.[1]
      ?? value.match(/^-I(.+)$/)?.[1];
    if (executionOption) {
      accesses.push({ path: executionOption, mode: "execute", source: "operand" });
      continue;
    }
    if (value.startsWith("-")) continue;
    if (!inline) accesses.push({ path: value, mode: "execute", source: "operand" });
    break;
  }
  return accesses;
}

function classifyStageAccesses(stage: BashStage): ClassifiedAccess[] {
  const argv = effectiveArgv(stage.argv);
  const name = commandName(argv[0]);
  const accesses: ClassifiedAccess[] = [];
  if (argv[0] && looksLikePath(argv[0])) accesses.push({ path: argv[0], mode: "execute", source: "executable" });

  for (const redirection of stage.redirections) {
    if (!redirection.target) continue;
    const operator = redirection.operator.replace(/^\d+/, "");
    if (["<<", "<<-", "<<<", "<&"].includes(operator)) continue;
    if (operator === ">&" && (/^\d+$/.test(redirection.target) || redirection.target === "-")) continue;
    const interpreterInput = operator === "<"
      && (SHELL_INTERPRETERS.has(name) || ["node", "bun", "deno", "python", "python3", "ruby", "perl", "php", "java"].includes(name));
    accesses.push({
      path: redirection.target,
      mode: operator === "<" ? (interpreterInput ? "execute" : "read") : "write",
      source: "redirection",
    });
  }

  if (DATA_OPERAND_COMMANDS.has(name)) return accesses;
  const npmInstall = npmInstallCommand(argv);
  if (npmInstall?.valid) {
    accesses.push({ path: npmInstall.prefix!, mode: "write", source: "operand" });
    accesses.push({ path: npmInstall.cache!, mode: "write", source: "operand" });
    return accesses;
  }
  const npmPack = npmPackCommand(argv);
  if (npmPack?.valid) {
    accesses.push({ path: npmPack.cache!, mode: "write", source: "operand" });
    accesses.push({ path: npmPack.packDestination, mode: "write", source: "operand" });
    return accesses;
  }
  if (["cd", "chdir", "set-location"].includes(name)) {
    return [...accesses, ...positionalOperands(argv).map((path) => ({ path, mode: "location" as const, source: "operand" as const }))];
  }
  if (EXPLICIT_READ_COMMANDS.has(name)) {
    return [...accesses, ...positionalOperands(argv).map((path) => ({ path, mode: "read" as const, source: "operand" as const }))];
  }
  if (name === "grep" || name === "rg") return [...accesses, ...grepReadOperands(argv)];
  if (REMOTE_COMMANDS.has(name)) {
    const uploadOptions = new Set(["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "--post-file"]);
    for (let index = 1; index < argv.length; index++) {
      const value = argv[index]!;
      if (uploadOptions.has(value) && argv[index + 1]) {
        const operand = argv[++index]!;
        const atPath = operand.match(/@(.+)$/)?.[1];
        const path = atPath ?? (value === "-T" || value === "--upload-file" || value === "--post-file" ? operand : undefined);
        if (path && path !== "-") accesses.push({ path, mode: "read", source: "operand" });
        continue;
      }
      if (["-InFile", "-Body"].includes(value) && argv[index + 1]) {
        const operand = argv[++index]!;
        const path = operand.startsWith("@") ? operand.slice(1) : operand;
        if (path !== "-") accesses.push({ path, mode: "read", source: "operand" });
        continue;
      }
      const attached = value.match(/^(?:--data|--data-binary|--data-raw|--data-urlencode|--form|--upload-file|--post-file)=(.+)$/)?.[1];
      if (attached) {
        const atPath = attached.match(/@(.+)$/)?.[1];
        const path = atPath ?? (/^--(?:upload-file|post-file)=/.test(value) ? attached : undefined);
        if (path && path !== "-") accesses.push({ path, mode: "read", source: "operand" });
      }
      const configPath = value.match(/^--config=(.+)$/)?.[1];
      if (configPath) accesses.push({ path: configPath, mode: "execute", source: "operand" });
      else if (value === "--config" && argv[index + 1]) accesses.push({ path: argv[++index]!, mode: "execute", source: "operand" });
    }
    return accesses;
  }

  const operands = positionalOperands(argv);
  if (name === "cp" || name === "install") {
    const targetOption = argv.find((arg) => arg.startsWith("--target-directory="))?.slice("--target-directory=".length);
    const targetIndex = argv.findIndex((arg) => arg === "-t" || arg === "--target-directory");
    const target = targetOption ?? (targetIndex >= 0 ? argv[targetIndex + 1] : undefined) ?? operands.at(-1);
    const sources = targetIndex >= 0 || targetOption ? operands.filter((path) => path !== target) : operands.slice(0, -1);
    accesses.push(...sources.map((path) => ({ path, mode: "read" as const, source: "operand" as const })));
    if (target) accesses.push({ path: target, mode: "write", source: "operand" });
    return accesses;
  }
  if (name === "mv") return [...accesses, ...operands.map((path) => ({ path, mode: "write" as const, source: "operand" as const }))];
  if (["rm", "rmdir", "unlink", "shred", "mkdir", "touch", "truncate", "chmod", "chown", "chgrp", "setfacl", "tee"].includes(name)) {
    return [...accesses, ...operands.map((path) => ({ path, mode: "write" as const, source: "operand" as const }))];
  }
  if (name === "dd") {
    for (const value of argv.slice(1)) {
      const match = /^(if|of)=(.+)$/.exec(value);
      if (match) accesses.push({ path: match[2]!, mode: match[1] === "if" ? "read" : "write", source: "operand" });
    }
    return accesses;
  }
  if (name === "sed") {
    const inPlace = argv.slice(1).some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[^-]*i/.test(arg));
    const programFiles: string[] = [];
    for (let index = 1; index < argv.length; index++) {
      if ((argv[index] === "-f" || argv[index] === "--file") && argv[index + 1]) programFiles.push(argv[++index]!);
      else {
        const program = argv[index]!.match(/^(?:--file|-f)=(.+)$/)?.[1] ?? argv[index]!.match(/^-f(.+)$/)?.[1];
        if (program) programFiles.push(program);
      }
    }
    accesses.push(...programFiles.map((path) => ({ path, mode: "execute" as const, source: "operand" as const })));
    const files = operands.slice(argv.slice(1).some((arg) => arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file") ? 0 : 1)
      .filter((path) => !programFiles.includes(path));
    accesses.push(...files.map((path) => ({ path, mode: inPlace ? "write" as const : "read" as const, source: "operand" as const })));
    return accesses;
  }
  if (name === "perl") {
    const inPlace = argv.slice(1).some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[^-]*i/.test(arg));
    const inline = argv.slice(1).some((arg) => arg === "-e" || arg === "-E");
    if (!inline) return [...accesses, ...interpreterAccesses(name, argv)];
    return [...accesses, ...operands.map((path) => ({ path, mode: inPlace ? "write" as const : "read" as const, source: "operand" as const }))];
  }
  if (name === "bun" && ["test", "run"].includes(argv[1] ?? "")) {
    return [...accesses, ...argv.slice(2).filter(looksLikePath).map((path) => ({ path, mode: "execute" as const, source: "operand" as const }))];
  }
  if (SHELL_INTERPRETERS.has(name) || ["node", "bun", "deno", "python", "python3", "ruby", "php", "java"].includes(name)) {
    return [...accesses, ...interpreterAccesses(name, argv)];
  }
  const optionPaths = argv.slice(1).flatMap((argument) => {
    const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : undefined;
    return value && looksLikePath(value) ? [value] : [];
  });
  const possiblePaths = [...pathOperands(stage), ...optionPaths].filter((path) => looksLikePath(path) && !/[\s$`]/.test(path));
  if (PATH_OPERAND_COMMANDS.has(name) || possiblePaths.length > 0) {
    accesses.push(...possiblePaths.map((path) => ({ path, mode: "unknown" as const, source: "operand" as const })));
  }
  return accesses;
}

function symlinkEscapes(path: string, root: string, fs: CheckPolicyFileSystem): boolean {
  const flavor = pathFlavor(path, root);
  let current = path;
  try {
    if (!fs.exists(root)) return false;
    while (!fs.exists(current)) {
      const parent = flavor.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    if (!fs.isSymbolicLink(current) && current === root) return false;
    const real = fs.realpath(current);
    const relative = flavor.relative(fs.realpath(root), real);
    return relative.startsWith("..") || flavor.isAbsolute(relative);
  } catch {
    return true;
  }
}

function additionalRootProblem(
  root: string,
  fs: CheckPolicyFileSystem,
): "missing" | "link" | undefined {
  try {
    if (!fs.exists(root)) return "missing";
    const flavor = pathFlavor(root, root);
    const resolved = flavor.resolve(root);
    const parsed = flavor.parse(resolved);
    let component = parsed.root;
    for (const part of resolved.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
      component = flavor.join(component, part);
      if (fs.isSymbolicLink(component)) return "link";
    }
    fs.realpath(root);
    return undefined;
  } catch {
    return "link";
  }
}

function addFinding(findings: CheckPolicyFinding[], finding: CheckPolicyFinding): void {
  if (!findings.some((item) => item.code === finding.code && item.stage === finding.stage && item.path === finding.path)) findings.push(finding);
}

function insideProtectedPath(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((protectedPath) => {
    const flavor = pathFlavor(path, protectedPath);
    const relative = flavor.relative(flavor.resolve(protectedPath), flavor.resolve(path));
    return relative === "" || (!relative.startsWith("..") && !flavor.isAbsolute(relative));
  });
}

/** Exact canonical identity comparison, case-folded on Windows spellings. */
function samePathIdentity(first: string, second: string): boolean {
  const flavor = pathFlavor(first, second);
  const identity = (value: string) => flavor === win32 ? flavor.resolve(value).toLowerCase() : flavor.resolve(value);
  return identity(first) === identity(second);
}

function externalPathUsesLink(path: string, fs: CheckPolicyFileSystem): boolean {
  const flavor = pathFlavor(path, path);
  const resolved = flavor.resolve(path);
  const parsed = flavor.parse(resolved);
  let component = parsed.root;
  try {
    for (const part of resolved.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
      component = flavor.join(component, part);
      if (!fs.exists(component)) return false;
      if (fs.isSymbolicLink(component)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function inspectHardBlocks(
  analysis: BashAnalysis,
  cwd: string,
  fs: CheckPolicyFileSystem,
  profile: CheckPolicyProfile,
  depth = 0,
  projectCwd = cwd,
  allowedPaths: readonly string[] = [],
  protectedPaths: readonly string[] = [],
  allowedProtectedFiles: readonly string[] = [],
): { findings: CheckPolicyFinding[]; accesses: CheckPathAccess[] } {
  const findings: CheckPolicyFinding[] = [];
  const accesses: CheckPathAccess[] = [];
  if (!analysis.complete) {
    addFinding(findings, { code: analysis.truncated ? "analysis-limit" : "unbalanced-shell", severity: "hard-block", message: analysis.errors.join("; ") || "shell analysis is incomplete" });
    return { findings, accesses };
  }

  let activeCwd = cwd;
  for (const stage of analysis.stages) {
    const argv = effectiveArgv(stage.argv);
    const name = commandName(argv[0]);
    const lowerArgs = argv.map((arg) => arg.toLowerCase());
    const npmInstall = npmInstallCommand(argv);
    if (npmInstall) {
      const direct = commandName(stage.argv[0]) === "npm"
        && analysis.stages.length === 1
        && analysis.operators.length === 0
        && stage.substitutions.length === 0
        && stage.redirections.length === 0
        && Object.keys(stage.envAssignments).length === 0;
      if (!direct || !npmInstall.valid) {
        addFinding(findings, {
          code: "unsafe-npm-install",
          severity: "hard-block",
          message: !direct ? "npm install must be one direct command without shell composition" : npmInstall.reason!,
          stage: stage.index,
        });
      }
    } else if (name === "npm" && new Set([
      "install", "i", "add", "ci", "install-ci-test", "install-test", "rebuild",
      "update", "upgrade", "remove", "uninstall", "link",
    ]).has(npmSubcommand(argv) ?? "")) {
      addFinding(findings, {
        code: "unsafe-npm-install",
        severity: "hard-block",
        message: "only the deterministic direct npm install verification form is supported",
        stage: stage.index,
      });
    }
    const npmPack = npmPackCommand(argv);
    if (npmPack) {
      const direct = commandName(stage.argv[0]) === "npm"
        && analysis.stages.length === 1
        && analysis.operators.length === 0
        && stage.substitutions.length === 0
        && stage.redirections.length === 0
        && Object.keys(stage.envAssignments).length === 0;
      if (!direct || !npmPack.valid) {
        addFinding(findings, {
          code: "unsafe-npm-pack",
          severity: "hard-block",
          message: !direct ? "npm pack must be one direct command without shell composition" : npmPack.reason!,
          stage: stage.index,
        });
      }
    }
    const globalPackageWrite = (name === "npm" || name === "bun")
      && lowerArgs.some((arg) => new Set(["install", "add", "i", "update", "upgrade", "remove", "uninstall", "link"]).has(arg))
      && lowerArgs.some((arg) => arg === "-g" || arg === "--global");
    if (globalPackageWrite) {
      addFinding(findings, {
        code: "outside-project",
        severity: "hard-block",
        message: "global package installation writes outside the project and approved roots",
        stage: stage.index,
      });
    }
    if (PRIVILEGE_COMMANDS.has(name)
      || ((name === "powershell" || name === "start-process") && lowerArgs.includes("runas"))) {
      addFinding(findings, { code: "privilege-escalation", severity: "hard-block", message: `${name} can escalate privileges`, stage: stage.index });
    }
    const credentialVariable = /\$(?:\{)?(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)(?:\})?/i.test(stage.text);
    const credentialRead = CREDENTIAL_COMMANDS.has(name)
      || (name === "printenv" && argv.slice(1).some((arg) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)/i.test(arg)));
    if (credentialVariable || credentialRead) {
      addFinding(findings, { code: "credential-access", severity: "hard-block", message: `${name || "command"} accesses credential material`, stage: stage.index });
    }
    const persistencePattern = /(?:^|[\\/])(?:\.bashrc|\.zshrc|\.profile|\.config[\\/]autostart|cron\.d)(?:$|[\\/])/i;
    const persistenceTarget = pathOperands(stage).some((target) => persistencePattern.test(target));
    if (PERSISTENCE_COMMANDS.has(name)
      || persistenceTarget
      || (name === "systemctl" && lowerArgs.some((arg) => ["enable", "reenable", "preset"].includes(arg)))
      || (name === "reg" && lowerArgs.includes("add") && /[\\/]CurrentVersion[\\/](?:Run|RunOnce)(?:[\\/\s]|$)/i.test(stage.text))) {
      addFinding(findings, { code: "persistence", severity: "hard-block", message: `${name || "redirection"} can install persistent execution`, stage: stage.index });
    }
    if (name === "git") {
      const args = lowerArgs.slice(1);
      const destructive = (args[0] === "clean" && args.some((arg) => /^-[a-z]*f/.test(arg)))
        || (args[0] === "reset" && args.includes("--hard"))
        || (args[0] === "checkout" && args.includes("--") && args.some((arg) => arg === "." || arg === "*"))
        || (args[0] === "restore" && args.some((arg) => arg === "." || arg === "*"))
        || (args[0] === "branch" && args.includes("-d"))
        || (args[0] === "push" && args.some((arg) => arg === "--force" || arg === "-f" || arg === "--mirror"));
      if (destructive) addFinding(findings, { code: "destructive-git", severity: "hard-block", message: "Git command can broadly destroy or overwrite work", stage: stage.index });
    }
    if (["rm", "rmdir", "unlink", "shred"].includes(name)) {
      const operands = argv.slice(1).filter((arg) => !arg.startsWith("-"));
      const recursive = argv.slice(1).some((arg) => arg === "--recursive" || /^-[^-]*r/i.test(arg));
      const force = argv.slice(1).some((arg) => arg === "--force" || /^-[^-]*f/i.test(arg));
      const broad = operands.some((arg) => [".", "..", "*", "./*", ".\\*", "/", "\\"].includes(arg)
        || /[*?\[]/.test(arg) || isAllowedRoot(arg, activeCwd, projectCwd, allowedPaths))
        || (recursive && force && operands.length !== 1);
      if (broad) addFinding(findings, { code: "broad-deletion", severity: "hard-block", message: "deletion target is broad or recursive across multiple paths", stage: stage.index });
    }

    const effectiveStage = argv === stage.argv ? stage : { ...stage, argv };
    for (const redirection of stage.redirections) {
      if (!redirection.target) {
        addFinding(findings, { code: "unknown-path-access", severity: "hard-block", message: "redirection target is missing", stage: stage.index });
      }
    }
    for (const classified of classifyStageAccesses(effectiveStage)) {
      const value = classified.path;
      const dynamic = /(?:\$\(|`|\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%)/.test(value);
      const resolved = normalizedAbsolute(value, activeCwd, projectCwd, allowedPaths);
      accesses.push({ ...classified, resolvedPath: resolved.absolute, stage: stage.index, external: !resolved.inside });
      if (dynamic) {
        addFinding(findings, { code: "unknown-path-access", severity: "hard-block", message: "path access is dynamic or ambiguous", stage: stage.index, path: value });
        continue;
      }
      const exemptSettingsFile = allowedProtectedFiles.some((settingsFile) => samePathIdentity(resolved.absolute, settingsFile));
      if (!exemptSettingsFile && (isCredentialSensitivePath(value) || insideProtectedPath(resolved.absolute, protectedPaths))) {
        addFinding(findings, { code: "credential-access", severity: "hard-block", message: "command accesses a credential, secret, or PUM configuration path", stage: stage.index, path: value });
      }
      if (isNullDevice(value)) continue;
      if (exemptSettingsFile) continue;
      if (value.startsWith("~")) {
        addFinding(findings, { code: "outside-project", severity: "hard-block", message: "home-relative path cannot be resolved safely", stage: stage.index, path: value });
        continue;
      }
      const rootProblem = resolved.additional ? additionalRootProblem(resolved.root, fs) : undefined;
      if (!resolved.inside) {
        if (profile !== "balanced" || classified.mode !== "read") {
          const message = classified.mode === "write"
            ? "write access resolves outside the project and approved roots"
            : classified.mode === "execute"
              ? "execution operand resolves outside the project and approved roots"
              : classified.mode === "location"
                ? "directory change resolves outside the project and approved roots"
                : classified.mode === "unknown"
                  ? "unknown path access resolves outside the project and approved roots"
                  : "path resolves outside the project boundary";
          addFinding(findings, { code: classified.mode === "unknown" ? "unknown-path-access" : "outside-project", severity: "hard-block", message, stage: stage.index, path: value });
        } else if (externalPathUsesLink(resolved.absolute, fs)) {
          addFinding(findings, { code: "escaping-symlink", severity: "hard-block", message: "external read traverses a symlink or junction", stage: stage.index, path: value });
        }
      } else if (rootProblem === "missing") {
        addFinding(findings, { code: "outside-project", severity: "hard-block", message: "additional Check mode path no longer exists", stage: stage.index, path: value });
      } else if (rootProblem === "link") {
        addFinding(findings, { code: "escaping-symlink", severity: "hard-block", message: "additional Check mode path became a symlink or junction", stage: stage.index, path: value });
      } else if (symlinkEscapes(resolved.absolute, resolved.root, fs)) {
        addFinding(findings, { code: "escaping-symlink", severity: "hard-block", message: "path follows a symlink outside the project boundary or cannot be verified", stage: stage.index, path: value });
      }
    }

    if (["cd", "chdir", "set-location"].includes(name)) {
      const targets = pathOperands(effectiveStage);
      const target = targets.length === 1
        ? normalizedAbsolute(targets[0]!, activeCwd, projectCwd, allowedPaths)
        : undefined;
      if ((stage.operatorAfter === ";" || stage.operatorAfter === "newline")
        && stage.index < analysis.stages.length - 1) {
        addFinding(findings, {
          code: "outside-project",
          severity: "hard-block",
          message: "an unconditional directory change before another command cannot be bounded safely",
          stage: stage.index,
          path: targets[0],
        });
      } else if (stage.operatorAfter === "&&" && target?.inside) {
        activeCwd = target.absolute;
      }
    }

    if (depth < 2) {
      const nestedCommands = stage.substitutions.map((item) => item.text);
      const lowerName = name.toLowerCase();
      const commandFlag = lowerName === "cmd" ? argv.findIndex((arg) => arg.toLowerCase() === "/c")
        : lowerName === "powershell" || lowerName === "pwsh" ? argv.findIndex((arg) => ["-c", "-command"].includes(arg.toLowerCase()))
        : SHELL_INTERPRETERS.has(name) ? argv.findIndex((arg) => arg === "-c") : -1;
      if (commandFlag >= 0 && argv[commandFlag + 1]) nestedCommands.push(argv[commandFlag + 1]!);
      for (const nestedCommand of nestedCommands) {
        const nested = inspectHardBlocks(analyzeBashCommand(nestedCommand), activeCwd, fs, profile, depth + 1, projectCwd, allowedPaths, protectedPaths, allowedProtectedFiles);
        for (const access of nested.accesses) accesses.push({ ...access, stage: stage.index });
        for (const finding of nested.findings) {
          addFinding(findings, { ...finding, stage: stage.index, message: `nested command: ${finding.message}` });
        }
      }
    }
  }

  for (let index = 0; index < analysis.stages.length; index++) {
    const stage = analysis.stages[index]!;
    const argv = effectiveArgv(stage.argv);
    const name = commandName(argv[0]);
    const next = analysis.stages[index + 1];
    const nextName = commandName(effectiveArgv(next?.argv ?? [])[0]);
    const substitutionRemote = stage.substitutions.some((item) => /\b(?:curl|wget|fetch|Invoke-WebRequest|iwr)\b/i.test(item.text));
    if ((REMOTE_COMMANDS.has(name) && (stage.operatorAfter === "|" || stage.operatorAfter === "|&") && SHELL_INTERPRETERS.has(nextName))
      || (SHELL_INTERPRETERS.has(name) && argv.some((arg) => /^<(?:curl|wget|fetch)\b/i.test(arg)))
      || ((name === "eval" || SHELL_INTERPRETERS.has(name)) && substitutionRemote)) {
      addFinding(findings, { code: "remote-script-execution", severity: "hard-block", message: "command executes code received from a remote source", stage: stage.index });
    }
  }

  const externalReadStages = new Set(accesses.filter((access) => access.external && access.mode === "read").map((access) => access.stage));
  for (let index = 0; index < analysis.stages.length; index++) {
    const stage = analysis.stages[index]!;
    const argv = effectiveArgv(stage.argv);
    const name = commandName(argv[0]);
    if (!REMOTE_COMMANDS.has(name) && !STDIN_NETWORK_COMMANDS.has(name)) continue;
    const hasUpload = STDIN_NETWORK_COMMANDS.has(name)
      || argv.slice(1).some((arg) => /^(?:-d|-F|-T|--data(?:-binary|-raw|-urlencode)?|--form|--upload-file|--post-file|-InFile|-Body)(?:=|$)/i.test(arg));
    const directlyReadsExternal = accesses.some((access) => access.stage === stage.index && access.external && access.mode === "read");
    const pipedExternalRead = hasUpload && index > 0
      && (analysis.stages[index - 1]?.operatorAfter === "|" || analysis.stages[index - 1]?.operatorAfter === "|&")
      && externalReadStages.has(index - 1);
    if (directlyReadsExternal || pipedExternalRead) {
      addFinding(findings, { code: "external-read-exfiltration", severity: "hard-block", message: "network command can upload data read outside the approved project roots", stage: stage.index });
    }
  }
  return { findings, accesses };
}

function shellCommandFlag(name: string, argv: string[]): number {
  if (name === "cmd") return argv.findIndex((arg) => arg.toLowerCase() === "/c");
  if (name === "powershell" || name === "pwsh") {
    return argv.findIndex((arg) => ["-c", "-command"].includes(arg.toLowerCase()));
  }
  return SHELL_INTERPRETERS.has(name) ? argv.findIndex((arg) => arg === "-c") : -1;
}

function isEncodedDecoder(argv: string[]): boolean {
  const name = commandName(argv[0]);
  const lowerArgs = argv.slice(1).map((arg) => arg.toLowerCase());
  if (name === "base64") return lowerArgs.some((arg) => arg === "-d" || arg === "--decode" || /^-[^-]*d/.test(arg));
  if (name === "openssl") return lowerArgs[0] === "base64" && lowerArgs.some((arg) => arg === "-d" || arg === "-decode");
  if (name === "xxd") return lowerArgs.some((arg) => arg === "-r" || /^-[^-]*r/.test(arg));
  return name === "certutil" && lowerArgs.includes("-decode");
}

function inspectSuspiciousExecution(analysis: BashAnalysis, depth = 0): CheckPolicyFinding[] {
  const findings: CheckPolicyFinding[] = [];
  if (!analysis.complete) return findings;

  for (let index = 0; index < analysis.stages.length; index++) {
    const stage = analysis.stages[index]!;
    const argv = effectiveArgv(stage.argv);
    const name = commandName(argv[0]);
    const lowerArgs = argv.slice(1).map((arg) => arg.toLowerCase());
    const next = analysis.stages[index + 1];
    const nextName = commandName(effectiveArgv(next?.argv ?? [])[0]);
    const commandFlag = shellCommandFlag(name, argv);
    const dynamicCommand = argv[0] !== undefined && /(?:\$\(|`|\$\{|\$[A-Za-z_])/.test(argv[0]);
    const encodedPowerShell = (name === "powershell" || name === "pwsh")
      && lowerArgs.some((arg) => arg === "-encodedcommand" || arg === "-enc");
    const encodedShellText = /\$'[^']*(?:\\x[0-9a-f]{2}|\\[0-7]{3}|\\u[0-9a-f]{4})/i.test(stage.text);
    const pipedIntoShell = (stage.operatorAfter === "|" || stage.operatorAfter === "|&")
      && (SHELL_INTERPRETERS.has(nextName) || nextName === "eval");

    let message: string | undefined;
    if (name === "eval") message = "eval executes dynamically constructed shell text";
    else if (encodedPowerShell) message = `${name} executes an encoded command`;
    else if (dynamicCommand) message = "command name is constructed dynamically";
    else if (encodedShellText) message = "command contains encoded shell text";
    else if (pipedIntoShell) {
      message = isEncodedDecoder(argv)
        ? "command decodes data directly into a shell interpreter"
        : "command pipes generated text directly into a shell interpreter";
    }
    if (message) {
      addFinding(findings, { code: "suspicious-execution", severity: "review", message, stage: stage.index });
    }

    if (depth < 2) {
      const nestedCommands = stage.substitutions.map((item) => item.text);
      if (commandFlag >= 0 && argv[commandFlag + 1]) nestedCommands.push(argv[commandFlag + 1]!);
      for (const nestedCommand of nestedCommands) {
        for (const finding of inspectSuspiciousExecution(analyzeBashCommand(nestedCommand), depth + 1)) {
          addFinding(findings, { ...finding, stage: stage.index, message: `nested command: ${finding.message}` });
        }
      }
    }
  }
  return findings;
}

function safeGitInspection(argv: string[]): boolean {
  const subcommand = argv[1];
  const args = argv.slice(2);
  if (subcommand === "status") return args.every((arg) => new Set(["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-s", "-b"]).has(arg));
  if (subcommand === "diff") return args.every((arg) => new Set(["--check", "--stat", "--cached", "--staged", "--name-only", "--name-status", "--color=never", "HEAD"]).has(arg));
  if (subcommand === "log") return args.every((arg) => new Set(["--oneline", "--decorate", "--graph", "--all", "--color=never"]).has(arg) || /^--max-count=[1-9]\d*$/.test(arg));
  if (subcommand === "show") return args.every((arg) => new Set(["--stat", "--oneline", "--name-only", "--name-status", "--color=never", "HEAD"]).has(arg) || /^[0-9a-f]{4,64}$/i.test(arg));
  if (subcommand === "rev-parse") return args.length > 0 && args.every((arg) => new Set(["HEAD", "--show-toplevel", "--show-prefix", "--is-inside-work-tree", "--is-bare-repository", "--abbrev-ref"]).has(arg));
  if (subcommand === "ls-files") return args.every((arg) => new Set(["--cached", "--deleted", "--modified", "--others", "--ignored", "--stage"]).has(arg));
  if (subcommand === "branch") return args.length === 0 || args.every((arg) => arg === "--show-current" || arg === "--list");
  return false;
}

function isNarrowRead(stage: BashStage): boolean {
  const name = commandName(stage.argv[0]);
  if (!SAFE_READ_COMMANDS.has(name) || stage.mutationIntent.length > 0 || stage.redirections.some((item) => item.operator.includes(">"))) return false;
  if (name === "git") return safeGitInspection(stage.argv);
  if (name === "grep" || name === "rg") return !stage.argv.some((arg) => ["--files-without-match", "--pre", "--pre-glob"].includes(arg));
  return true;
}

function balancedCompleteShellLimits(command: string): Partial<CheckPolicyLimits> {
  return {
    maxCommandChars: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxCommandChars, command.length),
    maxStages: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxStages, command.length + 1),
    maxAnnotations: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxAnnotations, command.length + 1),
    maxTokensPerStage: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxTokensPerStage, command.length + 1),
    maxTokenChars: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxTokenChars, command.length),
  };
}

const NETWORK_COMMANDS = new Set([
  "curl", "wget", "fetch", "invoke-webrequest", "iwr", "invoke-restmethod", "irm",
  "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet",
  "gh", "glab",
]);

function stageNetworkCommand(stage: BashStage): string | undefined {
  const argv = effectiveArgv(stage.argv);
  const name = commandName(argv[0]);
  if (NETWORK_COMMANDS.has(name)) return name;
  const subcommand = (argv[1] ?? "").toLowerCase();
  if (name === "git" && new Set(["clone", "fetch", "pull", "push", "ls-remote"]).has(subcommand)) return `git ${subcommand}`;
  if (name === "npm" && subcommand === "pack") {
    return npmPackCommand(argv)?.packageSpec ? "npm pack" : undefined;
  }
  if (name === "npm" && subcommand === "install") {
    return npmInstallCommand(argv)?.valid ? "npm install" : undefined;
  }
  if (["npm", "pnpm", "yarn"].includes(name)
    && new Set(["add", "audit", "install", "publish", "search", "update", "upgrade", "view", "info"]).has(subcommand)) {
    return `${name} ${subcommand}`;
  }
  if (name === "bun" && new Set(["add", "install", "publish", "update"]).has(subcommand)) return `bun ${subcommand}`;
  if (["pip", "pip3"].includes(name) && new Set(["download", "index", "install", "search"]).has(subcommand)) return `${name} ${subcommand}`;
  if (name === "cargo" && new Set(["install", "login", "owner", "publish", "search"]).has(subcommand)) return `cargo ${subcommand}`;
  if (name === "go" && new Set(["get", "install"]).has(subcommand)) return `go ${subcommand}`;
  return undefined;
}

/** Return deterministic network intent from the same shell analysis used by Check mode. */
export function checkNetworkIntent(analysis: BashAnalysis, depth = 0): CheckNetworkIntent {
  const commands: string[] = [];
  for (const stage of analysis.stages) {
    const direct = stageNetworkCommand(stage);
    if (direct) commands.push(direct);
    if (depth >= 2) continue;
    const argv = effectiveArgv(stage.argv);
    const nested = stage.substitutions.map((substitution) => substitution.text);
    const flag = shellCommandFlag(commandName(argv[0]), argv);
    if (flag >= 0 && argv[flag + 1]) nested.push(argv[flag + 1]!);
    for (const command of nested) {
      commands.push(...checkNetworkIntent(analyzeBashCommand(command), depth + 1).commands);
    }
  }
  const unique = [...new Set(commands)].sort();
  return { access: unique.length > 0 ? "host" : "none", commands: unique };
}

/** Analyze a bash tool call and return a deterministic profile decision. */
export function analyzeCheckPolicy(options: AnalyzeCheckPolicyOptions): CheckPolicyResult {
  const profile = options.profile ?? "balanced";
  const exactCommand = options.command;
  const limits = options.limits ?? (profile === "balanced" ? balancedCompleteShellLimits(options.command) : undefined);
  const analysis = analyzeBashCommand(options.command, limits);
  const normalized = normalizeWindowsContext(options.cwd, options.cwd, options.allowedPaths, options.protectedPaths);
  const { findings, accesses } = inspectHardBlocks(
    analysis,
    normalized.cwd,
    options.fileSystem ?? nodeFileSystem,
    profile,
    0,
    normalized.projectCwd,
    normalized.allowedPaths,
    normalized.protectedPaths,
    options.allowedProtectedFiles,
  );
  const network = checkNetworkIntent(analysis);
  if (findings.some((item) => item.severity === "hard-block")) {
    return { exactCommand, profile, decision: "block", reason: findings[0]!.message, findings, accesses, analysis, network };
  }

  if (profile === "ask") {
    addFinding(findings, { code: "unrecognized-command", severity: "review", message: "ask profile requires review for every command" });
    return { exactCommand, profile, decision: "ask", reason: findings[0]!.message, findings, accesses, analysis, network };
  }

  for (const finding of inspectSuspiciousExecution(analysis)) addFinding(findings, finding);
  if (profile === "balanced") {
    if (findings.length) return { exactCommand, profile, decision: "block", reason: findings[0]!.message, findings, accesses, analysis, network };
    return {
      exactCommand,
      profile,
      decision: "allow",
      reason: accesses.some((access) => access.external)
        ? "complete command uses only deterministically classified external reads"
        : "complete project-local command passed deterministic hard rules",
      findings: [],
      accesses,
      analysis,
      network,
    };
  }

  const hasComplexShell = analysis.stages.length !== 1 || analysis.substitutions.length > 0 || analysis.operators.some((item) => item.operator === "&");
  if (hasComplexShell) addFinding(findings, { code: "shell-complexity", severity: "review", message: "compound commands, substitutions, and background execution require review" });
  if (analysis.mutationIntent.possible) addFinding(findings, { code: "mutation", severity: "review", message: "command can mutate project state" });

  const allNarrowReads = !hasComplexShell && analysis.stages.length === 1 && analysis.stages.every(isNarrowRead);
  if (allNarrowReads) {
    return { exactCommand, profile, decision: "allow", reason: "narrow project-local inspection", findings: [], accesses, analysis, network };
  }

  if (!findings.length) addFinding(findings, { code: "unrecognized-command", severity: "review", message: "command is not a rigorously narrow built-in policy case" });
  return { exactCommand, profile, decision: "ask", reason: findings[0]!.message, findings, accesses, analysis, network };
}

/** Analyze direct executable arguments without converting the arguments to shell text. */
export function analyzeExecutablePolicy(options: AnalyzeExecutablePolicyOptions): CheckPolicyResult {
  const profile = options.profile ?? "balanced";
  const longestProcessToken = options.args.reduce((maximum, argument) => Math.max(maximum, argument.length), options.executable.length);
  const completeProcessLimits = profile === "balanced" && options.limits === undefined ? {
    maxTokenChars: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxTokenChars, longestProcessToken),
    maxTokensPerStage: Math.max(DEFAULT_CHECK_POLICY_LIMITS.maxTokensPerStage, options.args.length + 1),
  } : undefined;
  const limits = mergeLimits(options.limits ?? completeProcessLimits);
  const errors: string[] = [];
  let truncated = false;
  if (!options.executable) errors.push("executable is empty");
  if (options.executable.length > limits.maxTokenChars) {
    errors.push(`executable exceeds ${limits.maxTokenChars} characters`);
    truncated = true;
  }
  if (options.args.length + 1 > limits.maxTokensPerStage) {
    errors.push(`args exceeds ${limits.maxTokensPerStage - 1} arguments`);
    truncated = true;
  }
  if (options.args.some((argument) => argument.length > limits.maxTokenChars)) {
    errors.push(`argument exceeds ${limits.maxTokenChars} characters`);
    truncated = true;
  }

  const argv = [options.executable, ...options.args];
  const exactCommand = JSON.stringify(argv);
  const stage: BashStage = {
    index: 0,
    start: 0,
    end: 0,
    text: exactCommand,
    pipeline: 0,
    argv,
    envAssignments: {},
    redirections: [],
    substitutions: [],
    mutationIntent: mutationIndicators(argv, []),
  };
  const analysis: BashAnalysis = {
    complete: errors.length === 0,
    syntaxBalanced: errors.length === 0,
    truncated,
    operators: [],
    stages: errors.length === 0 ? [stage] : [],
    redirections: [],
    substitutions: [],
    mutationIntent: { possible: stage.mutationIntent.length > 0, indicators: stage.mutationIntent },
    errors,
  };
  const projectCwd = options.projectCwd ?? options.cwd;
  const fs = options.fileSystem ?? nodeFileSystem;
  const normalized = normalizeWindowsContext(options.cwd, projectCwd, options.allowedPaths, options.protectedPaths);
  const { findings, accesses } = inspectHardBlocks(
    analysis,
    normalized.cwd,
    fs,
    profile,
    0,
    normalized.projectCwd,
    normalized.allowedPaths,
    normalized.protectedPaths,
    options.allowedProtectedFiles,
  );
  const network = checkNetworkIntent(analysis);
  const executionDirectory = normalizedAbsolute(normalized.cwd, normalized.projectCwd, normalized.projectCwd, normalized.allowedPaths);
  const executionRootProblem = executionDirectory.additional
    ? additionalRootProblem(executionDirectory.root, fs)
    : undefined;
  if (!executionDirectory.inside) {
    addFinding(findings, {
      code: "outside-project",
      severity: "hard-block",
      message: "execution cwd resolves outside the project boundary",
      path: normalized.cwd,
    });
  } else if (executionRootProblem === "missing") {
    addFinding(findings, {
      code: "outside-project",
      severity: "hard-block",
      message: "additional Check mode path no longer exists",
      path: normalized.cwd,
    });
  } else if (executionRootProblem === "link") {
    addFinding(findings, {
      code: "escaping-symlink",
      severity: "hard-block",
      message: "additional Check mode path became a symlink or junction",
      path: normalized.cwd,
    });
  } else if (symlinkEscapes(executionDirectory.absolute, executionDirectory.root, fs)) {
    addFinding(findings, {
      code: "escaping-symlink",
      severity: "hard-block",
      message: "execution cwd follows a symlink outside the project boundary or cannot be verified",
      path: normalized.cwd,
    });
  }
  if (findings.some((item) => item.severity === "hard-block")) {
    return { exactCommand, profile, decision: "block", reason: findings[0]!.message, findings, accesses, analysis, network };
  }
  if (profile === "ask") {
    addFinding(findings, { code: "unrecognized-command", severity: "review", message: "ask profile requires review for every command" });
    return { exactCommand, profile, decision: "ask", reason: findings[0]!.message, findings, accesses, analysis, network };
  }
  for (const finding of inspectSuspiciousExecution(analysis)) addFinding(findings, finding);
  if (profile === "balanced") {
    if (findings.length) return { exactCommand, profile, decision: "block", reason: findings[0]!.message, findings, accesses, analysis, network };
    return {
      exactCommand,
      profile,
      decision: "allow",
      reason: accesses.some((access) => access.external)
        ? "complete process uses only deterministically classified external reads"
        : "complete project-local process passed deterministic hard rules",
      findings: [],
      accesses,
      analysis,
      network,
    };
  }
  if (analysis.mutationIntent.possible) {
    addFinding(findings, { code: "mutation", severity: "review", message: "command can mutate project state" });
  }
  const narrowRead = isNarrowRead(stage);
  if (narrowRead) {
    return {
      exactCommand,
      profile,
      decision: "allow",
      reason: "narrow project-local inspection",
      findings: [],
      accesses,
      analysis,
      network,
    };
  }
  if (!findings.length) {
    addFinding(findings, { code: "unrecognized-command", severity: "review", message: "command is not a rigorously narrow built-in policy case" });
  }
  return { exactCommand, profile, decision: "ask", reason: findings[0]!.message, findings, accesses, analysis, network };
}

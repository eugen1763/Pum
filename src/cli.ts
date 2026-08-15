export interface PackageMetadata {
  name: string;
  version: string;
  description: string;
}

export type OuterSandboxMode = "write" | "read";

export interface OuterSandboxOptions {
  mode: OuterSandboxMode;
  mounts: string[];
}

export interface WorktreeOptions {
  /**
   * Repository directory the worktree branches from. Undefined means the
   * current directory; the parser stays pure, so the caller resolves it.
   */
  directory?: string;
}

export interface StartupOptions {
  login: boolean;
  resume: boolean;
  outerSandbox?: OuterSandboxOptions;
  /** Create an auto-named worktree and start PUM there, for `pum worktree`. */
  worktree?: WorktreeOptions;
  /** Non-interactive one-shot prompt for `pum -p "<text>"`. */
  prompt?: string;
  /** Optional benchmark statistics output for headless mode. */
  statsFile?: string;
  /** Permit replacement of an existing statistics output file. */
  overrideStatsFile: boolean;
}

export type CliResult =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "sandboxSetup" }
  | { kind: "start"; options: StartupOptions }
  | { kind: "error"; message: string };

export async function readPackageMetadata(): Promise<PackageMetadata> {
  const packageUrl = new URL("../package.json", import.meta.url);
  const value = await Bun.file(packageUrl).json() as Partial<PackageMetadata>;
  if (!value.name || !value.version || !value.description) {
    throw new Error("package.json is missing CLI metadata.");
  }
  return { name: value.name, version: value.version, description: value.description };
}

const SETUP_ARGUMENTS_ERROR = "Command 'ss' does not accept arguments or options.";
const WORKTREE_OPERAND_ERROR = "The worktree command accepts one directory";

export function parseCliArgs(args: string[]): CliResult {
  let login = false;
  let resume = false;
  let setup = false;
  let prompt: string | undefined;
  let statsFile: string | undefined;
  let overrideStatsFile = false;
  let help = false;
  let version = false;
  let endOfOptions = false;
  let outerSandbox: OuterSandboxOptions | undefined;
  let worktree: WorktreeOptions | undefined;
  // Help and version win over a bad argument, as they do in most CLIs, so the
  // loop records the first error and keeps reading instead of returning at once.
  let error: string | undefined;
  const fail = (message: string): void => { if (error === undefined) error = message; };
  const addWorktreeDirectory = (target: WorktreeOptions, value: string): void => {
    if (target.directory === undefined) target.directory = value;
    else fail(WORKTREE_OPERAND_ERROR);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!endOfOptions) {
      if (arg === "--help" || arg === "-h") { help = true; continue; }
      if (arg === "--version" || arg === "-v") { version = true; continue; }
    }
    if (setup) { fail(SETUP_ARGUMENTS_ERROR); continue; }
    if (endOfOptions) {
      // Everything after `--` is an operand, so a mount directory may start
      // with `-` and a directory named `login` stays a directory.
      if (outerSandbox) outerSandbox.mounts.push(arg);
      else if (worktree) addWorktreeDirectory(worktree, arg);
      else fail(`Unknown command: ${arg}`);
      continue;
    }
    if (arg === "--") { endOfOptions = true; continue; }

    if (arg === "--resume" || arg === "-r") resume = true;
    else if (arg === "--prompt" || arg === "-p") {
      const value = args[index + 1];
      if (value === undefined) { fail(`Missing prompt text after ${arg}`); continue; }
      index += 1;
      if (prompt !== undefined) { fail("Only one --prompt is supported"); continue; }
      prompt = value;
    } else if (arg === "--statsFile" || arg === "--stats-file") {
      const value = args[index + 1];
      if (value === undefined) { fail(`Missing file path after ${arg}`); continue; }
      index += 1;
      if (statsFile !== undefined) { fail("Only one --statsFile is supported"); continue; }
      statsFile = value;
    } else if (arg === "--override") overrideStatsFile = true;
    else if (arg.startsWith("-")) fail(`Unknown option: ${arg}`);
    else if (arg === "ss" && !outerSandbox && !worktree) {
      if (login || resume || prompt !== undefined || statsFile !== undefined || overrideStatsFile) {
        fail(SETUP_ARGUMENTS_ERROR);
        continue;
      }
      setup = true;
    } else if (arg === "login") {
      // The grammar is `pum s [login] [directory ...]`. A trailing `login` is a
      // mistake, and silently mounting it fails later with a confusing message.
      if (outerSandbox?.mounts.length) fail("'login' must come before mount directories");
      else if (worktree?.directory !== undefined) fail("'login' must come before the worktree directory");
      else login = true;
    } else if (!outerSandbox && !worktree && (arg === "s" || arg === "sr")) {
      outerSandbox = { mode: arg === "s" ? "write" : "read", mounts: [] };
    } else if (!outerSandbox && !worktree && (arg === "worktree" || arg === "w")) {
      worktree = {};
    } else if (outerSandbox) outerSandbox.mounts.push(arg);
    else if (worktree) addWorktreeDirectory(worktree, arg);
    else fail(`Unknown command: ${arg}`);
  }

  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  if (error !== undefined) return { kind: "error", message: error };
  if (setup) return { kind: "sandboxSetup" };
  if (login && prompt !== undefined) return { kind: "error", message: "Cannot combine login with --prompt" };
  if (outerSandbox && prompt !== undefined) {
    return { kind: "error", message: "Cannot combine an outer sandbox command with --prompt" };
  }
  if (worktree && prompt !== undefined) {
    return { kind: "error", message: "Cannot combine the worktree command with --prompt" };
  }
  if (worktree && resume) {
    // A worktree is created fresh, so it has no earlier session to resume.
    return { kind: "error", message: "Cannot combine the worktree command with --resume" };
  }
  if (prompt !== undefined && prompt.trim() === "") {
    return { kind: "error", message: "The prompt text is empty" };
  }
  if (statsFile !== undefined && statsFile.trim() === "") {
    return { kind: "error", message: "The stats file path is empty" };
  }
  if (statsFile !== undefined && prompt === undefined) {
    return { kind: "error", message: "--statsFile requires --prompt" };
  }
  if (overrideStatsFile && statsFile === undefined) {
    return { kind: "error", message: "--override requires --statsFile" };
  }

  return {
    kind: "start",
    options: {
      login,
      resume,
      overrideStatsFile,
      ...(outerSandbox ? { outerSandbox } : {}),
      ...(worktree ? { worktree } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(statsFile !== undefined ? { statsFile } : {}),
    },
  };
}

export function formatCliError(message: string): string {
  return `pum: ${message}\nRun 'pum --help' for usage.\n`;
}

export function helpText(metadata: PackageMetadata): string {
  return `PUM - ${metadata.description}

Usage:
  pum [options]
  pum login [options]
  pum worktree [login] [options] [directory]
  pum w [login] [options] [directory]
  pum s [login] [options] [directory[:ro|:rw] ...]
  pum sr [login] [options] [directory[:ro|:rw] ...]
  pum ss

Options:
  -h, --help           Show this help and exit.
  -v, --version        Print the ${metadata.name} package version and exit.
  -r, --resume         Resume the latest session for the current directory.
  -p, --prompt <text>  Run one prompt without the TUI, print the answer, and exit.
  --statsFile <path>   Write a versioned JSON statistics artifact after a headless run.
  --override           Permit --statsFile to replace an existing file.
  --                   End the options. Later arguments are directories.

Commands:
  login            Open PUM with the provider login panel.
  worktree         Create an auto-named Git worktree and start PUM in it.
  w                Short name for worktree.
  s                Start PUM in a writable outer sandbox.
  sr               Start PUM with the current directory read-only.
  ss               Check the outer sandbox runtime and show setup requirements.

Sandbox mounts:
  Plain extra directories use the command default. Add :ro or :rw to select
  explicit access. PUM validates and canonicalizes every directory before start.
  "login" must come before the directories. Put -- before a directory whose
  name starts with a dash or is called "login".

Worktrees:
  "pum worktree" and "pum w" create an auto-named worktree of the repository
  that holds the given directory and start PUM in that worktree. Without a
  directory PUM uses the current one. Put -- before a directory whose name
  starts with a dash or is called "login". These commands take no -p and no -r:
  the new worktree runs the TUI and has no earlier session.

Non-interactive mode:
  "pum -p" runs the coding tools (read, write, edit, apply_patch, bash) with
  the configured Check mode. Interactive tools stay off. Combine with -r to
  continue the latest session for the current directory. --statsFile creates
  missing parent directories and fails before startup when the file exists,
  unless --override is present. --stats-file is also accepted.

Start PUM in a project directory with "pum". If no provider is available,
PUM opens the login panel automatically. Inside PUM, enter ? on an empty prompt
to show all controls. Common controls include Ctrl+P for settings, Ctrl+H for
session history, Ctrl+T for triggers, and Ctrl+C twice on an empty prompt to quit.

Configuration:
  PUM stores credentials, settings, and sessions in its own configuration
  directory. Set PUM_DIR to override the complete directory. Defaults are
  $XDG_CONFIG_HOME/pum or ~/.config/pum on Linux, ~/Library/Application Support/pum
  on macOS, and %LOCALAPPDATA%\\pum on Windows.

Package: ${metadata.name}
Executable: pum
`;
}

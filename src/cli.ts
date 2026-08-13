export interface PackageMetadata {
  name: string;
  version: string;
  description: string;
}

export interface StartupOptions {
  login: boolean;
  resume: boolean;
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

export function parseCliArgs(args: string[]): CliResult {
  // Single pass so option values are consumed before they can be mistaken for flags.
  let login = false;
  let resume = false;
  let prompt: string | undefined;
  let statsFile: string | undefined;
  let overrideStatsFile = false;
  let help = false;
  let version = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (arg === "login") login = true;
    else if (arg === "--resume" || arg === "-r") resume = true;
    else if (arg === "--prompt" || arg === "-p") {
      const value = args[index + 1];
      if (value === undefined) return { kind: "error", message: `Missing prompt text after ${arg}` };
      if (prompt !== undefined) return { kind: "error", message: "Only one --prompt is supported" };
      prompt = value;
      index += 1;
    } else if (arg === "--statsFile" || arg === "--stats-file") {
      const value = args[index + 1];
      if (value === undefined) return { kind: "error", message: `Missing file path after ${arg}` };
      if (statsFile !== undefined) return { kind: "error", message: "Only one --statsFile is supported" };
      statsFile = value;
      index += 1;
    } else if (arg === "--override") overrideStatsFile = true;
    else if (arg.startsWith("-")) return { kind: "error", message: `Unknown option: ${arg}` };
    else return { kind: "error", message: `Unknown command: ${arg}` };
  }
  // Help and version short-circuit only when given as their own flags.
  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  if (login && prompt !== undefined) {
    return { kind: "error", message: "Cannot combine login with --prompt" };
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

Options:
  -h, --help           Show this help and exit.
  -v, --version        Print the ${metadata.name} package version and exit.
  -r, --resume         Resume the latest session for the current directory.
  -p, --prompt <text>  Run one prompt without the TUI, print the answer, and exit.
  --statsFile <path>   Write a versioned JSON statistics artifact after a headless run.
  --override           Permit --statsFile to replace an existing file.

Commands:
  login            Open PUM with the provider login panel.

Non-interactive mode:
  "pum -p" runs the coding tools (read, write, edit, apply_patch, bash) with
  the configured Check mode. Interactive tools stay off. Ask-mode approvals
  deny automatically because no approval popup exists. Combine with -r to
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

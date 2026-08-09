export interface PackageMetadata {
  name: string;
  version: string;
  description: string;
}

export interface StartupOptions {
  login: boolean;
  resume: boolean;
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
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args.includes("--version") || args.includes("-v")) return { kind: "version" };

  let login = false;
  let resume = false;
  for (const arg of args) {
    if (arg === "login") login = true;
    else if (arg === "--resume" || arg === "-r") resume = true;
    else if (arg.startsWith("-")) return { kind: "error", message: `Unknown option: ${arg}` };
    else return { kind: "error", message: `Unknown command: ${arg}` };
  }
  return { kind: "start", options: { login, resume } };
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
  -h, --help       Show this help and exit.
  -v, --version    Print the ${metadata.name} package version and exit.
  -r, --resume     Resume the latest session for the current directory.

Commands:
  login            Open PUM with the provider login panel.

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

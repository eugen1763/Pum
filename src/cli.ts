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

export interface StartupOptions {
  login: boolean;
  resume: boolean;
  outerSandbox?: OuterSandboxOptions;
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

export function parseCliArgs(args: string[]): CliResult {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args.includes("--version") || args.includes("-v")) return { kind: "version" };

  let login = false;
  let resume = false;
  let setup = false;
  let outerSandbox: OuterSandboxOptions | undefined;
  for (const arg of args) {
    if (setup) {
      return { kind: "error", message: "Command 'ss' does not accept arguments or options." };
    }
    if (arg === "--resume" || arg === "-r") {
      resume = true;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `Unknown option: ${arg}` };
    if (arg === "ss" && !outerSandbox) {
      if (login || resume) {
        return { kind: "error", message: "Command 'ss' does not accept arguments or options." };
      }
      setup = true;
      continue;
    }
    if (arg === "login" && !outerSandbox?.mounts.length) {
      login = true;
      continue;
    }
    if (!outerSandbox && (arg === "s" || arg === "sr")) {
      outerSandbox = { mode: arg === "s" ? "write" : "read", mounts: [] };
      continue;
    }
    if (outerSandbox) {
      outerSandbox.mounts.push(arg);
      continue;
    }
    return { kind: "error", message: `Unknown command: ${arg}` };
  }
  if (setup) return { kind: "sandboxSetup" };
  return {
    kind: "start",
    options: { login, resume, ...(outerSandbox ? { outerSandbox } : {}) },
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
  pum s [login] [options] [directory[:ro|:rw] ...]
  pum sr [login] [options] [directory[:ro|:rw] ...]
  pum ss

Options:
  -h, --help       Show this help and exit.
  -v, --version    Print the ${metadata.name} package version and exit.
  -r, --resume     Resume the latest session for the current directory.

Commands:
  login            Open PUM with the provider login panel.
  s                Start PUM in a writable outer sandbox.
  sr               Start PUM with the current directory read-only.
  ss               Prepare or update the outer sandbox runtime.

Sandbox mounts:
  Plain extra directories use the command default. Add :ro or :rw to select
  explicit access. PUM validates and canonicalizes every directory before start.

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

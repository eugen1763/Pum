import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AGENT_DIR } from "./config";
import { isCredentialSensitivePath } from "./check-policy";
import {
  checkPathsForProject,
  MAX_CHECK_PATHS_PER_PROJECT,
  type PumSettings,
  withCheckPathsForProject,
} from "./settings";

export type CheckPathCommand =
  | { action: "list" }
  | { action: "clear" }
  | { action: "add" | "remove"; path: string };

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === "\"" || first === "'") && trimmed.at(-1) === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseCheckPathCommand(input: string): CheckPathCommand | undefined {
  const match = /^\/check-path(?:\s+(.*))?$/s.exec(input.trim());
  if (!match) return undefined;
  const argumentsText = match[1]?.trim() ?? "";
  if (!argumentsText || argumentsText === "list") return { action: "list" };
  if (argumentsText === "clear") return { action: "clear" };
  const action = /^(add|remove)\s+([\s\S]+)$/.exec(argumentsText);
  if (!action) throw new Error("usage: /check-path [list|add <directory>|remove <directory>|clear]");
  const path = unquote(action[2]!);
  if (!path || path.includes("\0")) throw new Error("Check path is invalid");
  return { action: action[1] as "add" | "remove", path };
}

function insideOrSame(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalDirectory(input: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, input);
  const canonical = await realpath(absolute);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) throw new Error(`Check path is not a directory: ${input}`);
  if (dirname(canonical) === canonical) throw new Error("Check path cannot be a filesystem root");
  if (isCredentialSensitivePath(canonical)) {
    throw new Error("Check path cannot be a credential-sensitive directory");
  }
  const [agentDirectory, homeDirectory] = await Promise.all([
    realpath(AGENT_DIR).catch(() => resolve(AGENT_DIR)),
    realpath(homedir()).catch(() => resolve(homedir())),
  ]);
  if (insideOrSame(canonical, agentDirectory) || insideOrSame(agentDirectory, canonical)) {
    throw new Error("Check path cannot contain or enter PUM's configuration directory");
  }
  if (insideOrSame(canonical, homeDirectory)) {
    throw new Error("Check path cannot contain the home directory");
  }
  return canonical;
}

async function removalIdentity(input: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, input);
  return realpath(absolute).catch(() => absolute);
}

export async function applyCheckPathCommand(
  settings: PumSettings,
  cwd: string,
  command: CheckPathCommand,
): Promise<{ settings: PumSettings; paths: string[]; message: string }> {
  const paths = checkPathsForProject(settings, cwd);
  if (command.action === "list") {
    return {
      settings,
      paths,
      message: paths.length > 0
        ? `Check mode additional paths:\n${paths.map((path) => `- ${path}`).join("\n")}`
        : "Check mode has no additional paths for this project",
    };
  }
  if (command.action === "clear") {
    const next = withCheckPathsForProject(settings, cwd, []);
    return {
      settings: next,
      paths: [],
      message: paths.length > 0
        ? `cleared ${paths.length} Check mode additional path${paths.length === 1 ? "" : "s"}`
        : "Check mode has no additional paths to clear",
    };
  }

  const canonical = command.action === "add"
    ? await canonicalDirectory(command.path, cwd)
    : await removalIdentity(command.path, cwd);
  const project = await realpath(cwd);
  if (command.action === "add") {
    if (canonical === project || insideOrSame(project, canonical)) {
      throw new Error("The directory is already inside the project boundary");
    }
    if (paths.includes(canonical)) throw new Error(`Check path is already allowed: ${canonical}`);
    if (paths.length >= MAX_CHECK_PATHS_PER_PROJECT) {
      throw new Error(`Check mode allows at most ${MAX_CHECK_PATHS_PER_PROJECT} additional paths per project`);
    }
    const nextPaths = [...paths, canonical];
    return {
      settings: withCheckPathsForProject(settings, cwd, nextPaths),
      paths: nextPaths,
      message: `allowed Check mode path: ${canonical}`,
    };
  }

  const index = paths.indexOf(canonical);
  if (index < 0) throw new Error(`Check path is not configured: ${canonical}`);
  const nextPaths = paths.filter((_path, candidate) => candidate !== index);
  return {
    settings: withCheckPathsForProject(settings, cwd, nextPaths),
    paths: nextPaths,
    message: `removed Check mode path: ${canonical}`,
  };
}

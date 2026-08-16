import { posix, win32 } from "node:path";
import { webSearchArgument } from "./web-search";
import type { ToolResultPreview } from "./tool-preview";

export type ToolCall = {
  id: string;
  name: string;
  /** The one argument worth showing for this tool. */
  arg: string;
  state: "running" | "ok" | "error" | "rejected";
  /** "+3 −1" for edits, or an error note. */
  detail?: string;
  /** Cumulative live output retained until the Bash output display period ends. */
  output?: string;
  /** Start time used to delay live Bash output without delaying the tool row. */
  startedAt?: number;
  /** Nonzero Bash process exit code, when the result provides one. */
  exitCode?: number;
  /** Canonical model-authored input retained for display-mode regeneration. */
  input?: unknown;
  /** Canonical tool result retained for display-mode regeneration. */
  result?: unknown;
  /** True when the retained result represents a failed tool execution. */
  isError?: boolean;
  /** Display-only structured result data used by detailed transcript mode. */
  preview?: ToolResultPreview;
};

/** Extract the cumulative text payload from a Bash progress result. */
export function bashOutput(result: any): string | undefined {
  if (!Array.isArray(result?.content)) return undefined;
  const text = result.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
  return text || undefined;
}

export type BashOutputWindow = {
  hidden: number;
  lines: string[];
};

/** Keep the newest logical lines without counting a final newline as an empty line. */
export function bashOutputWindow(output: string, limit = 4): BashOutputWindow {
  const lines = output.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const visible = Math.max(0, limit);
  return {
    hidden: Math.max(0, lines.length - visible),
    lines: visible ? lines.slice(-visible) : [],
  };
}

export type BashResultDisplay = {
  exitCode?: number;
};

/** Extract a nonzero process exit code from the Bash result. */
export function bashResultDisplay(result: any): BashResultDisplay {
  const text = bashOutput(result);
  const explicitExitCode = typeof result?.details?.exitCode === "number"
    && Number.isInteger(result.details.exitCode)
    ? result.details.exitCode
    : undefined;
  if (!text) return explicitExitCode === undefined ? {} : { exitCode: explicitExitCode };

  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let exitCode = explicitExitCode;
  for (const line of lines) {
    const match = line.match(/Command exited with code (-?\d+)/i);
    if (match) exitCode = Number(match[1]);
  }
  return exitCode === undefined ? {} : { exitCode };
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Render project-local paths with `/`, while preserving supplied external path syntax. */
export function displayToolPath(path: string, cwd: string): string {
  const windowsCwd = isWindowsAbsolute(cwd);
  if ((isWindowsAbsolute(path) && !windowsCwd) || (posix.isAbsolute(path) && windowsCwd)) return path;

  const flavor = windowsCwd ? win32 : posix;
  const root = flavor.resolve(cwd);
  const absolute = flavor.resolve(root, path);
  const relative = flavor.relative(root, absolute);
  const outside = relative === ".." || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative);
  if (!relative || outside) return path;
  return windowsCwd ? relative.replaceAll("\\", "/") : relative;
}

/** Tool args are typed `any`, so every access here is defensive. */
export function toolArg(name: string, args: any, cwd: string): string {
  if (!args || typeof args !== "object") return "";

  if (name === "bash" && typeof args.command === "string") {
    return args.command.split("\n")[0]!.trim();
  }
  if (name === "web_search") return webSearchArgument(args);
  if (name === "read" && typeof args.path === "string") {
    const path = displayToolPath(args.path, cwd);
    const range: string[] = [];
    if (typeof args.offset === "number" && Number.isFinite(args.offset)) {
      range.push(`offset=${args.offset}`);
    }
    if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
      range.push(`limit=${args.limit}`);
    }
    return [path, ...range].join(" · ");
  }
  if ((name === "apply_patch" || name === "apply_path") && typeof args.patch === "string") {
    const paths: string[] = [];
    let updateIndex = -1;
    for (const line of args.patch.replace(/\r\n/g, "\n").split("\n")) {
      const file = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
      if (file) {
        paths.push(file[2]!.trim().replaceAll("\\", "/"));
        updateIndex = file[1] === "Update" ? paths.length - 1 : -1;
        continue;
      }
      const move = line.match(/^\*\*\* Move to: (.+)$/);
      if (move && updateIndex >= 0) {
        paths[updateIndex] = `${paths[updateIndex]} → ${move[1]!.trim().replaceAll("\\", "/")}`;
      }
    }
    if (paths.length === 1) return paths[0]!;
    if (paths.length > 1) return `${paths.length} files · ${paths[0]}`;
  }
  if (name === "spawn_subagent" && typeof args.task === "string") {
    const task = typeof args.name === "string" ? `${args.name} · ${args.task}` : args.task;
    return args.readonly === true ? `readonly · ${task}` : task;
  }
  if (name === "message_agent" && typeof args.target === "string") {
    return typeof args.message === "string" ? `${args.target} · ${args.message}` : args.target;
  }
  if (name === "create_trigger" && typeof args.name === "string") {
    return typeof args.executable === "string" ? `${args.name} · ${args.executable}` : args.name;
  }
  if (["inspect_trigger", "pause_trigger", "resume_trigger", "cancel_trigger"].includes(name)
    && typeof args.id === "string") return args.id;
  if (name === "invoke_trigger" && typeof args.id === "string") {
    return args.id;
  }
  if (name === "stop_subagent" && typeof args.target === "string") return args.target;
  if (name === "finish_subagent" && typeof args.summary === "string") return args.summary;
  if (name === "worktree" && typeof args.action === "string") {
    // start carries a directory rather than a target or a name.
    const target = args.target ?? args.name ?? (args.action === "start" ? args.directory : undefined);
    return target ? `${args.action} ${target}` : args.action;
  }
  if (name.startsWith("message_cache_")) {
    const action = name.slice("message_cache_".length);
    if (Array.isArray(args.ids)) return `${action} · ${args.ids.length} id${args.ids.length === 1 ? "" : "s"}`;
    if (typeof args.id === "string") return `${action} · ${args.id}`;
    return action;
  }
  if (name.startsWith("todo_")) {
    // The id alone is opaque, so pair it with the text when the call carries one.
    const parts = [args?.id, args?.text, args?.status]
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.join(" · ").split("\n")[0] ?? "";
  }
  if (name === "enable_tools" && Array.isArray(args.groups)) {
    return args.groups.filter((group: unknown): group is string => typeof group === "string").join(", ");
  }
  if (name === "questionnaire" && Array.isArray(args.questions)) {
    const count = args.questions.length;
    const first = args.questions[0];
    const label = typeof first?.label === "string"
      ? first.label
      : typeof first?.prompt === "string"
        ? first.prompt
        : "";
    return label ? `${count} question${count === 1 ? "" : "s"} · ${label}` : `${count} questions`;
  }
  if (typeof args.path === "string") {
    return displayToolPath(args.path, cwd);
  }
  const first = Object.values(args).find((v) => typeof v === "string");
  return typeof first === "string" ? first.split("\n")[0]! : "";
}

/** Count changed lines from a tool result's unified patch details. */
export function editCounts(result: any): string | undefined {
  const patch = result?.details?.patch;
  if (typeof patch !== "string") return undefined;

  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  if (!added && !removed) return undefined;
  return `+${added} −${removed}`;
}

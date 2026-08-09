import { relative } from "node:path";

export type ToolCall = {
  id: string;
  name: string;
  /** The one argument worth showing for this tool. */
  arg: string;
  state: "running" | "ok" | "error" | "rejected";
  /** "+3 −1" for edits, or an error note. */
  detail?: string;
};

/** Tool args are typed `any`, so every access here is defensive. */
export function toolArg(name: string, args: any, cwd: string): string {
  if (!args || typeof args !== "object") return "";

  if (name === "bash" && typeof args.command === "string") {
    return args.command.split("\n")[0]!.trim();
  }
  if (name === "apply_patch" && typeof args.patch === "string") {
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
    return typeof args.name === "string" ? `${args.name} · ${args.task}` : args.task;
  }
  if (name === "message_agent" && typeof args.target === "string") {
    return typeof args.message === "string" ? `${args.target} · ${args.message}` : args.target;
  }
  if (name === "stop_subagent" && typeof args.target === "string") return args.target;
  if (name === "finish_subagent" && typeof args.summary === "string") return args.summary;
  if (name === "worktree" && typeof args.action === "string") {
    const target = args.target ?? args.name;
    return target ? `${args.action} ${target}` : args.action;
  }
  if (typeof args.path === "string") {
    const rel = relative(cwd, args.path);
    return rel && !rel.startsWith("..") ? rel : args.path;
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

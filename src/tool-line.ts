import { relative } from "node:path";

export type ToolCall = {
  id: string;
  name: string;
  /** The one argument worth showing for this tool. */
  arg: string;
  state: "running" | "ok" | "error";
  /** "+3 −1" for edits, or an error note. */
  detail?: string;
};

const MAX_ARG = 60;

const truncate = (s: string) => (s.length > MAX_ARG ? `${s.slice(0, MAX_ARG - 1)}…` : s);

/** Tool args are typed `any`, so every access here is defensive. */
export function toolArg(name: string, args: any, cwd: string): string {
  if (!args || typeof args !== "object") return "";

  if (name === "bash" && typeof args.command === "string") {
    return truncate(args.command.split("\n")[0]!.trim());
  }
  if (typeof args.path === "string") {
    const rel = relative(cwd, args.path);
    return truncate(rel && !rel.startsWith("..") ? rel : args.path);
  }
  const first = Object.values(args).find((v) => typeof v === "string");
  return typeof first === "string" ? truncate(first.split("\n")[0]!) : "";
}

/**
 * Count changed lines from the edit tool's unified patch (EditToolDetails.patch),
 * skipping the `+++`/`---` file headers.
 */
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

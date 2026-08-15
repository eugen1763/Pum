import type { ToolCall } from "./tool-line";
import type { SubagentManager } from "./subagents/manager";

/** Words `/worktree` reserves, so they can never be read as a worktree name. */
export const WORKTREE_ACTIONS = ["start", "return"] as const;
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

export type WorktreeCommand =
  | { kind: "create"; name?: string }
  | { kind: "start"; directory?: string }
  | { kind: "return" }
  | { kind: "error"; message: string };

const USAGE = "/worktree [name] creates one. /worktree start [directory] moves this session into a "
  + "fresh worktree, and /worktree return moves it back.";

/** True for any input `/worktree` owns, so App can route before the model sees it. */
export function isWorktreeCommand(text: string): boolean {
  return /^\/worktree(?:\s|$)/.test(text.trim());
}

/**
 * Pure and total: every input yields a command or null, and nothing throws.
 *
 * `start` and `return` are reserved rather than treated as names. Reading
 * `/worktree start` as "create a worktree called start" would silently do
 * something else entirely.
 */
export function parseWorktreeCommand(text: string): WorktreeCommand | null {
  const trimmed = text.trim();
  if (!isWorktreeCommand(trimmed)) return null;
  const rest = trimmed.slice("/worktree".length).trim();
  if (!rest) return { kind: "create" };

  const [first, ...remainder] = rest.split(/\s+/);
  const argument = remainder.join(" ");
  if (first === "return") {
    if (argument) return { kind: "error", message: "/worktree return takes no argument" };
    return { kind: "return" };
  }
  if (first === "start") {
    // The directory may hold spaces, so the remainder is taken whole.
    return { kind: "start", ...(argument ? { directory: argument } : {}) };
  }
  if (remainder.length > 0) {
    return { kind: "error", message: `Unknown worktree command: ${rest}. ${USAGE}` };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(first!)) {
    return { kind: "error", message: `A worktree name holds letters, digits, dashes and underscores. ${USAGE}` };
  }
  return { kind: "create", name: first };
}

export function runWorktreeCommand({
  name,
  manager,
  append,
  patch,
  settled,
}: {
  name?: string;
  manager: SubagentManager;
  append: (call: ToolCall) => void;
  patch: (id: string, patch: Partial<ToolCall>) => void;
  settled: () => void;
}): void {
  const id = `worktree-command-${Date.now()}`;
  const call: ToolCall = {
    id,
    name: "worktree",
    arg: name ? `create ${name}` : "create",
    state: "running",
  };
  append(call);
  manager.persistToolEvent(call);
  manager
    .createStandaloneWorktree(name)
    .then((record) => {
      const update: Partial<ToolCall> = { state: "ok", detail: record.branch };
      patch(id, update);
      manager.persistToolEvent({ ...call, ...update });
    })
    .catch((error) => {
      const update: Partial<ToolCall> = { state: "error", detail: String(error) };
      patch(id, update);
      manager.persistToolEvent({ ...call, ...update });
    })
    .finally(settled);
}

export type Command = {
  name: string;
  description: string;
};

/** Commands handled by PUM before prompts reach the agent. */
export const COMMANDS: Command[] = [
  {
    name: "/compress",
    description: "Summarize older context and keep the recent conversation",
  },
  {
    name: "/clear",
    description: "Start a fresh session",
  },
  {
    name: "/new",
    description: "Alias for /clear",
  },
  {
    name: "/goal",
    description: "Set or control an autonomous goal (stop, continue, status, clear)",
  },
  {
    name: "/goalf",
    description: "Work a draft into one goal, then start it",
  },
  {
    name: "/afk",
    description: "Toggle away mode, or start it with instructions",
  },
  {
    name: "/background",
    description: "Start a shared-project agent for the selected transcript",
  },
  {
    name: "/history",
    description: "Browse saved sessions for this directory",
  },
  {
    name: "/resume",
    description: "Alias for /history",
  },
  {
    name: "/login",
    description: "Add or update a provider login",
  },
  {
    name: "/providers",
    description: "Manage providers: /providers [add|edit|delete] [name]",
  },
  {
    name: "/news",
    description: "Open recent answers (News)",
  },
  {
    name: "/todo",
    description: "Show the selected agent's todo list",
  },
  {
    name: "/stats",
    description: "Show session statistics",
  },
  {
    name: "/diagnostics",
    description: "Show opt-in request diagnostics for this session; clear resets them",
  },
  {
    name: "/model",
    description: "Choose a main-agent model: /model <name or provider/id> [effort]",
  },
  {
    name: "/store",
    description: "Save current settings as global defaults (same as Settings s)",
  },
  {
    name: "/s",
    description: "Alias for /store: save current settings globally",
  },
  {
    name: "/effort",
    description: "Show or change main-agent reasoning effort: /effort [level]",
  },
  {
    name: "/settings",
    description: "Show or change a setting: /settings <name> <value> [--global]",
  },
  {
    name: "/theme",
    description: "Show or change the theme: /theme <theme> [--global]",
  },
  {
    name: "/check-path",
    description: "Manage additional Check mode directory roots",
  },
  {
    name: "/triggers",
    description: "Open Processes on the Triggers tab",
  },
  {
    name: "/processes",
    description: "Manage external triggers and shells",
  },
  {
    name: "/worktree",
    description: "Create a worktree; start or return moves this session",
  },
];

/** Only a slash in the first input column starts a PUM command. */
export function isCommandInput(input: string): boolean {
  return input.startsWith("/");
}

export function matchingCommands(input: string): Command[] {
  // Suggestions complete only the command name. Once an argument starts, the
  // prompt belongs to the editor and Up/Down must navigate wrapped input.
  if (!isCommandInput(input) || /\s/.test(input)) return [];
  // No command name holds a second separator, so one means the user is typing
  // an absolute path. Leaving it to prefix matching would let Tab on /u turn
  // /usr/lib into /new.
  if (/[/\\]/.test(input.slice(1))) return [];
  const matches = COMMANDS.filter((command) => command.name.startsWith(input));
  // A complete short alias such as /s must not execute /stats on Enter.
  const exact = matches.find((command) => command.name === input);
  return exact ? [exact, ...matches.filter((command) => command !== exact)] : matches;
}

export function matchingCommandsForTarget(
  input: string,
  target: "main" | "subagent",
): Command[] {
  const matches = matchingCommands(input);
  return target === "subagent"
    ? matches.filter((command) => command.name === "/background" || command.name === "/diagnostics")
    : matches;
}

export function moveCommandSelection(current: number, count: number, step: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + step + count) % count;
}

/** Suggestion rows the prompt shows at one time. Longer lists scroll. */
export const SUGGESTION_ROWS = 5;

/**
 * First visible index of a suggestion list. The window follows the selection
 * and holds it near the middle, so a long list scrolls before the selection
 * reaches an edge of the window.
 */
export function suggestionWindowStart(
  cursor: number,
  count: number,
  rows: number = SUGGESTION_ROWS,
): number {
  if (count <= rows) return 0;
  const selected = Math.max(0, Math.min(cursor, count - 1));
  return Math.max(0, Math.min(selected - Math.floor((rows - 1) / 2), count - rows));
}

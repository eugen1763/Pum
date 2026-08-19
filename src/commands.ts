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
    description: "Start a managed worktree agent for the selected transcript",
  },
  {
    name: "/history",
    description: "Browse saved sessions for this directory",
  },
  {
    name: "/login",
    description: "Add or update a provider login",
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
  return COMMANDS.filter((command) => command.name.startsWith(input));
}

export function matchingCommandsForTarget(
  input: string,
  target: "main" | "subagent",
): Command[] {
  const matches = matchingCommands(input);
  return target === "subagent"
    ? matches.filter((command) => command.name === "/background")
    : matches;
}

export function moveCommandSelection(current: number, count: number, step: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + step + count) % count;
}

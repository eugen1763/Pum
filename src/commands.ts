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
    name: "/check-path",
    description: "Manage additional Check mode directory roots",
  },
  {
    name: "/triggers",
    description: "Manage external triggers",
  },
  {
    name: "/worktree",
    description: "Create a PUM Git worktree from the current branch",
  },
];

export function matchingCommands(input: string): Command[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const name = input.split(/\s/, 1)[0]!;
  return COMMANDS.filter((command) =>
    /\s/.test(input) ? command.name === name : command.name.startsWith(input),
  );
}

export function moveCommandSelection(current: number, count: number, step: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + step + count) % count;
}

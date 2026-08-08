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
];

export function matchingCommands(input: string): Command[] {
  if (!input.startsWith("/")) return [];
  const name = input.split(/\s/, 1)[0]!;
  return COMMANDS.filter((command) =>
    /\s/.test(input) ? command.name === name : command.name.startsWith(input),
  );
}

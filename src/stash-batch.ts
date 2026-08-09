export function selectedRange(anchor: number, cursor: number): Set<number> {
  const start = Math.min(anchor, cursor);
  const end = Math.max(anchor, cursor);
  return new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
}

export function buildStashBatchPrompt(prompts: string[]): string {
  const tasks = prompts.map((prompt, index) => `<task ${index + 1}>\n${prompt}\n</task ${index + 1}>`).join("\n\n");
  return `Coordinate the following cached tasks with managed worktree subagents.

Rules:
- Use spawn_subagent for the implementation work.
- You may group related tasks into one subagent when grouping reduces conflicts or duplicated work.
- Run independent task groups in parallel.
- Keep each subagent task complete and self-contained.
- Track every unfinished task group through completion notifications.
- Merge each successful subagent with the worktree tool as soon as it settles.
- Wait to merge only for a concrete dependency, known conflict risk, or required integration order. State that reason explicitly.
- A successful managed merge closes that subagent and removes its worktree and branch.
- Do not force-remove an unmerged or failed subagent. Report failures and merge conflicts.

Selected tasks:
${tasks}`;
}

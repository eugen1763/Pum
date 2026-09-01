export function selectedRange(anchor: number, cursor: number): Set<number> {
  const start = Math.min(anchor, cursor);
  const end = Math.max(anchor, cursor);
  return new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
}

export function buildStashBatchPrompt(prompts: string[]): string {
  const tasks = prompts.map((prompt, index) => `<task ${index + 1}>\n${prompt}\n</task ${index + 1}>`).join("\n\n");
  return `Coordinate the following cached tasks with managed subagents.

Rules:
- This prompt is the authoritative execution path created by message_cache_send or the cache selection UI.
- Reuse agents already assigned to these tasks. Never create duplicate assignments.
- Count only starting and running subagents as active. Use the configured capacity from the system prompt.
- Use spawn_subagent for implementation work while capacity is available.
- Use the shared project by default. Set worktree to true only when isolated changes or conflict avoidance require a separate branch.
- At capacity, queue related work to an appropriate running subagent with message_agent.
- message_agent uses the durable recipient-side message and steering queue.
- Do not route unrelated work to an arbitrary subagent. Keep it pending when no appropriate recipient is clear.
- You may group related tasks into one subagent when grouping reduces conflicts or duplicated work.
- Run independent task groups in parallel.
- Keep each subagent task complete and self-contained.
- Track every unfinished task group through completion notifications.
- Close each successful subagent only after a completion notice arrives and authoritative status is \`completed\`; idle settlement is not completion.
- Before merging a managed parent, recursively merge or resolve every retained descendant.
- Close the deepest descendants first. Every retained status blocks the parent, including completed and failed descendants.
- Wait to merge only for a concrete dependency, known conflict risk, or required integration order. State that reason explicitly.
- Merge a worktree subagent. Use worktree remove to close a shared-directory subagent without changing project files.
- Do not force-remove an unmerged or failed subagent. Report failures and merge conflicts.

Selected tasks:
${tasks}`;
}

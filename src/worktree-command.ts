import type { ToolCall } from "./tool-line";
import type { SubagentManager } from "./subagents/manager";

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

export type TerminalTitleState = {
  working: boolean;
  activeSubagentCount: number;
};

export type TerminalTitleSink = (title: string) => void;

export function formatTerminalTitle(state: TerminalTitleState): string {
  const count = Math.max(0, Math.floor(state.activeSubagentCount));
  const parts = ["Pum", state.working ? "working" : "idle"];
  if (count > 0) parts.push(`${count} ${count === 1 ? "subagent" : "subagents"}`);
  return parts.join(" · ");
}

/** Best-effort title writer with exact-value deduplication. */
export class TerminalTitleController {
  private lastTitle: string | null = null;

  constructor(private readonly write: TerminalTitleSink) {}

  update(state: TerminalTitleState): boolean {
    return this.set(formatTerminalTitle(state));
  }

  clear(): boolean {
    if (this.lastTitle === null || this.lastTitle === "") return false;
    return this.set("");
  }

  private set(title: string): boolean {
    if (title === this.lastTitle) return false;
    try {
      this.write(title);
      this.lastTitle = title;
      return true;
    } catch {
      // A title update must not interrupt the TUI or shutdown.
      return false;
    }
  }
}

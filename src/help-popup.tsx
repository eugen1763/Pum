import type { Theme } from "./theme";

/** Shown when `?` is typed into an empty prompt. */
export const CONTROLS: [string, string][] = [
  ["Enter", "Send, or steer while the agent works"],
  ["Ctrl/Shift+Enter", "Insert a new line"],
  ["\\ then Enter", "Insert a new line fallback"],
  ["Alt+Enter", "Stash without sending"],
  ["Ctrl+Alt+Enter", "Stash when Alt+Enter is reserved"],
  ["Alt+V", "Attach an image from the clipboard"],
  ["Tab", "Open cache, or move its selected item to input"],
  ["Shift+Tab", "Next agent transcript"],
  ["Ctrl+Shift+Tab", "Previous agent transcript"],
  ["Ctrl+L", "Open the agent transcript selector"],
  ["Delete", "Remove the selected cache item and prompt history"],
  ["↑ / ↓", "Earlier prompts, and back again"],
  ["Shift+↑ / ↓", "Select cached prompts for subagents"],
  ["Ctrl+Backspace", "Delete the previous word"],
  ["Esc", "Twice within 2s to cancel; keep prompt"],
  ["/compress", "Summarize older context"],
  ["/clear", "Start a fresh session (/new alias)"],
  ["/history", "Browse saved sessions"],
  ["/worktree", "Create a Git worktree under .pum/worktrees"],
  ["Ctrl+H", "Open session history"],
  ["Tab", "Complete a command preview"],
  ["Ctrl+P", "Settings"],
  ["Ctrl+C", "Twice to quit"],
  ["?", "This help, on an empty prompt"],
  ["pum -r", "Resume this directory's last session"],
];

/** A fixed-width box, not padEnd — string length is not display width. */
const KEY_WIDTH = 15;

export function HelpPopup({ theme }: { theme: Theme }) {
  return (
    <box
      title=" Controls "
      style={{
        position: "absolute",
        top: "15%",
        left: "15%",
        width: "70%",
        height: CONTROLS.length + 5,
        zIndex: 100,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: 1,
      }}
    >
      {CONTROLS.map(([key, what]) => (
        <box key={key} style={{ flexDirection: "row", height: 1 }}>
          <box style={{ width: KEY_WIDTH, flexShrink: 0 }}>
            <text content={key} fg={theme.accent} bg={theme.popupBg} />
          </box>
          <text content={what} fg={theme.fg} bg={theme.popupBg} style={{ flexGrow: 1 }} />
        </box>
      ))}
      {/* An empty <text> measures to nothing; a numeric height does not. */}
      <box style={{ height: 1, flexShrink: 0 }} />
      <text content="esc close" fg={theme.dim} bg={theme.popupBg} />
    </box>
  );
}

import type { Theme } from "./theme";

/** Shown when `?` is typed into an empty prompt. */
export const CONTROLS: [string, string][] = [
  ["Enter", "Send, or steer while the agent works"],
  ["↑ / ↓", "Earlier prompts, and back again"],
  ["Esc", "Cancel the turn, keep the prompt"],
  ["Ctrl+P", "Settings"],
  ["Ctrl+C", "Twice to quit"],
  ["?", "This help, on an empty prompt"],
  ["pum -r", "Resume this directory's last session"],
];

/** A fixed-width box, not padEnd — string length is not display width. */
const KEY_WIDTH = 9;

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

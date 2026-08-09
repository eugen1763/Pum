import type { Theme } from "./theme";

type HelpGroup = { title: string; controls: [string, string][] };

/** Shown when `?` is typed into an empty prompt. Keep this list aligned with app.tsx. */
export const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Prompt",
    controls: [
      ["Enter", "Send, or steer while working"],
      ["Ctrl/Shift+Enter", "Insert a new line"],
      ["\\ then Enter", "Insert a new line fallback"],
      ["Alt+Enter", "Cache without sending"],
      ["Ctrl+Alt+Enter", "Cache alias"],
      ["Alt+V", "Attach a clipboard image"],
      ["Ctrl+Backspace", "Delete the previous word"],
    ],
  },
  {
    title: "Cache and agents",
    controls: [
      ["Tab", "Open cache, or load selection"],
      ["Shift+↑ / ↓", "Select cached task range"],
      ["Delete", "Remove selected cached task"],
      ["Shift+Tab", "Next agent transcript"],
      ["Ctrl+Shift+Tab", "Previous agent transcript"],
      ["Ctrl+L", "Open agent transcript selector"],
    ],
  },
  {
    title: "History and sessions",
    controls: [
      ["↑ / ↓", "Browse prompt history"],
      ["Ctrl+H", "Open session history"],
      ["pum -r", "Resume the last session"],
    ],
  },
  {
    title: "Commands",
    controls: [
      ["/compress", "Summarize older context"],
      ["/clear", "Start a fresh session"],
      ["/history", "Browse saved sessions"],
      ["/worktree", "Create a managed worktree"],
      ["Tab", "Complete a command preview"],
    ],
  },
  {
    title: "Application",
    controls: [
      ["Ctrl+P", "Open Settings"],
      ["/ in Settings", "Focus settings search"],
      ["Esc", "Close; twice to cancel work"],
      ["Ctrl+C", "Press twice to quit"],
      ["?", "Open or close this help"],
    ],
  },
];

const KEY_WIDTH = 17;
type HelpLine = { kind: "heading"; text: string } | { kind: "control"; key: string; what: string };
const HELP_LINES: HelpLine[] = HELP_GROUPS.flatMap((group) => [
  { kind: "heading" as const, text: group.title },
  ...group.controls.map(([key, what]) => ({ kind: "control" as const, key, what })),
]);

export function helpPageSize(terminalHeight: number): number {
  return Math.max(1, Math.min(terminalHeight - 2, 35) - 5);
}

export function maxHelpScrollOffset(terminalHeight: number): number {
  return Math.max(0, HELP_LINES.length - helpPageSize(terminalHeight));
}

function HelpLineRow({ line, theme }: { line: HelpLine; theme: Theme }) {
  if (line.kind === "heading") {
    return <text content={line.text} fg={theme.dim} bg={theme.popupBg} />;
  }
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <box style={{ width: KEY_WIDTH, flexShrink: 0 }}>
        <text content={line.key} fg={theme.accent} bg={theme.popupBg} wrapMode="none" />
      </box>
      <text
        content={line.what}
        fg={theme.fg}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ flexGrow: 1, minWidth: 0 }}
      />
    </box>
  );
}

function HelpColumn({ groups, theme }: { groups: HelpGroup[]; theme: Theme }) {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
      {groups.map((group) => (
        <box key={group.title} style={{ flexDirection: "column", flexShrink: 0 }}>
          <text content={group.title} fg={theme.dim} bg={theme.popupBg} />
          {group.controls.map(([key, what], index) => (
            <box key={`${key}:${index}`} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
              <box style={{ width: KEY_WIDTH, flexShrink: 0 }}>
                <text content={key} fg={theme.accent} bg={theme.popupBg} wrapMode="none" />
              </box>
              <text
                content={what}
                fg={theme.fg}
                bg={theme.popupBg}
                wrapMode="none"
                style={{ flexGrow: 1, minWidth: 0 }}
              />
            </box>
          ))}
        </box>
      ))}
    </box>
  );
}

export function HelpPopup({
  theme,
  terminalWidth,
  terminalHeight,
  scrollOffset,
}: {
  theme: Theme;
  terminalWidth: number;
  terminalHeight: number;
  scrollOffset: number;
}) {
  const twoColumns = terminalWidth >= 82;
  const margin = terminalWidth < 64 ? 1 : Math.max(2, Math.floor(terminalWidth * 0.08));
  const popupWidth = Math.max(24, terminalWidth - margin * 2);
  // Add border, padding, and a fixed footer row to the tallest content column.
  const desiredHeight = twoColumns ? 24 : 35;
  const popupHeight = Math.max(8, Math.min(terminalHeight - 2, desiredHeight));
  const contentHeight = Math.max(1, popupHeight - 5);
  const split = 3;

  return (
    <box
      title=" Controls "
      style={{
        position: "absolute",
        top: Math.max(1, Math.floor((terminalHeight - popupHeight) / 2)),
        left: margin,
        width: popupWidth,
        height: popupHeight,
        zIndex: 100,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          height: contentHeight,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {twoColumns ? (
          <>
            <HelpColumn groups={HELP_GROUPS.slice(0, split)} theme={theme} />
            <box style={{ width: 2, flexShrink: 0 }} />
            <HelpColumn groups={HELP_GROUPS.slice(split)} theme={theme} />
          </>
        ) : (
          <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
            {HELP_LINES.slice(scrollOffset, scrollOffset + helpPageSize(terminalHeight)).map((line, index) => (
              <HelpLineRow key={`${scrollOffset + index}:${line.kind}`} line={line} theme={theme} />
            ))}
          </box>
        )}
      </box>
      <box style={{ height: 1, flexShrink: 0 }}>
        <text
          content={twoColumns ? "esc or ? close" : "↑↓ scroll   esc or ? close"}
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
        />
      </box>
    </box>
  );
}

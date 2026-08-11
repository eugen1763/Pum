import type { Theme } from "./theme";
import { PopupFrame } from "./popup-frame";

type HelpGroup = { title: string; controls: [string, string][] };

export const HELP_SUMMARY_WIDE = [
  "PUM workflow — prompt or steer · cache prompts · attach images · run managed worktree agents in parallel",
  "switch transcripts · merge successful agents · persist sessions · use Settings and safety checks",
] as const;

export const HELP_SUMMARY = [
  "Prompt or steer. Cache prompts. Attach images.",
  "Run managed worktree agents in parallel.",
  "Switch transcripts and merge successful agents.",
  "Sessions persist. Settings include safety checks.",
] as const;

/** Shown when `?` is typed into an empty prompt. Keep this list aligned with app.tsx. */
export const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Prompt",
    controls: [
      ["Enter", "Send, or steer while working"],
      ["Ctrl/Shift+Enter", "Insert a new line"],
      ["\\ then Enter", "Insert a new line fallback"],
      ["Alt+Enter", "Cache without sending"],
      ["Alt+V", "Attach a clipboard image"],
      ["Ctrl+Backspace", "Delete the previous word"],
      ["Ctrl+W", "Delete the previous word"],
      ["Questionnaire", "↑↓/←→ move · Enter select · Esc cancel"],
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
      ["↑ / ↓", "Recall queued on empty; otherwise history"],
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
      ["/login", "Add or update a provider"],
      ["/news", "Open recent answers (News)"],
      ["/check-path", "Manage extra Check mode paths"],
      ["/triggers", "Manage external triggers"],
      ["/worktree", "Create a managed worktree"],
      ["Tab", "Complete a command preview"],
    ],
  },
  {
    title: "Application",
    controls: [
      ["Ctrl+P", "Open Settings"],
      ["Ctrl+N", "Open recent answers (News)"],
      ["Ctrl+T", "Open external triggers"],
      ["Ctrl+End", "Scroll transcript to the end"],
      ["/ in Settings", "Focus settings search"],
      ["Esc", "Close; twice to cancel work"],
      ["Ctrl+C", "Clear; twice quits"],
      ["?", "Open or close this help"],
    ],
  },
];

const KEY_WIDTH = 17;
type HelpLine = { kind: "heading"; text: string } | { kind: "control"; key: string; what: string } | { kind: "blank" };

export function helpLines(terminalHeight: number): HelpLine[] {
  const gaps = terminalHeight >= 32;
  return HELP_GROUPS.flatMap((group, groupIndex) => [
    { kind: "heading" as const, text: group.title },
    ...group.controls.map(([key, what]) => ({ kind: "control" as const, key, what })),
    ...(gaps && groupIndex < HELP_GROUPS.length - 1 ? [{ kind: "blank" as const }] : []),
  ]);
}

type HelpLayout = {
  twoColumns: boolean;
  popupHeight: number;
  summaryLines: readonly string[];
  summaryHeight: number;
  topGap: number;
  contentHeight: number;
  bottomGap: number;
  footerHeight: number;
};

const POPUP_FRAME_ROWS = 4;
const MIN_TWO_COLUMN_CONTENT_WIDTH = KEY_WIDTH * 2 + 38 + 27 + 2;

function helpMargin(terminalWidth: number): number {
  return terminalWidth < 3
    ? 0
    : terminalWidth < 64 ? 1 : Math.max(2, Math.floor(terminalWidth * 0.08));
}

export function helpLayout(terminalWidth: number, terminalHeight: number): HelpLayout {
  const margin = helpMargin(terminalWidth);
  const contentWidth = Math.max(0, terminalWidth - margin * 2 - 4);
  const twoColumns = contentWidth >= MIN_TWO_COLUMN_CONTENT_WIDTH;
  const categorySpacing = terminalHeight >= 32;
  const desiredHeight = twoColumns ? (categorySpacing ? 30 : 28) : 39;
  const popupHeight = Math.max(1, Math.min(terminalHeight, desiredHeight));
  const innerHeight = Math.max(0, popupHeight - POPUP_FRAME_ROWS);
  const allSummaryLines = twoColumns
    ? HELP_SUMMARY_WIDE
    : ["PUM workflow", ...HELP_SUMMARY];
  const footerHeight = innerHeight >= 1 ? 1 : 0;
  const minimumContentHeight = innerHeight >= 2 ? 1 : 0;
  const summaryHeight = Math.min(
    allSummaryLines.length,
    Math.max(0, innerHeight - footerHeight - minimumContentHeight),
  );
  const fullSummaryFits = summaryHeight === allSummaryLines.length;
  const gapCapacity = fullSummaryFits
    ? Math.max(0, innerHeight - summaryHeight - footerHeight - minimumContentHeight)
    : 0;
  // Keep the footer separate first when only one compact-layout gap fits.
  const bottomGap = gapCapacity >= 1 ? 1 : 0;
  const topGap = gapCapacity >= 2 ? 1 : 0;
  const contentHeight = Math.max(
    0,
    innerHeight - summaryHeight - topGap - bottomGap - footerHeight,
  );

  return {
    twoColumns,
    popupHeight,
    summaryLines: allSummaryLines.slice(0, summaryHeight),
    summaryHeight,
    topGap,
    contentHeight,
    bottomGap,
    footerHeight,
  };
}

export function helpPageSize(terminalHeight: number): number {
  return Math.max(1, helpLayout(0, terminalHeight).contentHeight);
}

export function maxHelpScrollOffset(terminalHeight: number): number {
  const lines = helpLines(terminalHeight);
  const raw = Math.max(0, lines.length - helpPageSize(terminalHeight));
  const headingBeforeFirstControl =
    raw > 0 && lines[raw]?.kind === "control" && lines[raw - 1]?.kind === "heading"
      ? raw - 1
      : raw;
  const lastHeading = lines.findLastIndex((line) => line.kind === "heading");
  return lastHeading < 0 ? headingBeforeFirstControl : Math.min(headingBeforeFirstControl, lastHeading);
}

function HelpLineRow({ line, theme }: { line: HelpLine; theme: Theme }) {
  if (line.kind === "blank") return <box style={{ height: 1, flexShrink: 0 }} />;
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

function HelpColumn({ groups, theme, spaced }: { groups: HelpGroup[]; theme: Theme; spaced: boolean }) {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
      {groups.map((group, groupIndex) => (
        <box key={group.title} style={{ flexDirection: "column", flexShrink: 0, marginBottom: spaced && groupIndex < groups.length - 1 ? 1 : 0 }}>
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
  const layout = helpLayout(terminalWidth, terminalHeight);
  const margin = helpMargin(terminalWidth);
  const popupWidth = Math.max(1, terminalWidth - margin * 2);
  const split = 3;
  const lines = helpLines(terminalHeight);
  const spaced = terminalHeight >= 32;

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={{
        top: Math.max(0, Math.floor((terminalHeight - layout.popupHeight) / 2)),
        left: margin,
        width: popupWidth,
        height: layout.popupHeight,
      }}
      zIndex={100}
      title=" Controls "
    >
      <box style={{ height: layout.summaryHeight, flexShrink: 0, flexDirection: "column" }}>
        {layout.summaryLines.map((line, index) => (
          <text
            key={line}
            content={line}
            fg={layout.twoColumns || index === 0 ? theme.accent : theme.dim}
            bg={theme.popupBg}
            wrapMode="none"
          />
        ))}
      </box>
      {layout.topGap ? <box style={{ height: 1, flexShrink: 0 }} /> : null}
      <box
        style={{
          flexDirection: "row",
          height: layout.contentHeight,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {layout.twoColumns ? (
          <>
            <HelpColumn groups={HELP_GROUPS.slice(0, split)} theme={theme} spaced={spaced} />
            <box style={{ width: 2, flexShrink: 0 }} />
            <HelpColumn groups={HELP_GROUPS.slice(split)} theme={theme} spaced={spaced} />
          </>
        ) : (
          <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
            {lines.slice(scrollOffset, scrollOffset + helpPageSize(terminalHeight)).map((line, index) => (
              <HelpLineRow key={`${scrollOffset + index}:${line.kind}`} line={line} theme={theme} />
            ))}
          </box>
        )}
      </box>
      {layout.bottomGap ? <box style={{ height: 1, flexShrink: 0 }} /> : null}
      {layout.footerHeight ? (
        <box style={{ height: 1, flexShrink: 0 }}>
          <text
            content={layout.twoColumns ? "esc or ? close" : "↑↓ scroll   esc or ? close"}
            fg={theme.dim}
            bg={theme.popupBg}
            wrapMode="none"
          />
        </box>
      ) : null}
    </PopupFrame>
  );
}

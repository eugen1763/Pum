import { formatTokens } from "./status-metadata";
import {
  formatLatestUserTime,
  formatSessionBytes,
  type SessionHistoryItem,
} from "./session-history-metadata";
import type { Theme } from "./theme";

function tokenSummary(session: SessionHistoryItem): string {
  const tokens = session.historyMetadata.tokens;
  return [
    tokens.outgoing !== undefined ? `↑${formatTokens(tokens.outgoing)}` : "",
    tokens.incoming !== undefined ? `↓${formatTokens(tokens.incoming)}` : "",
    tokens.cacheRead !== undefined ? `↺${formatTokens(tokens.cacheRead)}` : "",
  ].filter(Boolean).join(" ");
}

export function sessionHistoryOption(
  session: SessionHistoryItem,
  currentPath: string | undefined,
  compact: boolean,
) {
  const current = session.path === currentPath;
  const title = (session.name || session.firstMessage || "(empty session)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "(empty session)";
  const date = formatLatestUserTime(session.historyMetadata.latestUserMessageAt);
  const size = formatSessionBytes(session.historyMetadata.fileBytes);
  const tokens = tokenSummary(session);
  const metadata = [date, size, `${session.messageCount} msg`, tokens]
    .filter(Boolean)
    .join(" · ");
  return {
    name: compact
      ? `${current ? "● " : ""}${title} · ${metadata}`
      : `${current ? "● " : ""}${title}`,
    description: compact ? "" : metadata,
    value: session.path,
  };
}

export function SessionHistoryPopup({
  theme,
  sessions,
  currentPath,
  terminalWidth,
  terminalHeight,
  onSelect,
}: {
  theme: Theme;
  sessions: readonly SessionHistoryItem[];
  currentPath?: string;
  terminalWidth: number;
  terminalHeight: number;
  onSelect: (path: string) => void;
}) {
  const marginX = terminalWidth >= 70 ? Math.max(2, Math.floor(terminalWidth * 0.08)) : 1;
  const marginY = terminalHeight >= 12 ? Math.max(1, Math.floor(terminalHeight * 0.08)) : 0;
  const compact = terminalWidth < 64 || terminalHeight < 12;
  const padding = terminalWidth >= 42 && terminalHeight >= 8 ? 1 : 0;
  const options = sessions.map((session) => sessionHistoryOption(session, currentPath, compact));
  const selectedIndex = Math.max(0, sessions.findIndex((session) => session.path === currentPath));
  const footer = terminalWidth >= 52
    ? "↑↓ select   enter open   esc close   ·   size = JSONL file bytes"
    : "↑↓ enter esc · size=JSONL bytes";

  return (
    <box
      title={terminalWidth >= 24 ? " Session history " : undefined}
      style={{
        position: "absolute",
        top: marginY,
        left: marginX,
        width: Math.max(1, terminalWidth - marginX * 2),
        height: Math.max(3, terminalHeight - marginY * 2),
        zIndex: 100,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding,
      }}
    >
      {sessions.length > 0 ? (
        <select
          focused
          backgroundColor={theme.popupBg}
          textColor={theme.fg}
          focusedBackgroundColor={theme.popupBg}
          focusedTextColor={theme.fg}
          selectedBackgroundColor={theme.selectionBg}
          selectedTextColor={theme.fg}
          descriptionColor={theme.dim}
          selectedDescriptionColor={theme.fg}
          selectedIndex={selectedIndex}
          showDescription={!compact}
          showScrollIndicator
          style={{ flexGrow: 1, minHeight: 1 }}
          options={options}
          onSelect={(_index, option) => {
            if (option) onSelect(option.value as string);
          }}
        />
      ) : (
        <text content="No saved sessions for this directory." fg={theme.dim} bg={theme.popupBg} />
      )}
      {terminalHeight >= 5 ? (
        <text
          content={footer}
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ flexShrink: 0 }}
        />
      ) : null}
    </box>
  );
}

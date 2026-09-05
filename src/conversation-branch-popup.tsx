import type { ConversationBranchPoint } from "./conversation-branch";
import { PopupFrame } from "./popup-frame";
import { truncateStatusText } from "./status-metadata";
import type { Theme } from "./theme";

/** Small pages also bound mounted rows; App alone owns keyboard and authority. */
export const CONVERSATION_BRANCH_PAGE_SIZE = 8;

export function ConversationBranchPopup({ theme, points, cursor, offset, total, confirming, terminalWidth, terminalHeight }: {
  theme: Theme;
  points: readonly ConversationBranchPoint[];
  cursor: number;
  offset: number;
  total: number;
  confirming: boolean;
  terminalWidth: number;
  terminalHeight: number;
}) {
  const width = Math.max(1, Math.min(100, terminalWidth - 2));
  const height = Math.max(1, Math.min(22, terminalHeight - 2));
  const columns = Math.max(1, width - 4);
  const selected = points[cursor];
  const rows = Math.max(1, height - 12);
  const start = Math.max(0, cursor - rows + 1);
  return <PopupFrame theme={theme} terminalWidth={terminalWidth} terminalHeight={terminalHeight}
    geometry={{ left: Math.max(0, Math.floor((terminalWidth - width) / 2)), top: Math.max(0, Math.floor((terminalHeight - height) / 2)), width, height }}
    title=" Same-session conversation branch " padding={1} zIndex={110}>
    <text content="SAME session and file; full tree and archives retained." fg={theme.fg} flexShrink={0} />
    <text content="Files/code and CURRENT goals, todos, settings, News and tool groups are NOT rewound." fg={theme.warn} flexShrink={0} />
    <text content="No summary, file copy or automatic submission. Runtime approvals are revoked." fg={theme.dim} flexShrink={0} />
    <box height={1} flexShrink={0} />
    {confirming && selected ? <>
      <text content={selected.kind === "user" ? "Return BEFORE this user message; restore plain text as an untrusted draft." : "Continue AFTER this settled assistant endpoint; editor stays empty."} fg={theme.fg} flexShrink={0} />
      <text content={truncateStatusText(selected.label, columns) ?? ""} fg={theme.accent} flexShrink={0} />
      <text content={`${selected.currentPath ? "current path" : "alternate path"}${selected.archived ? " · archived window" : ""}`} fg={theme.dim} flexShrink={0} />
    </> : <>
      {points.length === 0 ? <text content="No safe conversation points available." fg={theme.dim} /> : points.slice(start, start + rows).map((point, index) => <text key={point.entryId}
        content={truncateStatusText(`${start + index === cursor ? "› " : "  "}${point.kind === "user" ? "BEFORE user" : "AFTER assistant"} · ${point.currentPath ? "current" : "alternate"}${point.archived ? " · archived" : ""} · ${point.label}`, columns) ?? ""}
        fg={start + index === cursor ? theme.accent : theme.fg} bg={start + index === cursor ? theme.selectionBg : theme.popupBg}
        height={1} flexShrink={0} wrapMode="none" />)}
    </>}
    <box flexGrow={1} />
    <text content={confirming ? "Enter confirm branch · Esc back · Ctrl+C close" : `Points ${total ? offset + 1 : 0}–${offset + points.length} / ${total} · ↑↓ select · ←→ page`} fg={theme.dim} flexShrink={0} />
    {!confirming ? <text content="Enter preview · Esc close" fg={theme.dim} flexShrink={0} /> : null}
  </PopupFrame>;
}

import { PopupFrame } from "./popup-frame";
import { formatAge, type NewsItem } from "./news";
import type { Theme } from "./theme";

/**
 * Presentational popup for recent final answers. It owns no keyboard logic;
 * `app.tsx` routes arrows, Space, Enter, and Esc to the shared handlers.
 */
export function NewsPopup({
  theme,
  items,
  cursor,
  terminalWidth,
  terminalHeight,
}: {
  theme: Theme;
  /** Newest first; index 0 is the newest answer. */
  items: readonly NewsItem[];
  cursor: number;
  terminalWidth: number;
  terminalHeight: number;
}) {
  const width = Math.max(40, Math.min(terminalWidth - (terminalWidth >= 64 ? 8 : 2), 88));
  const height = Math.max(6, Math.min(terminalHeight - 4, 18));
  const top = Math.max(1, Math.floor((terminalHeight - height) / 2));
  const left = Math.max(1, Math.floor((terminalWidth - width) / 2));
  const bodyHeight = Math.max(0, height - 7);
  const count = items.length;
  const current = items[cursor];
  const seen = current ? current.read || current.answered : false;
  const maxBodyChars = Math.max(1, bodyHeight) * Math.max(1, width - 8);
  const bodyText = current && current.text.length > maxBodyChars
    ? `${current.text.slice(0, maxBodyChars)}\n…`
    : (current?.text ?? "");

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={{ top, left, width, height }}
      zIndex={100}
      title=" News "
    >
      {current ? (
        <>
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <text content={`${cursor + 1} / ${count}`} fg={theme.accent} bg={theme.popupBg} wrapMode="none" />
            <box style={{ flexGrow: 1, width: 1 }} />
            <text content={formatAge(current.at)} fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
          </box>
          <box style={{ height: 1, flexShrink: 0 }} />
          <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: "hidden", flexDirection: "row" }}>
            <box style={{ width: 2, flexShrink: 0 }}>
              <text
                content={seen ? "✓" : "◦"}
                fg={seen ? theme.success : theme.dim}
                bg={theme.popupBg}
                wrapMode="none"
              />
            </box>
            <text
              content={bodyText}
              fg={seen ? theme.dim : theme.assistant}
              bg={theme.popupBg}
              wrapMode="word"
              style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
            />
          </box>
        </>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <text content="No answers yet." fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
        </box>
      )}
      <box style={{ height: 1, flexShrink: 0 }} />
      <text
        content={count === 0
          ? "esc close"
          : "← → navigate · space read · enter reply · esc close"}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
      />
    </PopupFrame>
  );
}

import { useEffect, useMemo, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { buildSyntaxStyle } from "./syntax";
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
  const syntaxStyle = useMemo(() => buildSyntaxStyle(theme), [theme]);
  const marginX = terminalWidth >= 70 ? Math.max(2, Math.floor(terminalWidth * 0.06)) : 1;
  const marginY = terminalHeight >= 16 ? Math.max(1, Math.floor(terminalHeight * 0.07)) : 0;
  const width = Math.max(1, terminalWidth - marginX * 2);
  const height = Math.max(1, terminalHeight - marginY * 2);
  // PopupFrame adds a 1-c wide border and 1-c padding per side, and the gutter
  // takes 2 columns, so the markdown body gets a concrete numeric width.
  const bodyWidth = Math.max(1, width - 6);
  const count = items.length;
  const current = items[cursor];
  const seen = current ? current.read : false;
  const markdownScrollRef = useRef<ScrollBoxRenderable>(null);
  const itemId = current?.id;

  // Start each answer at the top when the selected answer changes.
  useEffect(() => {
    queueMicrotask(() => {
      if (markdownScrollRef.current) markdownScrollRef.current.scrollTop = 0;
    });
  }, [itemId, count]);

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={{ top: marginY, left: marginX, width, height }}
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
          <box
            style={{
              flexGrow: 1,
              flexShrink: 1,
              minHeight: 0,
              flexDirection: "row",
            }}
          >
            <box style={{ width: 2, flexShrink: 0 }}>
              <text
                content={seen ? "✓" : "◦"}
                fg={seen ? theme.success : theme.dim}
                bg={theme.popupBg}
                wrapMode="none"
              />
            </box>
            <scrollbox
              ref={markdownScrollRef}
              verticalScrollbarOptions={{ visible: true }}
              style={{ width: bodyWidth, flexGrow: 1, flexShrink: 0, minWidth: 0 }}
            >
              <markdown
                content={current.text}
                streaming={false}
                syntaxStyle={syntaxStyle}
                fg={seen ? theme.dim : theme.assistant}
                style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
              />
            </scrollbox>
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
          : "← → navigate · space read/unread · enter reply · esc close"}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ flexShrink: 0 }}
      />
    </PopupFrame>
  );
}

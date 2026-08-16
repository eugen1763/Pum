import { useEffect, useMemo, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { buildSyntaxStyle } from "./syntax";
import { PopupFrame } from "./popup-frame";
import { formatAge, type NewsItem } from "./news";
import { SelectableMarkdown, TextLine } from "./transcript";
import type { Theme } from "./theme";

/**
 * Presentational popup for recent final answers. It owns no keyboard logic;
 * `app.tsx` routes arrows, Space, Enter, Esc, C, N, and P to the shared handlers.
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
  // PopupFrame adds a 1-c wide border and 1-c padding per side, so the
  // markdown body gets a concrete numeric width.
  const bodyWidth = Math.max(1, width - 4);
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

  const footer = count === 0
    ? "esc close"
    : terminalWidth >= 90
      ? "← → navigate · n answer · p source · space read/unread · c copy · enter reply · esc close"
      : terminalWidth >= 64
        ? "←→ navigate · n answer · p source · space read · c copy · enter reply · esc"
        : "←→ nav · n answer · p source · space read · c copy · enter · esc";

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
          {current.completion ? (
            <text
              content={`${current.completion.agentName} → ${current.completion.requesterName} · finish_subagent`}
              fg={theme.dim}
              bg={theme.popupBg}
              wrapMode="none"
              style={{ height: 1, flexShrink: 0 }}
            />
          ) : null}
          <box style={{ height: 1, flexShrink: 0 }} />
          <scrollbox
            id="news-scrollbox"
            ref={markdownScrollRef}
            verticalScrollbarOptions={{ visible: true }}
            style={{ width: bodyWidth, flexGrow: 1, flexShrink: 1, minHeight: 1, minWidth: 0 }}
          >
            <box style={{ width: "100%", paddingRight: 1 }}>
              {current.prompts && current.prompts.length > 0 ? (
                <box style={{ width: "100%", flexShrink: 0 }}>
                  {current.prompts.map((prompt, index) => (
                    <TextLine
                      key={`${index}:${prompt.text}:${prompt.steer}`}
                      theme={theme}
                      syntaxStyle={syntaxStyle}
                      role="user"
                      text={prompt.text}
                    />
                  ))}
                </box>
              ) : null}
              {current.prompts && current.prompts.length > 0 ? (
                <box style={{ height: 1, flexShrink: 0 }} />
              ) : null}
              <box style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
                <box style={{ width: 2, flexShrink: 0 }}>
                  <text
                    content={seen ? "✓ " : "◦ "}
                    fg={seen ? theme.success : theme.dim}
                    bg={theme.popupBg}
                    wrapMode="none"
                  />
                </box>
                <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
                  <SelectableMarkdown
                    content={current.text}
                    streaming={false}
                    syntaxStyle={syntaxStyle}
                    fg={seen ? theme.dim : theme.assistant}
                    style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
                  />
                </box>
              </box>
            </box>
          </scrollbox>
        </>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <text content="No answers yet." fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
        </box>
      )}
      <box style={{ height: 1, flexShrink: 0 }} />
      <text
        content={footer}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ height: 1, flexShrink: 0 }}
      />
    </PopupFrame>
  );
}

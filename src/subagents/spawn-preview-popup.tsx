import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { SyntaxStyle } from "@opentui/core";
import type { Theme } from "../theme";
import { PopupFrame } from "../popup-frame";
import { TextLine } from "../transcript";
import type { SpawnPreviewRequest } from "./spawn-preview";

export function spawnPreviewPopupGeometry(width: number, height: number) {
  const margin = width < 4 ? 0 : width < 60 ? 1 : Math.max(2, Math.floor(width * 0.1));
  const popupWidth = Math.max(1, width - margin * 2);
  const desiredHeight = Math.max(6, Math.floor(height * 0.82));
  const popupHeight = Math.max(1, Math.min(height, desiredHeight));
  return {
    left: margin,
    top: Math.max(0, Math.floor((height - popupHeight) / 2)),
    width: popupWidth,
    height: popupHeight,
    compact: popupHeight < 7,
  };
}

export function SpawnPreviewPopup({
  theme,
  syntaxStyle,
  request,
  terminalWidth,
  terminalHeight,
  inputRef,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  request: SpawnPreviewRequest;
  terminalWidth: number;
  terminalHeight: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
}) {
  const geometry = spawnPreviewPopupGeometry(terminalWidth, terminalHeight);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const noteHeight = geometry.compact ? 1 : Math.min(4, Math.max(1, terminalHeight - 8));
  const taskAreaHeight = Math.max(1, geometry.height - noteHeight - (geometry.compact ? 1 : 6));

  useEffect(() => {
    inputRef.current?.setText("");
    const timer = setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
        scrollRef.current.scrollLeft = 0;
      }
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [request.id, inputRef]);

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={geometry}
      zIndex={130}
      title={geometry.compact ? undefined : ` Spawn preview · ${request.requester.name} `}
      border={!geometry.compact}
      padding={geometry.compact ? 0 : 1}
    >
      {!geometry.compact ? (
        <text content="Child task" fg={theme.accent} bg={theme.popupBg} style={{ height: 1, flexShrink: 0 }} />
      ) : null}
      <scrollbox
        ref={scrollRef}
        style={{ height: taskAreaHeight, flexShrink: 0 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <TextLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          role="assistant"
          text={request.options.task}
        />
      </scrollbox>
      <box style={{ flexDirection: "column", width: "100%", height: noteHeight + (geometry.compact ? 0 : 1), flexShrink: 0 }}>
        {!geometry.compact ? <text content="Optional note" fg={theme.dim} bg={theme.popupBg} /> : null}
        <textarea
          ref={inputRef}
          focused
          placeholder="Add an instruction after spawn…"
          placeholderColor={theme.dim}
          textColor={theme.fg}
          cursorColor={theme.accent}
          selectionBg={theme.selectionBg}
          wrapMode="char"
          style={{ width: "100%", height: noteHeight, flexShrink: 0 }}
        />
      </box>
      {!geometry.compact ? (
        <text
          content="Enter approve   Esc cancel"
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ height: 1, flexShrink: 0 }}
        />
      ) : null}
    </PopupFrame>
  );
}

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { PopupFrame } from "./popup-frame";
import type { ProviderEntry } from "./providers-command";
import type { Theme } from "./theme";

export type ProvidersPage =
  | {
    kind: "list";
    entries: readonly ProviderEntry[];
    cursor: number;
    query: string;
    searchFocused: boolean;
  }
  | { kind: "confirm-delete"; entry: ProviderEntry }
  | { kind: "working"; message: string }
  | { kind: "error"; title: string; message: string }
  | { kind: "success"; message: string };

/** One list row: the provider name, then where it stands. */
export function providerRowLabel(entry: ProviderEntry): string {
  const auth = entry.configured ? "logged in" : "not logged in";
  return `${entry.name} — ${entry.kind === "custom" ? `custom, ${auth}` : auth}`;
}

/**
 * The confirmation text. It names what deletion actually removes, because the
 * two provider kinds lose different things.
 */
export function deleteConfirmMessage(entry: ProviderEntry): string {
  return entry.kind === "custom"
    ? `Delete ${entry.name}? This removes its credential and its definition from models.json.`
    : `Remove the stored credential for ${entry.name}? You can add it again later.`;
}

function popupGeometry(width: number, height: number) {
  const margin = width < 4 ? 0 : width < 64 ? 1 : Math.max(2, Math.floor(width * 0.1));
  return {
    left: margin,
    width: Math.max(1, width - margin * 2),
    height: Math.max(1, Math.min(height, Math.max(8, height - 2), 22)),
  };
}

export function ProvidersPopup({ theme, page, terminalWidth, terminalHeight, onSearchChange = () => {} }: {
  theme: Theme;
  page: ProvidersPage;
  terminalWidth: number;
  terminalHeight: number;
  onSearchChange?: (value: string) => void;
}) {
  const geometry = popupGeometry(terminalWidth, terminalHeight);
  const listRef = useRef<ScrollBoxRenderable>(null);
  const cursor = page.kind === "list" ? page.cursor : null;
  const window = page.kind === "list" ? (() => {
    const total = page.entries.length;
    const capacity = Math.max(1, geometry.height - 7);
    const start = Math.min(
      Math.max(0, page.cursor - capacity + 1),
      Math.max(0, total - capacity),
    );
    return Array.from({ length: Math.min(capacity, total - start) }, (_, index) => start + index);
  })() : [];

  useEffect(() => {
    if (cursor !== null) listRef.current?.scrollChildIntoView(`providers-row-${cursor}`);
  }, [cursor, page.kind === "list" ? page.entries.length : 0]);

  const title = page.kind === "confirm-delete" ? " Delete provider " : " Providers ";

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={{
        top: Math.max(0, Math.floor((terminalHeight - geometry.height) / 2)),
        left: geometry.left,
        width: geometry.width,
        height: geometry.height,
      }}
      zIndex={120}
      title={title}
    >
      {page.kind === "list" ? <>
        <text
          content={terminalHeight < 12 ? "Manage providers" : "Add, edit, or delete a provider"}
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ height: 1, flexShrink: 0 }}
        />
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <box style={{ width: terminalWidth < 48 ? 7 : 9, flexShrink: 0 }}>
            <text content="Search" fg={page.searchFocused ? theme.accent : theme.dim} bg={theme.popupBg} />
          </box>
          <input
            value={page.query}
            placeholder={terminalWidth < 48 ? "filter" : "provider name"}
            placeholderColor={theme.dim}
            textColor={theme.fg}
            cursorColor={theme.accent}
            focused={page.searchFocused}
            onInput={onSearchChange}
            style={{ flexGrow: 1, minWidth: 0 }}
          />
        </box>
        <scrollbox
          ref={listRef}
          id="providers-list"
          style={{ flexGrow: 1, minHeight: 1 }}
          verticalScrollbarOptions={{ visible: true }}
          renderBefore={function () {
            if (cursor !== null) this.scrollChildIntoView(`providers-row-${cursor}`);
          }}
        >
          <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
            {window.map((index) => {
              const entry = page.entries[index]!;
              const selected = page.cursor === index;
              return (
                <box
                  id={`providers-row-${index}`}
                  key={entry.id}
                  style={{
                    height: 1,
                    flexShrink: 0,
                    backgroundColor: selected ? theme.selectionBg : theme.popupBg,
                  }}
                >
                  <text
                    content={`${selected ? "› " : "  "}${providerRowLabel(entry)}`}
                    fg={selected ? theme.accent : theme.fg}
                    bg={selected ? theme.selectionBg : theme.popupBg}
                    wrapMode="none"
                  />
                </box>
              );
            })}
            {page.entries.length === 0
              ? <text content="No matching providers" fg={theme.dim} bg={theme.popupBg} />
              : null}
          </box>
        </scrollbox>
        <text
          content={terminalWidth < 48
            ? "/ search  ↑↓  enter add  d del  esc"
            : "/ search   ↑↓ move   enter add or re-auth   d delete   esc close"}
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ height: 1, flexShrink: 0 }}
        />
      </> : page.kind === "confirm-delete" ? <>
        <text
          content={deleteConfirmMessage(page.entry)}
          fg={theme.fg}
          bg={theme.popupBg}
          wrapMode="word"
          style={{ flexGrow: 1, minHeight: 1 }}
        />
        <text
          content="y delete   n keep   esc cancel"
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ height: 1, flexShrink: 0 }}
        />
      </> : page.kind === "working" ? (
        <text content={page.message} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
      ) : page.kind === "error" ? <>
        <text content={page.title} fg={theme.accent} bg={theme.popupBg} wrapMode="word" />
        <text
          content={page.message}
          fg={theme.fg}
          bg={theme.popupBg}
          wrapMode="word"
          style={{ flexGrow: 1, minHeight: 1 }}
        />
        <text
          content="esc close"
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ height: 1, flexShrink: 0 }}
        />
      </> : (
        <text content={page.message} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
      )}
    </PopupFrame>
  );
}

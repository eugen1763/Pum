import type { ScrollBoxRenderable } from "@opentui/core";
import type { Model } from "@earendil-works/pi-ai";
import { useEffect, useRef } from "react";
import type { Theme } from "./theme";

/** The seven levels pi accepts. setThinkingLevel() clamps to model capability. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type SettingRowId =
  | "theme"
  | "animations"
  | "workingRuleAnimation"
  | "webSearch"
  | "writingStyle"
  | "checkMode"
  | "checkModel"
  | "thinkingLevel"
  | "showThinking"
  | "model";

export type SettingRow = {
  id: SettingRowId;
  label: string;
  category: "Appearance" | "Agent" | "Safety";
  keywords: string;
};

export const SETTINGS_ROWS: readonly SettingRow[] = [
  { id: "theme", label: "Theme", category: "Appearance", keywords: "color palette" },
  { id: "animations", label: "Animations", category: "Appearance", keywords: "motion global" },
  {
    id: "workingRuleAnimation",
    label: "Working animation",
    category: "Appearance",
    keywords: "rules input header coordinated off motion",
  },
  { id: "model", label: "Model", category: "Agent", keywords: "provider llm" },
  { id: "thinkingLevel", label: "Thinking level", category: "Agent", keywords: "reasoning effort" },
  { id: "showThinking", label: "Show thinking", category: "Agent", keywords: "reasoning visible" },
  { id: "writingStyle", label: "Writing style", category: "Agent", keywords: "response prose" },
  { id: "webSearch", label: "Web search", category: "Agent", keywords: "internet hosted" },
  { id: "checkMode", label: "Check mode", category: "Safety", keywords: "verify tools safe" },
  { id: "checkModel", label: "Check model", category: "Safety", keywords: "verifier tools" },
];

export function filterSettingsRows(query: string): SettingRow[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...SETTINGS_ROWS];
  return SETTINGS_ROWS.filter((row) => {
    const haystack = `${row.label} ${row.category} ${row.keywords}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function moveSettingSelection(
  rows: readonly SettingRow[],
  selectedId: SettingRowId | null,
  step: -1 | 1,
): SettingRowId | null {
  if (rows.length === 0) return null;
  const current = rows.findIndex((row) => row.id === selectedId);
  const start = current < 0 ? (step > 0 ? -1 : 0) : current;
  return rows[(start + step + rows.length) % rows.length]!.id;
}

export function isSettingsSearchShortcut(
  key: { name: string; sequence: string; ctrl?: boolean; meta?: boolean; option?: boolean },
  searchFocused: boolean,
): boolean {
  return !searchFocused && !key.ctrl && !key.meta && !key.option &&
    (key.name === "/" || key.sequence === "/");
}

export type PopupProps = {
  theme: Theme;
  page: "main" | "models" | "checkModels";
  rows: readonly SettingRow[];
  selectedId: SettingRowId | null;
  values: Readonly<Record<SettingRowId, string>>;
  query: string;
  searchFocused: boolean;
  terminalWidth: number;
  terminalHeight: number;
  models: readonly Model<any>[];
  onSearchChange: (value: string) => void;
  onSelectModel: (model: Model<any>) => void;
  onSelectCheckModel: (model: Model<any>) => void;
};

/**
 * The popup owns layout only. The keyboard handler in app.tsx owns all menu
 * navigation and focus transitions.
 */
export function SettingsPopup({
  theme,
  page,
  rows,
  selectedId,
  values,
  query,
  searchFocused,
  terminalWidth,
  terminalHeight,
  models,
  onSearchChange,
  onSelectModel,
  onSelectCheckModel,
}: PopupProps) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const narrow = terminalWidth < 64;
  const margin = narrow ? 1 : Math.max(2, Math.floor(terminalWidth * 0.1));
  const popupWidth = Math.max(24, terminalWidth - margin * 2);
  const popupHeight = Math.max(8, Math.min(terminalHeight - 2, page === "main" ? 20 : 18));

  useEffect(() => {
    if (selectedId) listRef.current?.scrollChildIntoView(`setting-${selectedId}`);
  }, [selectedId, rows.length]);

  let lastCategory: SettingRow["category"] | null = null;

  return (
    <box
      title={page === "main" ? " Settings " : page === "models" ? " Model " : " Check model "}
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
      {page === "main" ? (
        <>
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <box style={{ width: narrow ? 7 : 9, flexShrink: 0 }}>
              <text content="Search" fg={searchFocused ? theme.accent : theme.dim} bg={theme.popupBg} />
            </box>
            <input
              value={query}
              placeholder="type to filter"
              placeholderColor={theme.dim}
              textColor={theme.fg}
              cursorColor={theme.accent}
              focused={searchFocused}
              onInput={onSearchChange}
              style={{ flexGrow: 1, minWidth: 0 }}
            />
          </box>
          <box style={{ height: 1, flexShrink: 0 }}>
            <text content={"─".repeat(Math.max(0, popupWidth - 4))} fg={theme.border} bg={theme.popupBg} />
          </box>
          <scrollbox
            ref={listRef}
            style={{ flexGrow: 1, minHeight: 1 }}
            verticalScrollbarOptions={{ visible: true }}
          >
            <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
              {rows.length === 0 ? (
                <text content="No matching settings" fg={theme.dim} bg={theme.popupBg} />
              ) : rows.map((row) => {
                const showCategory = row.category !== lastCategory;
                lastCategory = row.category;
                const selected = selectedId === row.id && !searchFocused;
                return (
                  <box key={row.id} style={{ flexDirection: "column", flexShrink: 0 }}>
                    {showCategory ? (
                      <text content={row.category} fg={theme.dim} bg={theme.popupBg} />
                    ) : null}
                    <box
                      id={`setting-${row.id}`}
                      style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
                    >
                      <box style={{ width: 2, flexShrink: 0 }}>
                        {selected ? <text content="› " fg={theme.accent} bg={theme.popupBg} /> : null}
                      </box>
                      <text
                        content={row.label}
                        fg={selected ? theme.accent : theme.fg}
                        bg={theme.popupBg}
                        wrapMode="none"
                        style={{ width: 18, flexShrink: 0 }}
                      />
                      <text
                        content={values[row.id]}
                        fg={selected ? theme.accent : theme.fg}
                        bg={theme.popupBg}
                        wrapMode="none"
                        style={{ flexGrow: 1, minWidth: 0 }}
                      />
                    </box>
                  </box>
                );
              })}
            </box>
          </scrollbox>
          <text
            content={narrow ? "/ search  ↑↓ move  ←→ change  esc back" : "/ search   ↑↓ move   ←→ change   ⏎ open   esc back"}
            fg={theme.dim}
            bg={theme.popupBg}
            wrapMode="none"
            style={{ flexShrink: 0 }}
          />
        </>
      ) : (
        <select
          focused
          style={{ flexGrow: 1 }}
          backgroundColor={theme.popupBg}
          focusedBackgroundColor={theme.popupBg}
          textColor={theme.fg}
          focusedTextColor={theme.fg}
          selectedBackgroundColor={theme.selectionBg}
          selectedTextColor={theme.accent}
          descriptionColor={theme.dim}
          selectedDescriptionColor={theme.fg}
          options={models.map((m) => ({ name: m.id, description: m.provider, value: m }))}
          onSelect={(_index, option) => {
            if (!option) return;
            const model = option.value as Model<any>;
            if (page === "checkModels") onSelectCheckModel(model);
            else onSelectModel(model);
          }}
        />
      )}
    </box>
  );
}

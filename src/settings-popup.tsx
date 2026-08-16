import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "./theme";
import { PopupFrame } from "./popup-frame";

/** The seven levels pi accepts. setThinkingLevel() clamps to model capability. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type SettingRowId =
  | "theme"
  | "animations"
  | "workingRuleAnimation"
  | "outputMode"
  | "webSearch"
  | "writingStyle"
  | "explanationStrength"
  | "checkMode"
  | "sandboxMode"
  | "checkModel"
  | "checkPaths"
  | "thinkingLevel"
  | "showThinking"
  | "maxActiveSubagents"
  | "goalRetryLimit"
  | "providers"
  | "model";

export type SettingRow = {
  id: SettingRowId;
  label: string;
  category: "Appearance" | "Agent" | "Safety";
  keywords: string;
  description: string;
};

export const SETTINGS_ROWS: readonly SettingRow[] = [
  { id: "theme", label: "Theme", category: "Appearance", keywords: "color palette semantic", description: "Change the semantic color preset. theme.json overrides remain active." },
  { id: "animations", label: "Animations", category: "Appearance", keywords: "motion global truecolor", description: "Enable interface motion. PUM disables motion when true color is unavailable." },
  { id: "workingRuleAnimation", label: "Working animation", category: "Appearance", keywords: "rules input header coordinated off motion", description: "Choose how the header and input rules animate while an agent works." },
  { id: "outputMode", label: "Transcript detail", category: "Appearance", keywords: "transcript tools quiet normal verbose raw summary", description: "Choose grouped Quiet output, live Normal output, or raw Verbose tool results." },
  { id: "providers", label: "Providers", category: "Agent", keywords: "login oauth api key custom endpoint", description: "Open provider login or add an OpenAI-compatible custom endpoint." },
  { id: "model", label: "Model", category: "Agent", keywords: "provider llm active search", description: "Select the model used by the main agent. Search matches provider and model names." },
  { id: "thinkingLevel", label: "Thinking level", category: "Agent", keywords: "reasoning effort clamp capability", description: "Set reasoning effort. Pi clamps the level to the selected model capability." },
  { id: "showThinking", label: "Thinking traces", category: "Agent", keywords: "reasoning visible transcript trace", description: "Show or hide streamed reasoning traces. This control is independent from transcript detail." },
  { id: "maxActiveSubagents", label: "Active subagents", category: "Agent", keywords: "parallel capacity maximum limit starting running workers", description: "Set the maximum number of starting and running managed subagents from 1 through 25." },
  { id: "goalRetryLimit", label: "Goal retries", category: "Agent", keywords: "goal judge incomplete consecutive retry limit autonomous continuation fail", description: "Set how many consecutive incomplete goal reviews are allowed before the goal fails. 0 means no limit." },
  { id: "writingStyle", label: "Writing style", category: "Agent", keywords: "response prose ste simplified technical english", description: "Add per-turn response guidance. STE requests concise Simplified Technical English." },
  { id: "explanationStrength", label: "Progress narration", category: "Agent", keywords: "progress updates output none simple detailed adaptive rationale", description: "Choose how much assistant prose explains plans, actions, decisions, and results." },
  { id: "webSearch", label: "Web search", category: "Agent", keywords: "internet hosted codex provider", description: "Allow hosted web search on supported Codex providers. Other providers are unchanged." },
  { id: "checkMode", label: "Check mode", category: "Safety", keywords: "on off verify tools hard block bash edit patch trigger process", description: "Turn Check mode on or off. On checks bash, edit, apply_patch, and external-trigger process proposals, with hard security rules." },
  { id: "sandboxMode", label: "Sandbox", category: "Safety", keywords: "os isolation auto require off enforcement fallback bash", description: "Choose automatic fallback, required OS enforcement, or no OS sandbox for Bash commands." },
  { id: "checkModel", label: "Check model", category: "Safety", keywords: "separate verifier tools safety structured verdict model complete proposals", description: "Select the advisory verifier model that reviews complete Check mode proposals after deterministic validation." },
  { id: "checkPaths", label: "Allowed paths", category: "Safety", keywords: "additional directories roots boundary sandbox command", description: "Use /check-path to manage extra directory roots allowed by the filesystem sandbox and Check mode for this project." },
];

// bashOutput remains an advanced config object in pum.json. A one-row cycle
// would hide its strategy, byte cap, filtering, and retention interactions, so
// the prototype does not present a misleading "Command output" toggle here.

export function filterSettingsRows(query: string): SettingRow[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...SETTINGS_ROWS];
  return SETTINGS_ROWS.filter((row) => {
    const haystack = `${row.label} ${row.category} ${row.keywords} ${row.description}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function filterModels(
  models: readonly Model<any>[],
  query: string,
  providerName: (providerId: string) => string = () => "",
): Model<any>[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...models];
  return models.filter((model) => {
    const haystack = `${model.provider} ${providerName(model.provider)} ${model.id} ${model.name ?? ""}`.toLocaleLowerCase();
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

export function isModelSearchShortcut(
  key: { name: string; sequence: string; ctrl?: boolean; meta?: boolean; option?: boolean },
  searchFocused: boolean,
): boolean {
  return !searchFocused && !key.ctrl && !key.meta && !key.option &&
    (key.name === "/" || key.sequence === "/");
}

export function isSettingsSearchShortcut(
  key: { name: string; sequence: string; ctrl?: boolean; meta?: boolean; option?: boolean },
  searchFocused: boolean,
): boolean {
  return !searchFocused && !key.ctrl && !key.meta && !key.option &&
    (key.name === "/" || key.sequence === "/");
}

export type SettingsPopupLayout = {
  narrow: boolean;
  margin: number;
  popupWidth: number;
  popupHeight: number;
  top: number;
  searchHeight: number;
  separatorHeight: number;
  listHeight: number;
  descriptionHeight: number;
  footerHeight: number;
};

const SETTINGS_POPUP_FRAME_ROWS = 4;
const SETTINGS_POPUP_MIN_HEIGHT = 10;
const SETTINGS_MODEL_POPUP_MIN_HEIGHT = 8;
const SETTINGS_POPUP_MAX_HEIGHT = 32;
const SETTINGS_MODEL_POPUP_MAX_HEIGHT = 28;
const SETTINGS_POPUP_HEIGHT_RATIO = 0.8;

export function settingsPopupLayout(
  terminalWidth: number,
  terminalHeight: number,
  page: "main" | "models" | "checkModels",
): SettingsPopupLayout {
  const narrow = terminalWidth < 64;
  const margin = terminalWidth < 4 ? 0 : narrow ? 1 : Math.max(2, Math.floor(terminalWidth * 0.1));
  const popupWidth = Math.max(1, terminalWidth - margin * 2);
  const minimumHeight = page === "main" ? SETTINGS_POPUP_MIN_HEIGHT : SETTINGS_MODEL_POPUP_MIN_HEIGHT;
  const maximumHeight = page === "main" ? SETTINGS_POPUP_MAX_HEIGHT : SETTINGS_MODEL_POPUP_MAX_HEIGHT;
  const scaledHeight = Math.floor(terminalHeight * SETTINGS_POPUP_HEIGHT_RATIO);
  const desiredHeight = Math.max(minimumHeight, Math.min(maximumHeight, scaledHeight));
  // Reserve the final terminal row for PopupFrame's semantic bottom shadow.
  const availableHeight = Math.max(1, terminalHeight - (terminalHeight > 1 ? 1 : 0));
  const popupHeight = Math.min(availableHeight, desiredHeight);
  const top = Math.max(0, Math.floor((terminalHeight - popupHeight) / 2));
  const innerHeight = Math.max(0, popupHeight - SETTINGS_POPUP_FRAME_ROWS);

  const searchHeight = innerHeight >= 1 ? 1 : 0;
  const footerHeight = innerHeight >= 3 ? 1 : 0;
  const minimumListHeight = innerHeight >= 2 ? 1 : 0;
  const optionalRows = Math.max(0, innerHeight - searchHeight - footerHeight - minimumListHeight);

  if (page !== "main") {
    return {
      narrow,
      margin,
      popupWidth,
      popupHeight,
      top,
      searchHeight,
      separatorHeight: 0,
      listHeight: Math.max(0, innerHeight - searchHeight - footerHeight),
      descriptionHeight: 0,
      footerHeight,
    };
  }

  const separatorHeight = optionalRows >= 2 ? 1 : 0;
  const descriptionHeight = Math.min(
    narrow ? 3 : 2,
    Math.max(0, optionalRows - separatorHeight),
  );
  const listHeight = Math.max(
    0,
    innerHeight - searchHeight - separatorHeight - descriptionHeight - footerHeight,
  );

  return {
    narrow,
    margin,
    popupWidth,
    popupHeight,
    top,
    searchHeight,
    separatorHeight,
    listHeight,
    descriptionHeight,
    footerHeight,
  };
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
  modelQuery?: string;
  modelSearchFocused?: boolean;
  onSearchChange: (value: string) => void;
  onModelSearchChange?: (value: string) => void;
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
  modelQuery = "",
  modelSearchFocused = false,
  onSearchChange,
  onModelSearchChange = () => {},
  onSelectModel,
  onSelectCheckModel,
}: PopupProps) {
  const layout = settingsPopupLayout(terminalWidth, terminalHeight, page);
  const listItems: Array<
    | { kind: "category"; category: SettingRow["category"] }
    | { kind: "row"; row: SettingRow }
  > = [];
  let category: SettingRow["category"] | null = null;
  for (const row of rows) {
    if (row.category !== category) {
      category = row.category;
      listItems.push({ kind: "category", category });
    }
    listItems.push({ kind: "row", row });
  }
  const selectedItemIndex = listItems.findIndex(
    (item) => item.kind === "row" && item.row.id === selectedId,
  );
  const listWindowStart = selectedItemIndex < 0
    ? 0
    : Math.min(
      Math.max(0, selectedItemIndex - layout.listHeight + 1),
      Math.max(0, listItems.length - layout.listHeight),
    );
  const visibleListItems = listItems.slice(listWindowStart, listWindowStart + layout.listHeight);
  const selectedRow = rows.find((row) => row.id === selectedId);

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={{
        top: layout.top,
        left: layout.margin,
        width: layout.popupWidth,
        height: layout.popupHeight,
      }}
      zIndex={100}
      title={page === "main" ? " Settings " : page === "models" ? " Model " : " Check model "}
    >
      {page === "main" ? (
        <>
          {layout.searchHeight ? <box style={{ height: layout.searchHeight, flexShrink: 0, flexDirection: "row" }}>
            <box style={{ width: layout.narrow ? 7 : 9, flexShrink: 0 }}>
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
          </box> : null}
          {layout.separatorHeight ? <box style={{ height: layout.separatorHeight, flexShrink: 0 }}>
            <text content={"─".repeat(Math.max(0, layout.popupWidth - 4))} fg={theme.border} bg={theme.popupBg} />
          </box> : null}
          {layout.listHeight ? <box
            style={{ height: layout.listHeight, flexShrink: 0, flexDirection: "column", overflow: "hidden" }}
          >
            {rows.length === 0 ? (
              <text content="No matching settings" fg={theme.dim} bg={theme.popupBg} />
            ) : visibleListItems.map((item) => {
              if (item.kind === "category") {
                return <text key={`category-${item.category}`} content={item.category} fg={theme.dim} bg={theme.popupBg} />;
              }
              const row = item.row;
              const selected = selectedId === row.id && !searchFocused;
              return (
                <box
                  key={row.id}
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
              );
            })}
          </box> : null}
          {layout.descriptionHeight ? <box style={{ height: layout.descriptionHeight, flexShrink: 0 }}>
            <text
              content={selectedRow?.description ?? "Type in Search to filter settings."}
              fg={theme.dim}
              bg={theme.popupBg}
              wrapMode="word"
            />
          </box> : null}
          {layout.footerHeight ? <text
            content={layout.narrow ? "/ search  ↑↓ move  ←→ s save  esc back" : "/ search   ↑↓ move   ←→ change   s save global   esc back"}
            fg={theme.dim}
            bg={theme.popupBg}
            wrapMode="none"
            style={{ height: layout.footerHeight, flexShrink: 0 }}
          /> : null}
        </>
      ) : (
        <>
          {layout.searchHeight ? <input
            value={modelQuery}
            placeholder="Search provider or model"
            placeholderColor={theme.dim}
            textColor={theme.fg}
            cursorColor={theme.accent}
            focused={modelSearchFocused}
            onInput={onModelSearchChange}
            style={{ flexShrink: 0 }}
          /> : null}
          {layout.listHeight ? <box style={{ height: layout.listHeight, flexShrink: 0 }}>
            {models.length === 0 ? <text content="No matching models" fg={theme.dim} bg={theme.popupBg} /> : <select
              focused={!modelSearchFocused}
              style={{ flexGrow: 1, minHeight: 1 }}
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
            />}
          </box> : null}
          {layout.footerHeight ? <text
            content="/ search   ↑↓ move   enter select   esc back"
            fg={theme.dim}
            bg={theme.popupBg}
            wrapMode="none"
            style={{ height: layout.footerHeight, flexShrink: 0 }}
          /> : null}
        </>
      )}
    </PopupFrame>
  );
}

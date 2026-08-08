import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "./theme";

/** The seven levels pi accepts. setThinkingLevel() clamps to model capability. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const ROWS = [
  "Theme",
  "Animations",
  "Web search",
  "Thinking level",
  "Show thinking",
  "Model",
] as const;


export type PopupProps = {
  theme: Theme;
  page: "main" | "models";
  cursor: number;
  values: string[];
  models: readonly Model<any>[];
  onSelectModel: (model: Model<any>) => void;
};

/**
 * Absolutely positioned, so it must be mounted as a direct child of the root
 * box — zIndex only orders siblings, it does not escape a parent.
 */
export function SettingsPopup({
  theme,
  page,
  cursor,
  values,
  models,
  onSelectModel,
}: PopupProps) {
  return (
    <box
      title={page === "main" ? " Settings " : " Model "}
      style={{
        position: "absolute",
        top: "15%",
        left: "15%",
        width: "70%",
        // rows + blank + hint, plus 1 padding and 1 border each side
        height: page === "main" ? ROWS.length + 6 : "60%",
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
          {ROWS.map((label, i) => (
            <text
              key={label}
              content={`${cursor === i ? "›" : " "} ${label.padEnd(16)}${values[i] ?? ""}`}
              fg={cursor === i ? theme.accent : theme.fg}
              bg={theme.popupBg}
            />
          ))}
          <text content="" bg={theme.popupBg} />
          <text
            content="↑↓ move   ←→ change   ⏎ open   esc close"
            fg={theme.dim}
            bg={theme.popupBg}
          />
        </>
      ) : (
        <select
          focused
          style={{ flexGrow: 1 }}
          options={models.map((m) => ({ name: m.id, description: m.provider, value: m }))}
          onSelect={(_index, option) => option && onSelectModel(option.value as Model<any>)}
        />
      )}
    </box>
  );
}

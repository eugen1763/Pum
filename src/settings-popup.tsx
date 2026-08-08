import type { Model } from "@earendil-works/pi-ai";

/** The seven levels pi accepts. setThinkingLevel() clamps to model capability. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const ROWS = ["Thinking level", "Show thinking", "Model"] as const;

const ACTIVE = "#7aa2f7";
const IDLE = "#c0caf5";
const DIM = "#565f89";
const BG = "#1f2335";

export type PopupProps = {
  page: "main" | "models";
  cursor: number;
  thinkingLevel: ThinkingLevel;
  showThinking: boolean;
  modelId: string;
  models: readonly Model<any>[];
  onSelectModel: (model: Model<any>) => void;
};

/**
 * Absolutely positioned, so it must be mounted as a direct child of the root
 * box — zIndex only orders siblings, it does not escape a parent.
 */
export function SettingsPopup({
  page,
  cursor,
  thinkingLevel,
  showThinking,
  modelId,
  models,
  onSelectModel,
}: PopupProps) {
  const values = [`‹ ${thinkingLevel} ›`, `‹ ${showThinking ? "on" : "off"} ›`, `${modelId} ›`];

  return (
    <box
      title={page === "main" ? " Settings " : " Model "}
      style={{
        position: "absolute",
        top: "15%",
        left: "15%",
        width: "70%",
        height: page === "main" ? 9 : "60%",
        zIndex: 100,
        border: true,
        backgroundColor: BG,
        flexDirection: "column",
        padding: 1,
      }}
    >
      {page === "main" ? (
        <>
          {ROWS.map((label, i) => (
            <text
              key={label}
              content={`${cursor === i ? "›" : " "} ${label.padEnd(16)}${values[i]}`}
              fg={cursor === i ? ACTIVE : IDLE}
              bg={BG}
            />
          ))}
          <text content="" bg={BG} />
          <text content="↑↓ move   ←→ change   ⏎ open   esc close" fg={DIM} bg={BG} />
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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { DEFAULT_CHECK_MODEL } from "./check-mode";
import { isWritingStyle, type WritingStyle } from "./writing-style";

/**
 * PUM's own settings. Model and thinking level are deliberately not here — pi
 * already persists those to <AGENT_DIR>/settings.json via setModel() and
 * setThinkingLevel(), and restores them when the session is created.
 */
export type PumSettings = {
  showThinking: boolean;
  theme: string;
  animations: boolean;
  webSearch: boolean;
  writingStyle: WritingStyle;
  checkMode: boolean;
  checkModel: string;
};

const SETTINGS_PATH = join(AGENT_DIR, "pum.json");
const DEFAULTS: PumSettings = {
  showThinking: false,
  theme: "tokyonight",
  animations: true,
  webSearch: true,
  writingStyle: "none",
  checkMode: false,
  checkModel: DEFAULT_CHECK_MODEL,
};

export function loadSettings(): PumSettings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const merged = { ...DEFAULTS, ...parsed };
    return {
      ...merged,
      writingStyle: isWritingStyle(merged.writingStyle) ? merged.writingStyle : DEFAULTS.writingStyle,
      checkMode: typeof merged.checkMode === "boolean" ? merged.checkMode : DEFAULTS.checkMode,
      checkModel:
        typeof merged.checkModel === "string" && merged.checkModel.includes("/")
          ? merged.checkModel
          : DEFAULTS.checkModel,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: PumSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

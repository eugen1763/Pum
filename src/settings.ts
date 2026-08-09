import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { DEFAULT_CHECK_MODEL } from "./check-mode";
import { isWritingStyle, type WritingStyle } from "./writing-style";
import {
  isExplanationStrength,
  type ExplanationStrength,
} from "./explanation-strength";

export const WORKING_RULE_ANIMATION_MODES = ["off", "input-only", "coordinated"] as const;
export type WorkingRuleAnimationMode = (typeof WORKING_RULE_ANIMATION_MODES)[number];

export function isWorkingRuleAnimationMode(value: unknown): value is WorkingRuleAnimationMode {
  return WORKING_RULE_ANIMATION_MODES.includes(value as WorkingRuleAnimationMode);
}

/**
 * PUM's own settings. Model and thinking level are deliberately not here — pi
 * already persists those to <AGENT_DIR>/settings.json via setModel() and
 * setThinkingLevel(), and restores them when the session is created.
 */
export type PumSettings = {
  showThinking: boolean;
  theme: string;
  animations: boolean;
  /** Animation used for the rules while an agent works. */
  workingRuleAnimation: WorkingRuleAnimationMode;
  webSearch: boolean;
  writingStyle: WritingStyle;
  explanationStrength: ExplanationStrength;
  checkMode: boolean;
  checkModel: string;
};

const SETTINGS_PATH = join(AGENT_DIR, "pum.json");
const DEFAULTS: PumSettings = {
  showThinking: false,
  theme: "tokyonight",
  animations: true,
  // Preserve the rule-only behavior used before this setting existed.
  workingRuleAnimation: "input-only",
  webSearch: true,
  writingStyle: "none",
  explanationStrength: "simple",
  checkMode: false,
  checkModel: DEFAULT_CHECK_MODEL,
};

export function normalizeSettings(parsed: unknown): PumSettings {
  const source = parsed && typeof parsed === "object" ? parsed as Partial<PumSettings> : {};
  const merged = { ...DEFAULTS, ...source };
  return {
    ...merged,
    animations: typeof merged.animations === "boolean" ? merged.animations : DEFAULTS.animations,
    workingRuleAnimation: isWorkingRuleAnimationMode(merged.workingRuleAnimation)
      ? merged.workingRuleAnimation
      : DEFAULTS.workingRuleAnimation,
    writingStyle: isWritingStyle(merged.writingStyle) ? merged.writingStyle : DEFAULTS.writingStyle,
    explanationStrength: isExplanationStrength(merged.explanationStrength)
      ? merged.explanationStrength
      : DEFAULTS.explanationStrength,
    checkMode: typeof merged.checkMode === "boolean" ? merged.checkMode : DEFAULTS.checkMode,
    checkModel:
      typeof merged.checkModel === "string" && merged.checkModel.includes("/")
        ? merged.checkModel
        : DEFAULTS.checkModel,
  };
}

export function loadSettings(): PumSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: PumSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

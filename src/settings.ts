import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";
import { DEFAULT_CHECK_MODEL } from "./check-mode";
import { projectStorageKey } from "./platform";
import { isWritingStyle, type WritingStyle } from "./writing-style";
import {
  isExplanationStrength,
  type ExplanationStrength,
} from "./explanation-strength";
import type { SandboxMode } from "./sandbox/types";
import { DEFAULT_BASH_OUTPUT, normalizeBashOutput, type BashOutputSettings } from "./bash-output";
import { DEFAULT_GOAL_RETRY_LIMIT, normalizeGoalRetryLimit } from "./goal";

export const WORKING_RULE_ANIMATION_MODES = ["off", "input-only", "coordinated"] as const;
export type WorkingRuleAnimationMode = (typeof WORKING_RULE_ANIMATION_MODES)[number];
export const OUTPUT_MODES = ["minimal", "default", "detailed"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];
export const CHECK_MODE_PROFILES = ["off", "on"] as const;
export type CheckModeProfile = (typeof CHECK_MODE_PROFILES)[number];

/**
 * Map any stored checkMode value to the current on/off model.
 *
 * Check mode was slimmed from four profiles to a single toggle. "on" runs the
 * former balanced behavior. Legacy strict, balanced, and ask values, and the
 * legacy boolean true, all migrate to "on". off and false migrate to "off".
 */
export function migrateCheckMode(value: unknown): CheckModeProfile {
  if (value === "off" || value === false) return "off";
  if (value === "on" || value === true
    || value === "strict" || value === "balanced" || value === "ask") return "on";
  return "off";
}
export const SANDBOX_MODES = ["auto", "require", "off"] as const;
export const MIN_ACTIVE_SUBAGENTS = 1;
export const MAX_ACTIVE_SUBAGENTS = 25;
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 10;
export const MAX_CHECK_PATHS_PER_PROJECT = 16;

export type CheckPathsByProject = Record<string, string[]>;

export function normalizeCheckPathsByProject(value: unknown): CheckPathsByProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: CheckPathsByProject = {};
  for (const [project, paths] of Object.entries(value)) {
    if (!project || !Array.isArray(paths)) continue;
    const entries = [...new Set(paths.filter((path): path is string =>
      typeof path === "string" && path.length > 0 && !path.includes("\0"),
    ))].slice(0, MAX_CHECK_PATHS_PER_PROJECT);
    if (entries.length > 0) normalized[project] = entries;
  }
  return normalized;
}

export function checkPathsForProject(settings: Pick<PumSettings, "checkPaths">, cwd: string): string[] {
  return [...(settings.checkPaths?.[projectStorageKey(cwd)] ?? [])];
}

export function withCheckPathsForProject(
  settings: PumSettings,
  cwd: string,
  paths: readonly string[],
): PumSettings {
  const key = projectStorageKey(cwd);
  const checkPaths = { ...(settings.checkPaths ?? {}) };
  const normalized = [...new Set(paths)].slice(0, MAX_CHECK_PATHS_PER_PROJECT);
  if (normalized.length > 0) checkPaths[key] = normalized;
  else delete checkPaths[key];
  return { ...settings, checkPaths };
}

export function normalizeMaxActiveSubagents(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_ACTIVE_SUBAGENTS
    && value <= MAX_ACTIVE_SUBAGENTS
    ? value
    : DEFAULT_MAX_ACTIVE_SUBAGENTS;
}

export function isCheckModeProfile(value: unknown): value is CheckModeProfile {
  return CHECK_MODE_PROFILES.includes(value as CheckModeProfile);
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return SANDBOX_MODES.includes(value as SandboxMode);
}

export function isWorkingRuleAnimationMode(value: unknown): value is WorkingRuleAnimationMode {
  return WORKING_RULE_ANIMATION_MODES.includes(value as WorkingRuleAnimationMode);
}

export function isOutputMode(value: unknown): value is OutputMode {
  return OUTPUT_MODES.includes(value as OutputMode);
}

export function normalizeOutputMode(value: unknown): OutputMode {
  return isOutputMode(value) ? value : "default";
}

export function cycleOutputMode(value: unknown, step: number): OutputMode {
  const current = normalizeOutputMode(value);
  const index = OUTPUT_MODES.indexOf(current);
  return OUTPUT_MODES[(index + step % OUTPUT_MODES.length + OUTPUT_MODES.length) % OUTPUT_MODES.length]!;
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
  /** Transcript tool-output detail. Legacy settings omit this field and migrate to default. */
  outputMode?: OutputMode;
  webSearch: boolean;
  writingStyle: WritingStyle;
  explanationStrength: ExplanationStrength;
  checkMode: CheckModeProfile;
  checkModel: string;
  /** OS sandbox enforcement. Legacy settings omit this field and migrate to auto. */
  sandboxMode?: SandboxMode;
  /** Additional canonical directory roots allowed by the filesystem sandbox and Check mode, keyed by launch project. */
  checkPaths?: CheckPathsByProject;
  maxActiveSubagents: number;
  /** Consecutive `incomplete` goal judgments allowed before the goal fails. 0 means no limit. Legacy settings omit this field. */
  goalRetryLimit?: number;
  /** Bash output summarization policy (context-length control). */
  bashOutput?: BashOutputSettings;
};

const SETTINGS_PATH = join(AGENT_DIR, "pum.json");
const DEFAULTS: PumSettings = {
  showThinking: false,
  theme: "tokyonight",
  animations: true,
  // Preserve the rule-only behavior used before this setting existed.
  workingRuleAnimation: "input-only",
  outputMode: "default",
  webSearch: true,
  writingStyle: "none",
  explanationStrength: "simple",
  checkMode: "off",
  checkModel: DEFAULT_CHECK_MODEL,
  sandboxMode: "auto",
  checkPaths: {},
  maxActiveSubagents: DEFAULT_MAX_ACTIVE_SUBAGENTS,
  goalRetryLimit: DEFAULT_GOAL_RETRY_LIMIT,
  bashOutput: { ...DEFAULT_BASH_OUTPUT },
};

export function normalizeSettings(parsed: unknown): PumSettings {
  const source = parsed && typeof parsed === "object" ? parsed as Partial<PumSettings> : {};
  const merged = { ...DEFAULTS, ...source };
  return {
    ...merged,
    showThinking: typeof merged.showThinking === "boolean" ? merged.showThinking : DEFAULTS.showThinking,
    theme: typeof merged.theme === "string" && merged.theme.length > 0 ? merged.theme : DEFAULTS.theme,
    animations: typeof merged.animations === "boolean" ? merged.animations : DEFAULTS.animations,
    webSearch: typeof merged.webSearch === "boolean" ? merged.webSearch : DEFAULTS.webSearch,
    workingRuleAnimation: isWorkingRuleAnimationMode(merged.workingRuleAnimation)
      ? merged.workingRuleAnimation
      : DEFAULTS.workingRuleAnimation,
    outputMode: normalizeOutputMode(merged.outputMode),
    writingStyle: isWritingStyle(merged.writingStyle) ? merged.writingStyle : DEFAULTS.writingStyle,
    explanationStrength: isExplanationStrength(merged.explanationStrength)
      ? merged.explanationStrength
      : DEFAULTS.explanationStrength,
    checkMode: migrateCheckMode(merged.checkMode),
    checkModel:
      typeof merged.checkModel === "string" && merged.checkModel.includes("/")
        ? merged.checkModel
        : DEFAULTS.checkModel,
    sandboxMode: isSandboxMode(merged.sandboxMode) ? merged.sandboxMode : DEFAULTS.sandboxMode,
    checkPaths: normalizeCheckPathsByProject(merged.checkPaths),
    maxActiveSubagents: normalizeMaxActiveSubagents(merged.maxActiveSubagents),
    goalRetryLimit: normalizeGoalRetryLimit(merged.goalRetryLimit),
    bashOutput: normalizeBashOutput(merged.bashOutput),
  };
}

/** Where a corrupt pum.json is kept so the next save cannot destroy it. */
export const CORRUPT_SETTINGS_PATH = `${SETTINGS_PATH}.bad`;

export function loadSettings(): PumSettings {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS_PATH, "utf8");
  } catch {
    // No settings file yet, or it is unreadable — the defaults stand.
    return { ...DEFAULTS };
  }
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // The file exists but does not parse. Keep the bytes beside it, because the
    // next saveSettings would otherwise replace the user's real settings with
    // defaults and leave nothing to recover from. Recovery, never a crash.
    try {
      writeFileSync(CORRUPT_SETTINGS_PATH, raw);
    } catch {
      // A failed backup must not stop PUM from starting.
    }
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: PumSettings): void {
  // Write to a temporary sibling file, then rename into place, so a crash
  // during the write cannot corrupt pum.json. loadSettings keeps its tolerance
  // for a corrupt or missing file, so a leftover temp file never affects it.
  const temporary = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2));
  renameSync(temporary, SETTINGS_PATH);
}

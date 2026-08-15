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

export const WORKING_RULE_ANIMATION_MODES = ["off", "input-only", "coordinated"] as const;
export type WorkingRuleAnimationMode = (typeof WORKING_RULE_ANIMATION_MODES)[number];
export const CHECK_MODE_PROFILES = ["off", "strict", "balanced", "ask"] as const;
export type CheckModeProfile = (typeof CHECK_MODE_PROFILES)[number];
export const SANDBOX_MODES = ["auto", "require", "off"] as const;
export const MIN_ACTIVE_SUBAGENTS = 1;
export const MAX_ACTIVE_SUBAGENTS = 25;
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 10;
export const MIN_TOOL_OUTPUT_LINES = 1;
export const MAX_TOOL_OUTPUT_LINES = 50;
export const DEFAULT_TOOL_OUTPUT_LINES = 5;
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

export function normalizeToolOutputLines(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_TOOL_OUTPUT_LINES
    && value <= MAX_TOOL_OUTPUT_LINES
    ? value
    : DEFAULT_TOOL_OUTPUT_LINES;
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
  checkMode: CheckModeProfile;
  checkModel: string;
  /** OS sandbox enforcement. Legacy settings omit this field and migrate to auto. */
  sandboxMode?: SandboxMode;
  /** Additional canonical directory roots allowed by the filesystem sandbox and Check mode, keyed by launch project. */
  checkPaths?: CheckPathsByProject;
  maxActiveSubagents: number;
  /** Tool-result source lines shown when detailed explanations are enabled. Legacy settings omit this field. */
  toolOutputLines?: number;
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
  checkMode: "off",
  checkModel: DEFAULT_CHECK_MODEL,
  sandboxMode: "auto",
  checkPaths: {},
  maxActiveSubagents: DEFAULT_MAX_ACTIVE_SUBAGENTS,
  toolOutputLines: DEFAULT_TOOL_OUTPUT_LINES,
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
    checkMode: isCheckModeProfile(merged.checkMode)
      ? merged.checkMode
      : merged.checkMode === true
        ? "strict"
        : merged.checkMode === false
          ? "off"
          : DEFAULTS.checkMode,
    checkModel:
      typeof merged.checkModel === "string" && merged.checkModel.includes("/")
        ? merged.checkModel
        : DEFAULTS.checkModel,
    sandboxMode: isSandboxMode(merged.sandboxMode) ? merged.sandboxMode : DEFAULTS.sandboxMode,
    checkPaths: normalizeCheckPathsByProject(merged.checkPaths),
    maxActiveSubagents: normalizeMaxActiveSubagents(merged.maxActiveSubagents),
    toolOutputLines: normalizeToolOutputLines(merged.toolOutputLines),
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
  // Write to a temporary sibling file, then rename into place, so a crash
  // during the write cannot corrupt pum.json. loadSettings keeps its tolerance
  // for a corrupt or missing file, so a leftover temp file never affects it.
  const temporary = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2));
  renameSync(temporary, SETTINGS_PATH);
}

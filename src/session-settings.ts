import { companionFileFor, readCompanion, writeCompanion } from "./session-companion";
import { normalizeSettings, type PumSettings } from "./settings";

/**
 * Settings a session overrides for itself.
 *
 * The Settings popup writes here, not to the global `pum.json`. Trying a theme
 * or a Check mode in one session should not change every other session, and it
 * must never reach into the config directory the sandboxes keep read-only.
 * `s` in the popup is the one deliberate promotion to global.
 */
export type SessionSettings = Partial<PumSettings>;

/** Fields a session may hold. Model and thinking level are pi's, not ours. */
const OVERRIDABLE = [
  "showThinking",
  "theme",
  "animations",
  "workingRuleAnimation",
  "outputMode",
  "webSearch",
  "writingStyle",
  "explanationStrength",
  "checkMode",
  "checkModel",
  "sandboxMode",
  "checkPaths",
  "maxActiveSubagents",
  "goalRetryLimit",
  "bashOutput",
  "jspace",
] as const;

/** Companion file next to the session JSONL: `<session>.settings.json`. */
const SESSION_SETTINGS_SUFFIX = "settings.json";

export function sessionSettingsFileFor(sessionFile: string): string {
  return companionFileFor(sessionFile, SESSION_SETTINGS_SUFFIX);
}

/** Keep only the fields a session owns, so an old or hand-edited file cannot smuggle others in. */
export function pickSessionSettings(value: Record<string, unknown>): SessionSettings {
  const picked: Record<string, unknown> = {};
  for (const key of OVERRIDABLE) {
    if (value[key] !== undefined) picked[key] = value[key];
  }
  return picked as SessionSettings;
}

/**
 * Read a session's overrides. Never throws: a missing, unreadable or corrupt
 * file simply means the session runs on the global settings.
 */
export function loadSessionSettings(sessionFile: string | undefined): SessionSettings {
  const stored = readCompanion(sessionFile, SESSION_SETTINGS_SUFFIX, isSettingsObject, {});
  return pickSessionSettings(stored);
}

const isSettingsObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Persist a session's overrides atomically. A failed write never breaks the session. */
export function saveSessionSettings(
  sessionFile: string | undefined,
  overrides: SessionSettings,
): void {
  const picked = pickSessionSettings(overrides as Record<string, unknown>);
  // An empty overlay is the same as no file, and leaving one behind would put a
  // stub beside every session ever opened.
  writeCompanion(
    sessionFile,
    SESSION_SETTINGS_SUFFIX,
    Object.keys(picked).length === 0 ? null : picked,
  );
}

/**
 * Global settings with a session's overrides laid over them.
 *
 * Normalizing afterwards means a hand-edited companion file gets the same
 * clamping and migration as `pum.json`, rather than a shortcut into the app.
 */
export function mergeSessionSettings(
  global: PumSettings,
  overrides: SessionSettings,
): PumSettings {
  return normalizeSettings({ ...global, ...pickSessionSettings(overrides as Record<string, unknown>) });
}

/** Fields that differ from global, which is exactly what `s` would promote. */
export function sessionSettingsDiff(
  global: PumSettings,
  effective: PumSettings,
): SessionSettings {
  const diff: Record<string, unknown> = {};
  for (const key of OVERRIDABLE) {
    const left = (global as Record<string, unknown>)[key];
    const right = (effective as Record<string, unknown>)[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) diff[key] = right;
  }
  return diff as SessionSettings;
}

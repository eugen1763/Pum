import { join } from "node:path";
import { defaultAgentDir, sessionDirectoryName } from "./platform";

/**
 * PUM keeps its own agent directory instead of sharing pi's `~/.pi/agent`.
 * Everything pi would normally write globally — auth.json, models.json,
 * settings.json, sessions/ — lives here.
 */
export const AGENT_DIR = defaultAgentDir();

export const AUTH_PATH = join(AGENT_DIR, "auth.json");
export const MODELS_PATH = join(AGENT_DIR, "models.json");

/**
 * Known PUM settings files that the authoritative main agent may deliberately
 * edit through Check mode. Credentials (auth.json), models.json key material,
 * and session content never enter this list.
 *
 * settings.json is pi's persisted model state, pum.json is PUM's own settings,
 * and theme.json is the semantic theme override.
 */
export const SETTINGS_FILE_NAMES = ["settings.json", "pum.json", "theme.json"] as const;
export type SettingsFileName = (typeof SETTINGS_FILE_NAMES)[number];

export function isSettingsFileName(name: string): boolean {
  return (SETTINGS_FILE_NAMES as readonly string[]).includes(name);
}

/** Canonical absolute paths of the PUM settings files under the agent directory. */
export function settingsFilePaths(): string[] {
  return SETTINGS_FILE_NAMES.map((name) => join(AGENT_DIR, name));
}

/**
 * Where this directory's sessions live, under PUM's agent dir.
 *
 * SessionManager defaults to `~/.pi/agent/sessions/` when no directory is
 * passed — it ignores `agentDir` — so PUM would otherwise scatter its
 * conversations through pi's own store. The layout mirrors pi's so the files
 * stay readable by `pi --session-dir`.
 */
export function sessionDir(cwd: string): string {
  return join(AGENT_DIR, "sessions", sessionDirectoryName(cwd));
}

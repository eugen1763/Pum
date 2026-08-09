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

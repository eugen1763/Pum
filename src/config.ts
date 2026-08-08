import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * PUM keeps its own agent directory instead of sharing pi's `~/.pi/agent`.
 * Everything pi would normally write globally — auth.json, models.json,
 * settings.json, sessions/ — lives here.
 */
export const AGENT_DIR =
  process.env.PUM_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pum");

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
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(AGENT_DIR, "sessions", safe);
}

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * PUM keeps its own agent directory instead of sharing pi's `~/.pi/agent`.
 * Everything pi would normally write globally — auth.json, models.json,
 * settings.json, sessions/ — lives here.
 */
export const AGENT_DIR =
  process.env.PUM_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pum");

export const AUTH_PATH = join(AGENT_DIR, "auth.json");
export const MODELS_PATH = join(AGENT_DIR, "models.json");

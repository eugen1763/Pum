import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";

/**
 * PUM's own settings. Model and thinking level are deliberately not here — pi
 * already persists those to <AGENT_DIR>/settings.json via setModel() and
 * setThinkingLevel(), and restores them when the session is created.
 */
export type PumSettings = {
  showThinking: boolean;
  theme: string;
  animations: boolean;
};

const SETTINGS_PATH = join(AGENT_DIR, "pum.json");
const DEFAULTS: PumSettings = { showThinking: false, theme: "tokyonight", animations: true };

export function loadSettings(): PumSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: PumSettings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

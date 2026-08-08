import { RGBA, parseColor } from "@opentui/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config";

export type Theme = {
  name: string;
  bg: string;
  fg: string;
  dim: string;
  accent: string;
  border: string;
  /** Foreground and background of a user turn's full-width bar. */
  user: string;
  userBg: string;
  assistant: string;
  thinking: string;
  tool: string;
  toolArg: string;
  success: string;
  error: string;
  warn: string;
  selectionBg: string;
  popupBg: string;
  /** The bright colour a shimmer sweeps toward. */
  highlight: string;
  /** Syntax colours for markdown code blocks. */
  codeKeyword: string;
  codeString: string;
  codeNumber: string;
  codeComment: string;
  codeFunction: string;
  codeType: string;
};

const tokyonight: Theme = {
  name: "tokyonight",
  bg: "#1a1b26",
  fg: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  border: "#292e42",
  user: "#c0caf5",
  userBg: "#283457",
  assistant: "#c0caf5",
  thinking: "#565f89",
  tool: "#e0af68",
  toolArg: "#9ece6a",
  success: "#9ece6a",
  error: "#f7768e",
  warn: "#ff9e64",
  selectionBg: "#33467c",
  popupBg: "#1f2335",
  highlight: "#ffffff",
  codeKeyword: "#bb9af7",
  codeString: "#9ece6a",
  codeNumber: "#ff9e64",
  codeComment: "#565f89",
  codeFunction: "#7aa2f7",
  codeType: "#2ac3de",
};

const gruvbox: Theme = {
  name: "gruvbox",
  bg: "#282828",
  fg: "#ebdbb2",
  dim: "#928374",
  accent: "#83a598",
  border: "#3c3836",
  user: "#ebdbb2",
  userBg: "#3c3836",
  assistant: "#ebdbb2",
  thinking: "#928374",
  tool: "#fabd2f",
  toolArg: "#b8bb26",
  success: "#b8bb26",
  error: "#fb4934",
  warn: "#fe8019",
  selectionBg: "#504945",
  popupBg: "#32302f",
  highlight: "#fbf1c7",
  codeKeyword: "#fb4934",
  codeString: "#b8bb26",
  codeNumber: "#d3869b",
  codeComment: "#928374",
  codeFunction: "#fabd2f",
  codeType: "#8ec07c",
};

const catppuccin: Theme = {
  name: "catppuccin",
  bg: "#1e1e2e",
  fg: "#cdd6f4",
  dim: "#6c7086",
  accent: "#89b4fa",
  border: "#313244",
  user: "#cdd6f4",
  userBg: "#313244",
  assistant: "#cdd6f4",
  thinking: "#6c7086",
  tool: "#f9e2af",
  toolArg: "#a6e3a1",
  success: "#a6e3a1",
  error: "#f38ba8",
  warn: "#fab387",
  selectionBg: "#45475a",
  popupBg: "#181825",
  highlight: "#f5e0dc",
  codeKeyword: "#cba6f7",
  codeString: "#a6e3a1",
  codeNumber: "#fab387",
  codeComment: "#6c7086",
  codeFunction: "#89b4fa",
  codeType: "#f9e2af",
};

export const PRESETS: Record<string, Theme> = { tokyonight, gruvbox, catppuccin };
export const PRESET_NAMES = Object.keys(PRESETS);

const THEME_PATH = join(AGENT_DIR, "theme.json");

/**
 * A preset, with <AGENT_DIR>/theme.json merged over it. The file may set any
 * subset of tokens; unknown keys are ignored and a bad file is ignored whole.
 */
export function loadTheme(name: string): Theme {
  const base = PRESETS[name] ?? tokyonight;
  let override: Partial<Theme> = {};
  try {
    override = JSON.parse(readFileSync(THEME_PATH, "utf8"));
  } catch {
    // no file, or unreadable — the preset stands on its own
  }
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof Theme)[]) {
    const value = override[key];
    if (typeof value === "string") merged[key] = value;
  }
  merged.name = base.name;
  return merged;
}

/** @opentui/core exports RGBA and parseColor but no interpolation helper. */
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
    1,
  );
}

export const rgba = (color: string): RGBA => parseColor(color);

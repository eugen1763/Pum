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
  /** Foreground for the current working directory in the status bar. */
  statusCwd: string;
  /** Foreground of the goal label painted on the input-top rule. */
  goalLabel: string;
  border: string;
  /** Foreground and background of a user turn's full-width bar. */
  user: string;
  userBg: string;
  /** Foreground and background for inter-agent communication rows. */
  agentMessage: string;
  agentMessageBg: string;
  assistant: string;
  thinking: string;
  tool: string;
  toolArg: string;
  /** Dark gray foreground for output streamed by a running Bash tool. */
  bashOutput: string;
  /** Blue and dark gray outcome colours in the session statistics popup. */
  statsRunning: string;
  statsInterrupted: string;
  success: string;
  error: string;
  warn: string;
  /** Orange foreground and existing background for tool calls blocked before execution. */
  rejection: string;
  rejectionBg: string;
  selectionBg: string;
  popupBg: string;
  /** Colour for the clipped one-cell popup shadow. */
  popupShadow: string;
  /** The bright colour a shimmer sweeps toward. */
  highlight: string;
  /** Syntax colours for markdown code blocks. */
  codeKeyword: string;
  codeString: string;
  codeNumber: string;
  codeComment: string;
  codeFunction: string;
  codeType: string;
  /** Backgrounds for added and removed rows in transcript diff previews. */
  diffAddedBg: string;
  diffRemovedBg: string;
};

const tokyonight: Theme = {
  name: "tokyonight",
  bg: "#1a1b26",
  fg: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  statusCwd: "#2ac3de",
  goalLabel: "#c0caf5",
  border: "#292e42",
  user: "#c0caf5",
  userBg: "#283457",
  agentMessage: "#bb9af7",
  agentMessageBg: "#2b234a",
  assistant: "#c0caf5",
  thinking: "#565f89",
  tool: "#e0af68",
  toolArg: "#9ece6a",
  bashOutput: "#565f89",
  statsRunning: "#7aa2f7",
  statsInterrupted: "#565f89",
  success: "#9ece6a",
  error: "#f7768e",
  warn: "#ff9e64",
  rejection: "#ff9e64",
  rejectionBg: "#332b24",
  selectionBg: "#33467c",
  popupBg: "#1f2335",
  popupShadow: "#10131f",
  highlight: "#ffffff",
  codeKeyword: "#bb9af7",
  codeString: "#9ece6a",
  codeNumber: "#ff9e64",
  codeComment: "#565f89",
  codeFunction: "#7aa2f7",
  codeType: "#2ac3de",
  diffAddedBg: "#233b32",
  diffRemovedBg: "#3b2630",
};

const gruvbox: Theme = {
  name: "gruvbox",
  bg: "#282828",
  fg: "#ebdbb2",
  dim: "#928374",
  accent: "#83a598",
  statusCwd: "#8ec07c",
  goalLabel: "#ebdbb2",
  border: "#3c3836",
  user: "#ebdbb2",
  userBg: "#3c3836",
  agentMessage: "#d3869b",
  agentMessageBg: "#4a3346",
  assistant: "#ebdbb2",
  thinking: "#928374",
  tool: "#fabd2f",
  toolArg: "#b8bb26",
  bashOutput: "#928374",
  statsRunning: "#83a598",
  statsInterrupted: "#928374",
  success: "#b8bb26",
  error: "#fb4934",
  warn: "#fe8019",
  rejection: "#fe8019",
  rejectionBg: "#3c3836",
  selectionBg: "#504945",
  popupBg: "#32302f",
  popupShadow: "#1d1b1a",
  highlight: "#fbf1c7",
  codeKeyword: "#fb4934",
  codeString: "#b8bb26",
  codeNumber: "#d3869b",
  codeComment: "#928374",
  codeFunction: "#fabd2f",
  codeType: "#8ec07c",
  diffAddedBg: "#323b2c",
  diffRemovedBg: "#442e2b",
};

const catppuccin: Theme = {
  name: "catppuccin",
  bg: "#1e1e2e",
  fg: "#cdd6f4",
  dim: "#6c7086",
  accent: "#89b4fa",
  statusCwd: "#94e2d5",
  goalLabel: "#cdd6f4",
  border: "#313244",
  user: "#cdd6f4",
  userBg: "#313244",
  agentMessage: "#cba6f7",
  agentMessageBg: "#3b3156",
  assistant: "#cdd6f4",
  thinking: "#6c7086",
  tool: "#f9e2af",
  toolArg: "#a6e3a1",
  bashOutput: "#6c7086",
  statsRunning: "#89b4fa",
  statsInterrupted: "#6c7086",
  success: "#a6e3a1",
  error: "#f38ba8",
  warn: "#fab387",
  rejection: "#fab387",
  rejectionBg: "#3b342f",
  selectionBg: "#45475a",
  popupBg: "#181825",
  popupShadow: "#101019",
  highlight: "#f5e0dc",
  codeKeyword: "#cba6f7",
  codeString: "#a6e3a1",
  codeNumber: "#fab387",
  codeComment: "#6c7086",
  codeFunction: "#89b4fa",
  codeType: "#f9e2af",
  diffAddedBg: "#263a32",
  diffRemovedBg: "#402c35",
};

const nord: Theme = {
  name: "nord",
  bg: "#2e3440",
  fg: "#d8dee9",
  dim: "#7b88a1",
  accent: "#88c0d0",
  statusCwd: "#8fbcbb",
  goalLabel: "#eceff4",
  border: "#3b4252",
  user: "#eceff4",
  userBg: "#434c5e",
  agentMessage: "#b48ead",
  agentMessageBg: "#453b53",
  assistant: "#d8dee9",
  thinking: "#7b88a1",
  tool: "#ebcb8b",
  toolArg: "#a3be8c",
  bashOutput: "#616e88",
  statsRunning: "#81a1c1",
  statsInterrupted: "#616e88",
  success: "#a3be8c",
  error: "#bf616a",
  warn: "#d08770",
  rejection: "#d08770",
  rejectionBg: "#3b3b3b",
  selectionBg: "#4c566a",
  popupBg: "#3b4252",
  popupShadow: "#20242d",
  highlight: "#eceff4",
  codeKeyword: "#b48ead",
  codeString: "#a3be8c",
  codeNumber: "#d08770",
  codeComment: "#616e88",
  codeFunction: "#88c0d0",
  codeType: "#8fbcbb",
  diffAddedBg: "#35443d",
  diffRemovedBg: "#49383e",
};

const dracula: Theme = {
  name: "dracula",
  bg: "#282a36",
  fg: "#f8f8f2",
  dim: "#6272a4",
  accent: "#bd93f9",
  statusCwd: "#8be9fd",
  goalLabel: "#f8f8f2",
  border: "#44475a",
  user: "#f8f8f2",
  userBg: "#44475a",
  agentMessage: "#ff79c6",
  agentMessageBg: "#4a304d",
  assistant: "#f8f8f2",
  thinking: "#6272a4",
  tool: "#f1fa8c",
  toolArg: "#50fa7b",
  bashOutput: "#6272a4",
  statsRunning: "#8be9fd",
  statsInterrupted: "#6272a4",
  success: "#50fa7b",
  error: "#ff5555",
  warn: "#ffb86c",
  rejection: "#ffb86c",
  rejectionBg: "#3d3f36",
  selectionBg: "#44475a",
  popupBg: "#21222c",
  popupShadow: "#15161d",
  highlight: "#ffffff",
  codeKeyword: "#ff79c6",
  codeString: "#f1fa8c",
  codeNumber: "#bd93f9",
  codeComment: "#6272a4",
  codeFunction: "#50fa7b",
  codeType: "#8be9fd",
  diffAddedBg: "#294134",
  diffRemovedBg: "#493139",
};

const rosepine: Theme = {
  name: "rosepine",
  bg: "#191724",
  fg: "#e0def4",
  dim: "#6e6a86",
  accent: "#c4a7e7",
  statusCwd: "#9ccfd8",
  goalLabel: "#e0def4",
  border: "#26233a",
  user: "#e0def4",
  userBg: "#26233a",
  agentMessage: "#c4a7e7",
  agentMessageBg: "#302940",
  assistant: "#e0def4",
  thinking: "#6e6a86",
  tool: "#f6c177",
  toolArg: "#9ccfd8",
  bashOutput: "#6e6a86",
  statsRunning: "#31748f",
  statsInterrupted: "#6e6a86",
  success: "#31748f",
  error: "#eb6f92",
  warn: "#f6c177",
  rejection: "#f6c177",
  rejectionBg: "#393029",
  selectionBg: "#403d52",
  popupBg: "#1f1d2e",
  popupShadow: "#11101a",
  highlight: "#fffaf3",
  codeKeyword: "#c4a7e7",
  codeString: "#9ccfd8",
  codeNumber: "#ebbcba",
  codeComment: "#6e6a86",
  codeFunction: "#31748f",
  codeType: "#f6c177",
  diffAddedBg: "#263a3a",
  diffRemovedBg: "#3d2b37",
};

const solarized: Theme = {
  name: "solarized",
  bg: "#002b36",
  fg: "#839496",
  dim: "#586e75",
  accent: "#268bd2",
  statusCwd: "#2aa198",
  goalLabel: "#93a1a1",
  border: "#073642",
  user: "#93a1a1",
  userBg: "#073642",
  agentMessage: "#6c71c4",
  agentMessageBg: "#173b4a",
  assistant: "#93a1a1",
  thinking: "#586e75",
  tool: "#b58900",
  toolArg: "#859900",
  bashOutput: "#586e75",
  statsRunning: "#268bd2",
  statsInterrupted: "#586e75",
  success: "#859900",
  error: "#dc322f",
  warn: "#cb4b16",
  rejection: "#cb4b16",
  rejectionBg: "#343b35",
  selectionBg: "#0b4b59",
  popupBg: "#073642",
  popupShadow: "#001f27",
  highlight: "#fdf6e3",
  codeKeyword: "#6c71c4",
  codeString: "#859900",
  codeNumber: "#d33682",
  codeComment: "#586e75",
  codeFunction: "#268bd2",
  codeType: "#2aa198",
  diffAddedBg: "#123c37",
  diffRemovedBg: "#443239",
};

const kanagawa: Theme = {
  name: "kanagawa",
  bg: "#1f1f28",
  fg: "#dcd7ba",
  dim: "#727169",
  accent: "#7e9cd8",
  statusCwd: "#7fb4ca",
  goalLabel: "#dcd7ba",
  border: "#2a2a37",
  user: "#dcd7ba",
  userBg: "#2d4f67",
  agentMessage: "#957fb8",
  agentMessageBg: "#3a3048",
  assistant: "#dcd7ba",
  thinking: "#727169",
  tool: "#e6c384",
  toolArg: "#98bb6c",
  bashOutput: "#727169",
  statsRunning: "#7e9cd8",
  statsInterrupted: "#727169",
  success: "#98bb6c",
  error: "#e46876",
  warn: "#ffa066",
  rejection: "#ffa066",
  rejectionBg: "#39352d",
  selectionBg: "#2d4f67",
  popupBg: "#16161d",
  popupShadow: "#0c0c11",
  highlight: "#c8c093",
  codeKeyword: "#957fb8",
  codeString: "#98bb6c",
  codeNumber: "#d27e99",
  codeComment: "#727169",
  codeFunction: "#7e9cd8",
  codeType: "#7fb4ca",
  diffAddedBg: "#293b32",
  diffRemovedBg: "#412e34",
};

const githubLight: Theme = {
  name: "github-light",
  bg: "#ffffff",
  fg: "#24292f",
  dim: "#6e7781",
  accent: "#0969da",
  statusCwd: "#0a3069",
  goalLabel: "#24292f",
  border: "#d0d7de",
  user: "#24292f",
  userBg: "#ddf4ff",
  agentMessage: "#8250df",
  agentMessageBg: "#f3e8ff",
  assistant: "#24292f",
  thinking: "#6e7781",
  tool: "#9a6700",
  toolArg: "#1a7f37",
  bashOutput: "#57606a",
  statsRunning: "#0969da",
  statsInterrupted: "#57606a",
  success: "#1a7f37",
  error: "#cf222e",
  warn: "#bc4c00",
  rejection: "#bc4c00",
  rejectionBg: "#fff1c2",
  selectionBg: "#b6d7ff",
  popupBg: "#f6f8fa",
  popupShadow: "#8c959f",
  highlight: "#000000",
  codeKeyword: "#cf222e",
  codeString: "#0a3069",
  codeNumber: "#0550ae",
  codeComment: "#6e7781",
  codeFunction: "#8250df",
  codeType: "#953800",
  diffAddedBg: "#dafbe1",
  diffRemovedBg: "#ffebe9",
};

export const PRESETS: Record<string, Theme> = {
  tokyonight,
  gruvbox,
  catppuccin,
  nord,
  dracula,
  rosepine,
  solarized,
  kanagawa,
  "github-light": githubLight,
};
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
    const parsed: unknown = JSON.parse(readFileSync(THEME_PATH, "utf8"));
    // JSON.parse also succeeds for null, arrays, strings and numbers. Only a
    // plain object can carry tokens, so every other shape is a bad file and is
    // ignored whole rather than crashing the merge below.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      override = parsed as Partial<Theme>;
    }
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

/**
 * `/settings` — read and change any pum.json setting from the prompt.
 *
 * The Settings popup owns the same values, but a popup row cannot be scripted,
 * pasted, or recalled from history. This module is the text front end for the
 * identical state, so it stays pure: it maps a name to a spec, parses a value,
 * and returns the next settings plus the line to print. The caller decides
 * whether the change lands in the session or in the global file, and `/check-path`
 * keeps its own async path validation.
 */

import {
  BASH_CUT_STRATEGIES,
  DEFAULT_BASH_OUTPUT,
  type BashOutputSettings,
} from "./bash-output";
import type { CheckPathCommand } from "./check-paths";
import { EXPLANATION_STRENGTHS } from "./explanation-strength";
import { MAX_GOAL_RETRY_LIMIT, MIN_GOAL_RETRY_LIMIT, normalizeGoalRetryLimit } from "./goal";
import {
  CHECK_MODE_PROFILES,
  MAX_ACTIVE_SUBAGENTS,
  MIN_ACTIVE_SUBAGENTS,
  OUTPUT_MODES,
  SANDBOX_MODES,
  WORKING_RULE_ANIMATION_MODES,
  type PumSettings,
} from "./settings";
import { PRESET_NAMES } from "./theme";
import { WRITING_STYLES } from "./writing-style";

export type SettingKind = "boolean" | "enum" | "int" | "paths";

export type SettingSpec = {
  /** Canonical name, exactly as the key reads in pum.json. */
  key: string;
  /** The Settings popup label, or "" for a setting the popup does not show. */
  label: string;
  /** The pum.json field a change patches, so the caller can build a narrow patch. */
  topKey: keyof PumSettings;
  kind: SettingKind;
  values?: readonly string[];
  min?: number;
  max?: number;
  read(settings: PumSettings): string;
  /** Absent only for `checkPaths`, which /check-path owns. */
  write?(settings: PumSettings, value: string): PumSettings;
};

const BOOLEAN_TRUE = ["on", "true", "yes", "1"];
const BOOLEAN_FALSE = ["off", "false", "no", "0"];

function booleanValue(spec: SettingSpec, raw: string): boolean {
  const value = raw.toLocaleLowerCase();
  if (BOOLEAN_TRUE.includes(value)) return true;
  if (BOOLEAN_FALSE.includes(value)) return false;
  throw new Error(`${spec.key} accepts on or off, not "${raw}"`);
}

function enumValue(spec: SettingSpec, raw: string): string {
  const value = raw.toLocaleLowerCase();
  const match = (spec.values ?? []).find((candidate) => candidate.toLocaleLowerCase() === value);
  if (!match) {
    throw new Error(`unknown value "${raw}" for ${spec.key} (${(spec.values ?? []).join(", ")})`);
  }
  return match;
}

function intValue(spec: SettingSpec, raw: string): number {
  const value = Number(raw);
  if (!/^-?\d+$/.test(raw.trim()) || !Number.isInteger(value)) {
    throw new Error(`${spec.key} accepts a whole number, not "${raw}"`);
  }
  if (value < (spec.min ?? 0) || value > (spec.max ?? 0)) {
    throw new Error(`${spec.key} accepts ${spec.min}-${spec.max}, not ${value}`);
  }
  return value;
}

function boolSpec(
  key: keyof PumSettings & string,
  label: string,
  read: (settings: PumSettings) => boolean,
  write: (settings: PumSettings, value: boolean) => PumSettings,
): SettingSpec {
  const spec: SettingSpec = {
    key,
    label,
    topKey: key,
    kind: "boolean",
    read: (settings) => (read(settings) ? "on" : "off"),
    write: (settings, raw) => write(settings, booleanValue(spec, raw)),
  };
  return spec;
}

function enumSpec(
  key: keyof PumSettings & string,
  label: string,
  values: readonly string[],
  read: (settings: PumSettings) => string,
  write: (settings: PumSettings, value: string) => PumSettings,
): SettingSpec {
  const spec: SettingSpec = {
    key,
    label,
    topKey: key,
    kind: "enum",
    values,
    read,
    write: (settings, raw) => write(settings, enumValue(spec, raw)),
  };
  return spec;
}

function intSpec(
  key: keyof PumSettings & string,
  label: string,
  min: number,
  max: number,
  read: (settings: PumSettings) => number,
  write: (settings: PumSettings, value: number) => PumSettings,
): SettingSpec {
  const spec: SettingSpec = {
    key,
    label,
    topKey: key,
    kind: "int",
    min,
    max,
    read: (settings) => String(read(settings)),
    write: (settings, raw) => write(settings, intValue(spec, raw)),
  };
  return spec;
}

function bashOutputOf(settings: PumSettings): BashOutputSettings {
  return settings.bashOutput ?? { ...DEFAULT_BASH_OUTPUT };
}

function withBashOutput(settings: PumSettings, patch: Partial<BashOutputSettings>): PumSettings {
  return { ...settings, bashOutput: { ...bashOutputOf(settings), ...patch } };
}

function bashBoolSpec(name: keyof BashOutputSettings): SettingSpec {
  const spec: SettingSpec = {
    key: `bashOutput.${name}`,
    label: "",
    topKey: "bashOutput",
    kind: "boolean",
    read: (settings) => (bashOutputOf(settings)[name] ? "on" : "off"),
    write: (settings, raw) => withBashOutput(settings, { [name]: booleanValue(spec, raw) }),
  };
  return spec;
}

function bashIntSpec(name: keyof BashOutputSettings, min: number, max: number): SettingSpec {
  const spec: SettingSpec = {
    key: `bashOutput.${name}`,
    label: "",
    topKey: "bashOutput",
    kind: "int",
    min,
    max,
    read: (settings) => String(bashOutputOf(settings)[name]),
    write: (settings, raw) => withBashOutput(settings, { [name]: intValue(spec, raw) }),
  };
  return spec;
}

function bashStrategySpec(): SettingSpec {
  const spec: SettingSpec = {
    key: "bashOutput.strategy",
    label: "",
    topKey: "bashOutput",
    kind: "enum",
    values: BASH_CUT_STRATEGIES,
    read: (settings) => bashOutputOf(settings).strategy,
    write: (settings, raw) => withBashOutput(settings, {
      strategy: enumValue(spec, raw) as BashOutputSettings["strategy"],
    }),
  };
  return spec;
}

/**
 * Every pum.json key, in the order the Settings popup groups them, with the
 * advanced bashOutput block last. Model, thinking level, and provider logins
 * are pi's settings.json and auth.json, not ours, so they are absent here.
 */
export const SETTING_SPECS: readonly SettingSpec[] = [
  enumSpec("theme", "Theme", PRESET_NAMES,
    (s) => s.theme,
    (s, value) => ({ ...s, theme: value })),
  boolSpec("animations", "Animations",
    (s) => s.animations,
    (s, value) => ({ ...s, animations: value })),
  enumSpec("workingRuleAnimation", "Working animation", WORKING_RULE_ANIMATION_MODES,
    (s) => s.workingRuleAnimation,
    (s, value) => ({ ...s, workingRuleAnimation: value as PumSettings["workingRuleAnimation"] })),
  enumSpec("outputMode", "Transcript detail", OUTPUT_MODES,
    (s) => s.outputMode ?? "normal",
    (s, value) => ({ ...s, outputMode: value as PumSettings["outputMode"] })),
  boolSpec("showAgentMessages", "Agent messages",
    (s) => s.showAgentMessages !== false,
    (s, value) => ({ ...s, showAgentMessages: value })),
  boolSpec("showThinking", "Thinking traces",
    (s) => s.showThinking,
    (s, value) => ({ ...s, showThinking: value })),
  boolSpec("webSearch", "Web search",
    (s) => s.webSearch,
    (s, value) => ({ ...s, webSearch: value })),
  enumSpec("writingStyle", "Writing style", WRITING_STYLES,
    (s) => s.writingStyle,
    (s, value) => ({ ...s, writingStyle: value as PumSettings["writingStyle"] })),
  enumSpec("explanationStrength", "Progress narration", EXPLANATION_STRENGTHS,
    (s) => s.explanationStrength,
    (s, value) => ({ ...s, explanationStrength: value as PumSettings["explanationStrength"] })),
  intSpec("maxActiveSubagents", "Active subagents", MIN_ACTIVE_SUBAGENTS, MAX_ACTIVE_SUBAGENTS,
    (s) => s.maxActiveSubagents,
    (s, value) => ({ ...s, maxActiveSubagents: value })),
  intSpec("goalRetryLimit", "Goal retries", MIN_GOAL_RETRY_LIMIT, MAX_GOAL_RETRY_LIMIT,
    (s) => normalizeGoalRetryLimit(s.goalRetryLimit),
    (s, value) => ({ ...s, goalRetryLimit: value })),
  enumSpec("checkMode", "Check mode", CHECK_MODE_PROFILES,
    (s) => s.checkMode,
    (s, value) => ({ ...s, checkMode: value as PumSettings["checkMode"] })),
  enumSpec("sandboxMode", "Sandbox", SANDBOX_MODES,
    (s) => s.sandboxMode ?? "auto",
    (s, value) => ({ ...s, sandboxMode: value as PumSettings["sandboxMode"] })),
  {
    // A model id is free text, so the popup's picker stays the discoverable
    // route. Typing a known id here is still faster than opening two panels.
    key: "checkModel",
    label: "Check model",
    topKey: "checkModel",
    kind: "enum",
    read: (s) => s.checkModel,
    write: (s, raw) => {
      if (!raw.includes("/")) throw new Error(`checkModel needs a provider/model id, not "${raw}"`);
      return { ...s, checkModel: raw };
    },
  },
  {
    key: "checkPaths",
    label: "Allowed paths",
    topKey: "checkPaths",
    kind: "paths",
    read: () => "",
  },
  bashBoolSpec("enabled"),
  bashStrategySpec(),
  bashIntSpec("maxBytes", 256, 50 * 1024),
  bashIntSpec("headLines", 1, 500),
  bashIntSpec("tailLines", 1, 500),
  bashIntSpec("sampleCount", 1, 200),
  bashBoolSpec("filterAnsi"),
  bashBoolSpec("dropNoise"),
  bashBoolSpec("compressRepeats"),
  bashBoolSpec("collapseSimilar"),
  bashBoolSpec("keepImportant"),
  bashBoolSpec("tailOnError"),
  bashBoolSpec("alwaysShowMarker"),
];

/** Accepted values, for the show line and for a rejected value. */
export function acceptedValues(spec: SettingSpec): string {
  if (spec.kind === "boolean") return "on, off";
  if (spec.kind === "int") return `${spec.min}-${spec.max}`;
  if (spec.kind === "paths") return "list, add <directory>, remove <directory>, clear";
  return spec.values ? spec.values.join(", ") : "a provider/model id";
}

/**
 * Names differ only in the shape a person types them: the pum.json key, the
 * popup label, or either one with spaces, hyphens, or underscores between the
 * words. Case never distinguishes two settings, so it never blocks a match.
 */
function normalizeName(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_-]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = a[i - 1] === b[j - 1]
        ? previous
        : 1 + Math.min(previous, row[j]!, row[j - 1]!);
      previous = current;
    }
  }
  return row[b.length]!;
}

export function findSettingSpec(name: string): SettingSpec | undefined {
  const wanted = normalizeName(name);
  return SETTING_SPECS.find((spec) => normalizeName(spec.key) === wanted
    || (spec.label !== "" && normalizeName(spec.label) === wanted));
}

/** Up to three plausible names for an unknown one, so the error can teach. */
export function nearSettingNames(name: string): string[] {
  const wanted = normalizeName(name);
  return SETTING_SPECS
    .map((spec) => ({
      key: spec.key,
      distance: Math.min(
        editDistance(wanted, normalizeName(spec.key)),
        spec.label === "" ? Number.MAX_SAFE_INTEGER : editDistance(wanted, normalizeName(spec.label)),
      ),
      prefixed: normalizeName(spec.key).startsWith(wanted) && wanted.length >= 2,
    }))
    .filter((candidate) => candidate.prefixed || candidate.distance <= 3)
    .sort((a, b) => (a.prefixed === b.prefixed ? a.distance - b.distance : a.prefixed ? -1 : 1))
    .slice(0, 3)
    .map((candidate) => candidate.key);
}

export type SettingsToken = { value: string; start: number; end: number; quoted: boolean };

/**
 * Split on whitespace, but keep a quoted run together so a popup label such as
 * "check mode" survives as one name. Offsets are kept because the completion
 * source replaces exactly the token under the cursor.
 */
export function tokenizeSettingsInput(input: string): SettingsToken[] {
  const tokens: SettingsToken[] = [];
  let index = 0;
  while (index < input.length) {
    if (/\s/.test(input[index]!)) {
      index++;
      continue;
    }
    const quote = input[index] === "\"" || input[index] === "'" ? input[index]! : null;
    const start = index;
    if (quote) {
      index++;
      const contentStart = index;
      while (index < input.length && input[index] !== quote) index++;
      tokens.push({
        value: input.slice(contentStart, index),
        start,
        end: index < input.length ? index + 1 : index,
        quoted: true,
      });
      if (index < input.length) index++;
      continue;
    }
    while (index < input.length && !/\s/.test(input[index]!)) index++;
    tokens.push({ value: input.slice(start, index), start, end: index, quoted: false });
  }
  return tokens;
}

export const SETTINGS_COMMAND_NAME = "/settings";
export const GLOBAL_FLAG = "--global";

export type SettingsCommand =
  | { action: "list" }
  | { action: "show"; spec: SettingSpec }
  | { action: "set"; spec: SettingSpec; value: string; global: boolean }
  | { action: "checkPaths"; command: CheckPathCommand; global: boolean };

/** Returns undefined when the input is not a /settings command at all. */
export function parseSettingsCommand(input: string): SettingsCommand | undefined {
  const trimmed = input.trim().replace(/^\/theme(?=\s|$)/, "/settings theme");
  if (!/^\/settings(?:\s|$)/.test(trimmed)) return undefined;

  const tokens = tokenizeSettingsInput(trimmed).slice(1);
  const global = tokens.some((token) => !token.quoted && token.value === GLOBAL_FLAG);
  const rest = tokens.filter((token) => token.quoted || token.value !== GLOBAL_FLAG);
  if (rest.length === 0) return { action: "list" };

  const name = rest[0]!.value;
  const spec = findSettingSpec(name);
  if (!spec) {
    const near = nearSettingNames(name);
    throw new Error(`unknown setting "${name}"${near.length ? ` — did you mean: ${near.join(", ")}?` : ""}`);
  }

  const values = rest.slice(1).map((token) => token.value);
  if (spec.kind === "paths") {
    const [action, ...pathParts] = values;
    if (!action || action === "list") return { action: "checkPaths", command: { action: "list" }, global };
    if (action === "clear") return { action: "checkPaths", command: { action: "clear" }, global };
    if (action !== "add" && action !== "remove") {
      throw new Error("checkPaths accepts list, add <directory>, remove <directory>, or clear");
    }
    const path = pathParts.join(" ");
    if (!path || path.includes("\0")) throw new Error("Check path is invalid");
    return { action: "checkPaths", command: { action, path }, global };
  }

  if (values.length === 0) return { action: "show", spec };
  return { action: "set", spec, value: values.join(" "), global };
}

export type SettingsScope = "session" | "global";

export function settingScope(
  spec: SettingSpec,
  sessionOverrides: Partial<PumSettings>,
): SettingsScope {
  return spec.topKey in sessionOverrides ? "session" : "global";
}

export function showSettingMessage(
  spec: SettingSpec,
  settings: PumSettings,
  sessionOverrides: Partial<PumSettings>,
  checkPaths: readonly string[] = [],
): string {
  const scope = settingScope(spec, sessionOverrides);
  if (spec.kind === "paths") {
    const list = checkPaths.length > 0
      ? checkPaths.map((path) => `  ${path}`).join("\n")
      : "  none";
    return `${spec.key}: ${checkPaths.length} additional root${checkPaths.length === 1 ? "" : "s"} (${scope})\n${list}\naccepted: ${acceptedValues(spec)}`;
  }
  return `${spec.key}: ${spec.read(settings)} (${scope})\naccepted: ${acceptedValues(spec)}`;
}

export function listSettingsMessage(
  settings: PumSettings,
  sessionOverrides: Partial<PumSettings>,
  checkPathCount: number,
): string {
  const width = SETTING_SPECS.reduce((widest, spec) => Math.max(widest, spec.key.length), 0);
  const lines = SETTING_SPECS.map((spec) => {
    const value = spec.kind === "paths"
      ? `${checkPathCount} additional root${checkPathCount === 1 ? "" : "s"}`
      : spec.read(settings);
    const marker = settingScope(spec, sessionOverrides) === "session" ? "  (session)" : "";
    return `  ${spec.key.padEnd(width)}  ${value}${marker}`;
  });
  return `pum.json settings:\n${lines.join("\n")}\nchange one with /settings <name> <value> [${GLOBAL_FLAG}]`;
}

/** Applies a `set`. The caller patches only `spec.topKey` from the result. */
export function applySettingChange(
  settings: PumSettings,
  spec: SettingSpec,
  value: string,
): { settings: PumSettings; message: string } {
  if (!spec.write) throw new Error(`${spec.key} cannot be set directly`);
  const before = spec.read(settings);
  const next = spec.write(settings, value);
  const after = spec.read(next);
  return {
    settings: next,
    message: before === after
      ? `${spec.key}: already ${after}`
      : `${spec.key}: ${before} › ${after}`,
  };
}

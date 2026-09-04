import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./settings-popup";
import type { SettingsCompletion } from "./settings-autocomplete";

export const modelReference = (model: Model<any>): string => `${model.provider}/${model.id}`;

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Exact identities win over display labels. Never pick the first ambiguous match. */
export function matchCommandModel(value: string, models: readonly Model<any>[]): Model<any> | undefined {
  const query = unquote(value.trim()).toLowerCase();
  const refs = models.filter((model) => modelReference(model).toLowerCase() === query);
  const matches = refs.length ? refs : models.filter((model) =>
    model.id.toLowerCase() === query || model.name?.toLowerCase() === query);
  if (matches.length > 1) {
    throw new Error(`Ambiguous model: ${value}. Use one of: ${matches.map(modelReference).join(", ")}`);
  }
  return matches[0];
}

export function validateEffort(value: string, model: Model<any> | undefined): ThinkingLevel {
  const levels = model ? getSupportedThinkingLevels(model) : ["off"] as ThinkingLevel[];
  const effort = value.toLowerCase() as ThinkingLevel;
  if (!levels.includes(effort)) {
    throw new Error(`Unsupported effort: ${value}. Supported efforts: ${levels.join(", ")}`);
  }
  return effort;
}

export function parseModelSelection(value: string, models: readonly Model<any>[]): { model: Model<any>; effort?: ThinkingLevel } {
  const text = value.trim();
  const exact = matchCommandModel(text, models);
  if (exact) return { model: exact };
  // Resolve the complete name first: display names can contain spaces, including
  // words that also name an effort. Otherwise the last word is the effort.
  const split = /^(.*\S)\s+(\S+)$/.exec(text);
  if (split) {
    const model = matchCommandModel(split[1]!, models);
    if (model) return { model, effort: validateEffort(split[2]!, model) };
  }
  throw new Error(`Unknown model: ${text}. Use /model to choose an available model, or use provider/model-id.`);
}

/** Complete only at the end; never overwrite arguments after the cursor. */
export function modelCommandCompletions(
  input: string,
  cursor: number,
  models: readonly Model<any>[],
  currentModel: Model<any> | undefined,
): SettingsCompletion[] {
  if (cursor !== input.length) return [];
  const command = /^\/(model|effort)\s+/.exec(input);
  if (!command) return [];
  const start = command[0].length;
  const body = input.slice(start);
  const effortRows = (model: Model<any> | undefined, fragment: string, offset: number): SettingsCompletion[] => {
    const levels = model ? getSupportedThinkingLevels(model) : ["off"] as ThinkingLevel[];
    if (levels.includes(fragment.toLowerCase() as ThinkingLevel)) return [];
    return levels.filter((level) => level.startsWith(fragment.toLowerCase()))
      .map((level) => ({ start: offset, end: cursor, replacement: level, description: "reasoning effort" }));
  };
  if (command[1] === "effort") return effortRows(currentModel, body, start);
  try {
    if (body && !/\s$/.test(body) && matchCommandModel(body, models)) return [];
    const split = /^(.*\S)\s+(\S*)$/.exec(body);
    if (split) {
      const model = matchCommandModel(split[1]!, models);
      if (model) return effortRows(model, split[2]!, cursor - split[2]!.length);
    }
  } catch { /* An ambiguous name still needs qualified model suggestions. */ }
  const terms = unquote(body.trim()).toLowerCase().split(/\s+/);
  return models.filter((model) => terms.every((term) =>
    `${modelReference(model)} ${model.name ?? ""}`.toLowerCase().includes(term)))
    .map((model) => ({ start, end: cursor, replacement: modelReference(model), description: model.name }));
}

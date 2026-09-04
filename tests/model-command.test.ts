import { describe, expect, test } from "bun:test";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { matchCommandModel, modelCommandCompletions, parseModelSelection, validateEffort } from "../src/model-command";
import { matchingCommandsForTarget } from "../src/commands";

const models = [
  { provider: "one", id: "reasoner", name: "Reasoning Model", reasoning: true },
  { provider: "two", id: "reasoner", name: "Reasoning Model", reasoning: true },
  { provider: "one", id: "plain", name: "Plain Model", reasoning: false },
  { provider: "one", id: "path/model", name: "Unique Model", reasoning: true },
] as Model<any>[];

describe("model commands", () => {
  test("matches names, IDs, qualified IDs, and IDs containing slashes exactly", () => {
    expect(matchCommandModel("PLAIN MODEL", models)).toBe(models[2]);
    expect(matchCommandModel('"Plain Model"', models)).toBe(models[2]);
    expect(matchCommandModel("one/path/model", models)).toBe(models[3]);
    expect(matchCommandModel("path/model", models)).toBe(models[3]);
    expect(matchCommandModel("Plain", models)).toBe(models[2]);
    expect(matchCommandModel("Reason", models)).toBeUndefined();
    const namedEffort = { ...models[0]!, id: "effort-name", name: "Unique Model low" };
    expect(parseModelSelection("Unique Model low", [...models, namedEffort])).toEqual({ model: namedEffort });
    expect(() => matchCommandModel("reasoner", models)).toThrow("Ambiguous model");
    expect(() => matchCommandModel("Reasoning Model", models)).toThrow("one/reasoner, two/reasoner");
  });

  test("validates efforts from installed pi capabilities before a model change", () => {
    expect(parseModelSelection("Unique Model low", models)).toEqual({ model: models[3], effort: "low" });
    expect(parseModelSelection('"Unique Model" HIGH', models)).toEqual({ model: models[3], effort: "high" });
    expect(() => parseModelSelection("Plain Model high", models)).toThrow("Supported efforts: off");
    expect(() => parseModelSelection("one/reasoner impossible", models)).toThrow("Unsupported effort");
    expect(() => parseModelSelection("missing low", models)).toThrow("Unknown model");
    expect(() => parseModelSelection("reasoner low", models)).toThrow("Ambiguous model");
    for (const level of getSupportedThinkingLevels(models[0])) expect(validateEffort(level, models[0])).toBe(level);
  });

  test("completes qualified model identities and supported optional efforts", () => {
    const complete = (input: string) => modelCommandCompletions(input, input.length, models, models[2]);
    expect(complete("/model rea").map((row) => row.replacement)).toEqual(["one/reasoner", "two/reasoner"]);
    expect(complete("/model one/reasoner")).toEqual([]);
    expect(complete("/model one/reasoner ").map((row) => row.replacement)).toEqual(getSupportedThinkingLevels(models[0]));
    expect(complete("/model Plain Model ").map((row) => row.replacement)).toEqual(["off"]);
    expect(complete("/model Unique Model h")[0]).toMatchObject({ replacement: "high", start: 20 });
    expect(complete("/model Unique Model high")).toEqual([]);
    expect(complete("/effort ").map((row) => row.replacement)).toEqual(["off"]);
    expect(complete("/effort off")).toEqual([]);
    expect(modelCommandCompletions("/model plain low", 10, models, models[0])).toEqual([]);
  });

  test("advertises main-only controls and settings promotion aliases", () => {
    expect(matchingCommandsForTarget("/s", "main")[0]?.name).toBe("/s");
    for (const name of ["/model", "/effort", "/store", "/s"]) {
      expect(matchingCommandsForTarget(name, "main").some((row) => row.name === name)).toBe(true);
      expect(matchingCommandsForTarget(name, "subagent")).toEqual([]);
    }
  });
});

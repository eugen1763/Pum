import { describe, expect, test } from "bun:test";
import { normalizeSettings, WORKING_RULE_ANIMATION_MODES } from "./settings";

describe("PUM settings migration", () => {
  test("preserves migration defaults for old files", () => {
    const settings = normalizeSettings({ animations: true, theme: "gruvbox" });
    expect(settings.workingRuleAnimation).toBe("input-only");
    expect(settings.explanationStrength).toBe("simple");
    expect(settings.animations).toBe(true);
  });

  test("accepts every working-rule mode including explicit off", () => {
    expect(WORKING_RULE_ANIMATION_MODES).toEqual(["off", "input-only", "coordinated"]);
    for (const mode of WORKING_RULE_ANIMATION_MODES) {
      expect(normalizeSettings({ workingRuleAnimation: mode }).workingRuleAnimation).toBe(mode);
    }
  });

  test("replaces unknown enum values with migration defaults", () => {
    const settings = normalizeSettings({
      workingRuleAnimation: "orbit",
      explanationStrength: "verbose",
    });
    expect(settings.workingRuleAnimation).toBe("input-only");
    expect(settings.explanationStrength).toBe("simple");
  });

  test("accepts every explanation strength", () => {
    for (const explanationStrength of ["none", "simple", "detailed"] as const) {
      expect(normalizeSettings({ explanationStrength }).explanationStrength).toBe(explanationStrength);
    }
  });
});

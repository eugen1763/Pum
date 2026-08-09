import { describe, expect, test } from "bun:test";
import { normalizeSettings, WORKING_RULE_ANIMATION_MODES } from "./settings";

describe("PUM settings migration", () => {
  test("preserves the previous input-rule animation for old files", () => {
    const settings = normalizeSettings({ animations: true, theme: "gruvbox" });
    expect(settings.workingRuleAnimation).toBe("input-only");
    expect(settings.animations).toBe(true);
  });

  test("accepts every working-rule mode including explicit off", () => {
    expect(WORKING_RULE_ANIMATION_MODES).toEqual(["off", "input-only", "coordinated"]);
    for (const mode of WORKING_RULE_ANIMATION_MODES) {
      expect(normalizeSettings({ workingRuleAnimation: mode }).workingRuleAnimation).toBe(mode);
    }
  });

  test("replaces an unknown working-rule mode with the migration default", () => {
    expect(normalizeSettings({ workingRuleAnimation: "orbit" }).workingRuleAnimation).toBe("input-only");
  });
});

import { describe, expect, test } from "bun:test";
import { CHECK_MODE_PROFILES, normalizeSettings, WORKING_RULE_ANIMATION_MODES } from "./settings";

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

  test("migrates the legacy Check mode boolean and accepts profiles", () => {
    expect(normalizeSettings({ checkMode: true } as any).checkMode).toBe("strict");
    expect(normalizeSettings({ checkMode: false } as any).checkMode).toBe("off");
    expect(CHECK_MODE_PROFILES).toEqual(["off", "strict", "balanced", "ask"]);
    for (const checkMode of CHECK_MODE_PROFILES) {
      expect(normalizeSettings({ checkMode }).checkMode).toBe(checkMode);
    }
    expect(normalizeSettings({ checkMode: "permissive" } as any).checkMode).toBe("off");
  });
});

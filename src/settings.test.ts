import { describe, expect, test } from "bun:test";
import {
  CHECK_MODE_PROFILES,
  DEFAULT_MAX_ACTIVE_SUBAGENTS,
  MAX_ACTIVE_SUBAGENTS,
  MIN_ACTIVE_SUBAGENTS,
  normalizeSettings,
  SANDBOX_MODES,
  WORKING_RULE_ANIMATION_MODES,
} from "./settings";

describe("PUM settings migration", () => {
  test("preserves migration defaults for old files", () => {
    const settings = normalizeSettings({ animations: true, theme: "gruvbox" });
    expect(settings.workingRuleAnimation).toBe("input-only");
    expect(settings.explanationStrength).toBe("simple");
    expect(settings.animations).toBe(true);
    expect(settings.maxActiveSubagents).toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
    expect(settings.checkPaths).toEqual({});
    expect(settings.sandboxMode).toBe("auto");
  });

  test("normalizes bounded additional Check mode paths", () => {
    const settings = normalizeSettings({
      checkPaths: {
        "/project": ["/shared", "/shared", "", 42],
        invalid: "not-an-array",
      },
    } as any);
    expect(settings.checkPaths).toEqual({ "/project": ["/shared"] });
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

  test("validates the configurable active subagent limit", () => {
    expect(MIN_ACTIVE_SUBAGENTS).toBe(1);
    expect(MAX_ACTIVE_SUBAGENTS).toBe(25);
    expect(normalizeSettings({ maxActiveSubagents: 1 }).maxActiveSubagents).toBe(1);
    expect(normalizeSettings({ maxActiveSubagents: 20 }).maxActiveSubagents).toBe(20);
    expect(normalizeSettings({ maxActiveSubagents: 25 }).maxActiveSubagents).toBe(25);
    for (const invalid of [0, 26, 4.5, "12", null]) {
      expect(normalizeSettings({ maxActiveSubagents: invalid } as any).maxActiveSubagents)
        .toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
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

  test("migrates and validates the sandbox mode", () => {
    expect(SANDBOX_MODES).toEqual(["auto", "require", "off"]);
    for (const sandboxMode of SANDBOX_MODES) {
      expect(normalizeSettings({ sandboxMode }).sandboxMode).toBe(sandboxMode);
    }
    expect(normalizeSettings({ sandboxMode: "on" } as any).sandboxMode).toBe("auto");
  });
});

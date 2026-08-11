import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryConfigDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-settings-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runInConfigDirectory(directory: string, script: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const processResult = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, PUM_DIR: directory },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("PUM settings persistence", () => {
  test("saveSettings round-trips through loadSettings", async () => {
    const directory = temporaryConfigDirectory();
    const settingsModule = new URL("./settings.ts", import.meta.url).href;
    const script = [
      `import { loadSettings, saveSettings } from ${JSON.stringify(settingsModule)};`,
      `const settings = {`,
      `  showThinking: true,`,
      `  theme: "gruvbox",`,
      `  animations: false,`,
      `  workingRuleAnimation: "coordinated",`,
      `  webSearch: false,`,
      `  writingStyle: "none",`,
      `  explanationStrength: "detailed",`,
      `  checkMode: "balanced",`,
      `  checkModel: "anthropic/claude-3.7-sonnet",`,
      `  sandboxMode: "off",`,
      `  checkPaths: {},`,
      `  maxActiveSubagents: 7,`,
      `};`,
      `saveSettings(settings);`,
      `console.log(JSON.stringify(loadSettings()));`,
    ].join("\n");

    const result = await runInConfigDirectory(directory, script);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      showThinking: true,
      theme: "gruvbox",
      animations: false,
      workingRuleAnimation: "coordinated",
      webSearch: false,
      writingStyle: "none",
      explanationStrength: "detailed",
      checkMode: "balanced",
      checkModel: "anthropic/claude-3.7-sonnet",
      sandboxMode: "off",
      checkPaths: {},
      maxActiveSubagents: 7,
    });
  });

  test("leftover temp files do not affect loading", async () => {
    const directory = temporaryConfigDirectory();
    // A crash could leave temp files behind. loading must ignore them and must
    // never mistake one for pum.json itself.
    writeFileSync(join(directory, "pum.json.1234.1234567890123.tmp"), "partial json", "utf8");
    writeFileSync(join(directory, "pum.json.5678.1234567890456.tmp"), "{", "utf8");
    const settingsModule = new URL("./settings.ts", import.meta.url).href;
    const script = [
      `import { loadSettings } from ${JSON.stringify(settingsModule)};`,
      `console.log(JSON.stringify(loadSettings()));`,
    ].join("\n");

    const result = await runInConfigDirectory(directory, script);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const loaded = JSON.parse(result.stdout);
    expect(loaded.theme).toBe("tokyonight");
    expect(loaded.animations).toBe(true);
    expect(loaded.checkMode).toBe("off");
    expect(loaded.sandboxMode).toBe("auto");
    expect(loaded.maxActiveSubagents).toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
  });
});

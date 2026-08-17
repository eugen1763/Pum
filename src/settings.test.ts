import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_MODE_PROFILES,
  cycleOutputMode,
  DEFAULT_MAX_ACTIVE_SUBAGENTS,
  MAX_ACTIVE_SUBAGENTS,
  MIN_ACTIVE_SUBAGENTS,
  normalizeSettings,
  normalizeOutputMode,
  OUTPUT_MODE_LABELS,
  OUTPUT_MODES,
  SANDBOX_MODES,
  WORKING_RULE_ANIMATION_LABELS,
  WORKING_RULE_ANIMATION_MODES,
} from "./settings";
import { DEFAULT_BASH_OUTPUT } from "./bash-output";

describe("PUM settings migration", () => {
  test("rejects non-boolean toggles and a non-string theme", () => {
    const settings = normalizeSettings({
      showThinking: "no",
      webSearch: "yes",
      theme: 42,
      animations: "off",
    } as any);
    expect(settings.showThinking).toBe(false);
    expect(settings.webSearch).toBe(true);
    expect(settings.theme).toBe("tokyonight");
    expect(settings.animations).toBe(true);
    // Already-correct validation must not regress.
    expect(normalizeSettings({ maxActiveSubagents: 25 } as any).maxActiveSubagents).toBe(25);
    expect(normalizeSettings({ jspace: true }).jspace).toBe(true);
    expect(normalizeSettings({ jspace: "yes" } as any).jspace).toBe(false);
    expect(normalizeSettings({ maxActiveSubagents: 26 } as any).maxActiveSubagents)
      .toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
    expect(normalizeSettings({ maxActiveSubagents: 0 } as any).maxActiveSubagents)
      .toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
  });

  test("preserves migration defaults for old files", () => {
    const settings = normalizeSettings({ animations: true, theme: "gruvbox" });
    expect(settings.workingRuleAnimation).toBe("input-only");
    expect(settings.outputMode).toBe("normal");
    expect(settings.explanationStrength).toBe("simple");
    expect(settings.animations).toBe(true);
    expect(settings.maxActiveSubagents).toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
    expect(settings.checkPaths).toEqual({});
    expect(settings.sandboxMode).toBe("auto");
    expect(settings.bashOutput).toEqual(DEFAULT_BASH_OUTPUT);
    expect(settings.jspace).toBe(false);
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
    expect(WORKING_RULE_ANIMATION_MODES).toEqual([
      "off",
      "input-only",
      "coordinated",
      "comet-pair",
      "electric-spark",
      "constellation",
      "random-constellation",
      "energy-transfer",
    ]);
    for (const mode of WORKING_RULE_ANIMATION_MODES) {
      expect(normalizeSettings({ workingRuleAnimation: mode }).workingRuleAnimation).toBe(mode);
      expect(WORKING_RULE_ANIMATION_LABELS[mode].length).toBeGreaterThan(0);
    }
    expect(WORKING_RULE_ANIMATION_LABELS).toEqual({
      off: "Off",
      "input-only": "Input sweep",
      coordinated: "Coordinated sweep",
      "comet-pair": "Comet pair",
      "electric-spark": "Electric spark",
      constellation: "Constellation",
      "random-constellation": "Random constellation",
      "energy-transfer": "Energy transfer",
    });
  });

  test("falls back to the default when a retired working-rule mode is stored", () => {
    expect(normalizeSettings({ workingRuleAnimation: "sparkle-trail" }).workingRuleAnimation)
      .toBe("input-only");
  });

  test("migrates and validates the transcript output mode", () => {
    expect(OUTPUT_MODES).toEqual(["quiet", "normal", "verbose"]);
    expect(OUTPUT_MODE_LABELS).toEqual({ quiet: "Quiet", normal: "Normal", verbose: "Verbose" });
    for (const outputMode of OUTPUT_MODES) {
      expect(normalizeSettings({ outputMode }).outputMode).toBe(outputMode);
      expect(normalizeOutputMode(outputMode)).toBe(outputMode);
    }
    expect(normalizeOutputMode("minimal")).toBe("quiet");
    expect(normalizeOutputMode("default")).toBe("normal");
    expect(normalizeOutputMode("detailed")).toBe("verbose");
    expect(normalizeOutputMode("unknown")).toBe("normal");
    expect(cycleOutputMode("normal", 1)).toBe("verbose");
    expect(cycleOutputMode("verbose", 1)).toBe("quiet");
    expect(cycleOutputMode("quiet", -1)).toBe("verbose");
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

  test("migrates every legacy Check mode value to the on/off toggle", () => {
    expect(CHECK_MODE_PROFILES).toEqual(["off", "on"]);
    // Legacy profiles and the legacy boolean true all become "on".
    for (const legacy of ["strict", "balanced", "ask", true]) {
      expect(normalizeSettings({ checkMode: legacy } as any).checkMode).toBe("on");
    }
    // off and false stay off; unknown values default to off.
    expect(normalizeSettings({ checkMode: false } as any).checkMode).toBe("off");
    expect(normalizeSettings({ checkMode: "off" }).checkMode).toBe("off");
    expect(normalizeSettings({ checkMode: "on" }).checkMode).toBe("on");
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
      `  outputMode: "verbose",`,
      `  webSearch: false,`,
      `  writingStyle: "none",`,
      `  explanationStrength: "detailed",`,
      `  checkMode: "on",`,
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
      outputMode: "verbose",
      webSearch: false,
      writingStyle: "none",
      explanationStrength: "detailed",
      checkMode: "on",
      checkModel: "anthropic/claude-3.7-sonnet",
      sandboxMode: "off",
      checkPaths: {},
      maxActiveSubagents: 7,
      goalRetryLimit: 10,
      showAgentMessages: true,
      jspace: false,
      bashOutput: DEFAULT_BASH_OUTPUT,
    });
  });

  test("keeps a corrupt pum.json before defaults can overwrite it", async () => {
    const directory = temporaryConfigDirectory();
    const corrupt = '{"theme": "gruvbox", "maxActiveSubagents": 7,';
    writeFileSync(join(directory, "pum.json"), corrupt, "utf8");
    const settingsModule = new URL("./settings.ts", import.meta.url).href;
    const script = [
      `import { readFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { loadSettings, saveSettings } from ${JSON.stringify(settingsModule)};`,
      `const settings = loadSettings();`,
      `saveSettings(settings);`,
      `console.log(JSON.stringify({`,
      `  theme: settings.theme,`,
      `  backup: readFileSync(join(process.env.PUM_DIR, "pum.json.bad"), "utf8"),`,
      `}));`,
    ].join("\n");

    const result = await runInConfigDirectory(directory, script);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.theme).toBe("tokyonight");
    expect(parsed.backup).toBe(corrupt);
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
    expect(loaded.outputMode).toBe("normal");
    expect(loaded.checkMode).toBe("off");
    expect(loaded.sandboxMode).toBe("auto");
    expect(loaded.maxActiveSubagents).toBe(DEFAULT_MAX_ACTIVE_SUBAGENTS);
  });
});

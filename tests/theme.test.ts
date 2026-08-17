import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, mix, mixLight, rgba } from "../src/theme";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("rejection theme tokens", () => {
  test("defines rejection foreground and background separately in all nine presets", () => {
    expect(Object.keys(PRESETS)).toHaveLength(9);
    for (const theme of Object.values(PRESETS)) {
      expect(theme.rejection).toBeTruthy();
      expect(theme.rejectionBg).toBeTruthy();
      expect(theme.rejection).toBe(theme.warn);
      expect(theme.rejection).not.toBe(theme.error);
      expect(theme.rejectionBg).not.toBe(theme.bg);
      expect(theme.statusCwd).toBeTruthy();
      expect(theme.statusCwd).not.toBe(theme.dim);
      expect(theme.bashOutput).toBeTruthy();
      expect(theme.statsRunning).toBeTruthy();
      expect(theme.statsInterrupted).toBeTruthy();
      expect(theme.statsRunning).not.toBe(theme.statsInterrupted);
      expect(theme.popupShadow).toBeTruthy();
      expect(theme.popupShadow).not.toBe(theme.popupBg);
      expect(theme.diffAddedBg).toBeTruthy();
      expect(theme.diffRemovedBg).toBeTruthy();
      expect(theme.diffAddedBg).not.toBe(theme.diffRemovedBg);
    }
  });

  test("accepts rejection foreground and background from theme.json", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-theme-test-"));
    temporaryDirectories.push(directory);
    const rejection = PRESETS["github-light"]!.accent;
    const rejectionBg = PRESETS["github-light"]!.userBg;
    const statusCwd = PRESETS["github-light"]!.codeType;
    const statsRunning = PRESETS["github-light"]!.statsRunning;
    const statsInterrupted = PRESETS["github-light"]!.statsInterrupted;
    const diffAddedBg = PRESETS["github-light"]!.diffAddedBg;
    const diffRemovedBg = PRESETS["github-light"]!.diffRemovedBg;
    writeFileSync(join(directory, "theme.json"), JSON.stringify({
      rejection,
      rejectionBg,
      statusCwd,
      statsRunning,
      statsInterrupted,
      diffAddedBg,
      diffRemovedBg,
      popupShadow: PRESETS["github-light"]!.border,
      unknownRejectionToken: "ignored",
    }));

    const themeModule = new URL("../src/theme.ts", import.meta.url).href;
    const script = [
      `import { loadTheme } from ${JSON.stringify(themeModule)};`,
      `console.log(JSON.stringify(loadTheme("tokyonight")));`,
    ].join("\n");
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

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const theme = JSON.parse(stdout);
    expect(theme.rejection).toBe(rejection);
    expect(theme.rejectionBg).toBe(rejectionBg);
    expect(theme.statusCwd).toBe(statusCwd);
    expect(theme.statsRunning).toBe(statsRunning);
    expect(theme.statsInterrupted).toBe(statsInterrupted);
    expect(theme.diffAddedBg).toBe(diffAddedBg);
    expect(theme.diffRemovedBg).toBe(diffRemovedBg);
    expect(theme.popupShadow).toBe(PRESETS["github-light"]!.border);
    expect(theme.unknownRejectionToken).toBeUndefined();
  });

  test("ignores a theme.json that is not a plain object", async () => {
    const badShapes: Array<[string, string]> = [
      ["null", "null"],
      ["string", JSON.stringify("abc")],
      ["array", JSON.stringify([1, 2])],
      ["empty object", JSON.stringify({})],
      ["malformed", "{not json"],
    ];
    for (const [label, contents] of badShapes) {
      const directory = mkdtempSync(join(tmpdir(), "pum-theme-bad-"));
      temporaryDirectories.push(directory);
      writeFileSync(join(directory, "theme.json"), contents);

      const themeModule = new URL("../src/theme.ts", import.meta.url).href;
      const script = [
        `import { loadTheme } from ${JSON.stringify(themeModule)};`,
        `console.log(JSON.stringify(loadTheme("tokyonight")));`,
      ].join("\n");
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

      expect(`${label}: ${stderr}`).toBe(`${label}: `);
      expect(`${label}: ${exitCode}`).toBe(`${label}: 0`);
      expect(JSON.parse(stdout)).toEqual(PRESETS.tokyonight!);
    }
  });
});

describe("linear-light blending", () => {
  test("keeps the middle of a ramp brighter than an sRGB byte lerp", () => {
    const black = rgba("#000000");
    const white = rgba("#ffffff");
    const half = mixLight(black, white, 0.5);

    expect(half.r).toBeGreaterThan(mix(black, white, 0.5).r);
    // 0.5 in linear light is roughly mid grey to the eye, near sRGB 0.73.
    // RGBA stores eight bits a channel, so compare within one step of that.
    expect(half.r).toBeCloseTo(0.5 ** (1 / 2.2), 2);
    expect(half.g).toBeCloseTo(half.r, 10);
    expect(half.b).toBeCloseTo(half.r, 10);
  });

  test("pins both ends and rises without a dip", () => {
    const base = rgba("#292e42");
    const highlight = rgba("#7aa2f7");

    expect(mixLight(base, highlight, 0)).toEqual(base);
    expect(mixLight(base, highlight, 1)).toEqual(highlight);
    let previous = -1;
    for (let step = 0; step <= 20; step++) {
      const { r, g, b } = mixLight(base, highlight, step / 20);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      expect(luminance).toBeGreaterThan(previous);
      previous = luminance;
    }
  });

  test("clamps out-of-range positions to the two endpoints", () => {
    const base = rgba("#101010");
    const highlight = rgba("#f0f0f0");

    expect(mixLight(base, highlight, -1)).toEqual(base);
    expect(mixLight(base, highlight, 2)).toEqual(highlight);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "./theme";

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
      expect(theme.popupShadow).toBeTruthy();
      expect(theme.popupShadow).not.toBe(theme.popupBg);
    }
  });

  test("accepts rejection foreground and background from theme.json", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-theme-test-"));
    temporaryDirectories.push(directory);
    const rejection = PRESETS["github-light"]!.accent;
    const rejectionBg = PRESETS["github-light"]!.userBg;
    const statusCwd = PRESETS["github-light"]!.codeType;
    writeFileSync(join(directory, "theme.json"), JSON.stringify({
      rejection,
      rejectionBg,
      statusCwd,
      popupShadow: PRESETS["github-light"]!.border,
      unknownRejectionToken: "ignored",
    }));

    const themeModule = new URL("./theme.ts", import.meta.url).href;
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
    expect(theme.popupShadow).toBe(PRESETS["github-light"]!.border);
    expect(theme.unknownRejectionToken).toBeUndefined();
  });
});

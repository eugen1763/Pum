import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCliError, helpText, parseCliArgs, readPackageMetadata } from "./cli";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const entrypoint = join(projectRoot, "src", "index.tsx");
const packagePath = join(projectRoot, "package.json");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pum-cli-"));
const workingDirectory = join(temporaryRoot, "workspace");
mkdirSync(workingDirectory);
afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  configPath: string;
  timedOut: boolean;
};

async function runCli(...args: string[]): Promise<RunResult> {
  const configPath = join(temporaryRoot, `config-${crypto.randomUUID()}`);
  const child = Bun.spawn([process.execPath, "run", entrypoint, ...args], {
    cwd: workingDirectory,
    env: { ...process.env, PUM_DIR: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { exitCode, stdout, stderr, configPath, timedOut };
}

async function expectNoStartup(result: RunResult): Promise<void> {
  expect(result.timedOut).toBe(false);
  expect(existsSync(result.configPath)).toBe(false);
}

describe("CLI argument parsing", () => {
  test("preserves login and resume startup arguments", () => {
    expect(parseCliArgs(["login", "--resume"])).toEqual({
      kind: "start",
      options: { login: true, resume: true, overrideStatsFile: false },
    });
    expect(parseCliArgs(["-r"])).toEqual({
      kind: "start",
      options: { login: false, resume: true, overrideStatsFile: false },
    });
  });

  test("parses the one-shot prompt option", () => {
    expect(parseCliArgs(["-p", "write hello world"])).toEqual({
      kind: "start",
      options: { login: false, resume: false, overrideStatsFile: false, prompt: "write hello world" },
    });
    expect(parseCliArgs(["--prompt", "task", "-r"])).toEqual({
      kind: "start",
      options: { login: false, resume: true, overrideStatsFile: false, prompt: "task" },
    });
  });

  test("parses headless statistics options", () => {
    expect(parseCliArgs(["-p", "task", "--statsFile", "D:\\tmp\\stats.json"])).toEqual({
      kind: "start",
      options: {
        login: false,
        resume: false,
        overrideStatsFile: false,
        prompt: "task",
        statsFile: "D:\\tmp\\stats.json",
      },
    });
    expect(parseCliArgs(["--stats-file", "stats.json", "--override", "-p", "task"])).toEqual({
      kind: "start",
      options: {
        login: false,
        resume: false,
        overrideStatsFile: true,
        prompt: "task",
        statsFile: "stats.json",
      },
    });
  });

  test("treats a prompt value that looks like a flag as prompt text", () => {
    expect(parseCliArgs(["-p", "--help"])).toEqual({
      kind: "start",
      options: { login: false, resume: false, overrideStatsFile: false, prompt: "--help" },
    });
    expect(parseCliArgs(["--prompt", "-v"])).toEqual({
      kind: "start",
      options: { login: false, resume: false, overrideStatsFile: false, prompt: "-v" },
    });
    // A real --help flag still short-circuits.
    expect(parseCliArgs(["--help", "-p", "x"])).toEqual({ kind: "help" });
  });

  test("rejects invalid prompt and stats option forms", () => {
    expect(parseCliArgs(["-p"])).toEqual({
      kind: "error",
      message: "Missing prompt text after -p",
    });
    expect(parseCliArgs(["--prompt"])).toEqual({
      kind: "error",
      message: "Missing prompt text after --prompt",
    });
    expect(parseCliArgs(["-p", "one", "-p", "two"])).toEqual({
      kind: "error",
      message: "Only one --prompt is supported",
    });
    expect(parseCliArgs(["login", "-p", "task"])).toEqual({
      kind: "error",
      message: "Cannot combine login with --prompt",
    });
    expect(parseCliArgs(["-p", "   "])).toEqual({
      kind: "error",
      message: "The prompt text is empty",
    });
    expect(parseCliArgs(["--statsFile", "stats.json"])).toEqual({
      kind: "error",
      message: "--statsFile requires --prompt",
    });
    expect(parseCliArgs(["-p", "task", "--override"])).toEqual({
      kind: "error",
      message: "--override requires --statsFile",
    });
  });

  test("parses writable and read-only outer sandbox launches", () => {
    expect(parseCliArgs(["s", "/work/a", "/work/b:ro", "-r"])).toEqual({
      kind: "start",
      options: {
        login: false,
        resume: true,
        overrideStatsFile: false,
        outerSandbox: {
          mode: "write",
          mounts: ["/work/a", "/work/b:ro"],
        },
      },
    });
    expect(parseCliArgs(["sr", "login", "/data:rw"])).toEqual({
      kind: "start",
      options: {
        login: true,
        resume: false,
        overrideStatsFile: false,
        outerSandbox: {
          mode: "read",
          mounts: ["/data:rw"],
        },
      },
    });
  });

  test("keeps mount permission suffixes raw for launch planning", () => {
    expect(parseCliArgs(["s", "/data:custom"])).toEqual({
      kind: "start",
      options: {
        login: false,
        resume: false,
        overrideStatsFile: false,
        outerSandbox: { mode: "write", mounts: ["/data:custom"] },
      },
    });
  });

  test("rejects headless prompts with outer sandbox commands", () => {
    expect(parseCliArgs(["s", "-p", "task"])).toEqual({
      kind: "error",
      message: "Cannot combine an outer sandbox command with --prompt",
    });
  });

  test("parses sandbox setup as a non-startup command", () => {
    expect(parseCliArgs(["ss"])).toEqual({ kind: "sandboxSetup" });
    for (const args of [["ss", "-r"], ["-r", "ss"], ["login", "ss"]]) {
      expect(parseCliArgs(args)).toEqual({
        kind: "error",
        message: "Command 'ss' does not accept arguments or options.",
      });
    }
  });

  test("rejects login after the mount directories", () => {
    expect(parseCliArgs(["s", "/data", "login"])).toEqual({
      kind: "error",
      message: "'login' must come before mount directories",
    });
    expect(parseCliArgs(["sr", "/data", "/more", "login"])).toEqual({
      kind: "error",
      message: "'login' must come before mount directories",
    });
    // Before any mount it is still the login keyword.
    expect(parseCliArgs(["s", "login", "/data"])).toEqual({
      kind: "start",
      options: {
        login: true,
        resume: false,
        overrideStatsFile: false,
        outerSandbox: { mode: "write", mounts: ["/data"] },
      },
    });
  });

  test("help and version win over a parse error", () => {
    for (const flag of ["-h", "--help"]) {
      expect(parseCliArgs([flag, "badcmd"])).toEqual({ kind: "help" });
      expect(parseCliArgs(["badcmd", flag])).toEqual({ kind: "help" });
      expect(parseCliArgs([flag, "--unknown"])).toEqual({ kind: "help" });
      expect(parseCliArgs(["ss", flag])).toEqual({ kind: "help" });
    }
    for (const flag of ["-v", "--version"]) {
      expect(parseCliArgs([flag, "badcmd"])).toEqual({ kind: "version" });
      expect(parseCliArgs(["badcmd", flag])).toEqual({ kind: "version" });
    }
    // Help still beats version, and a prompt value still swallows the flag.
    expect(parseCliArgs(["-v", "-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-p", "-h", "badcmd"])).toEqual({
      kind: "error",
      message: "Unknown command: badcmd",
    });
  });

  test("reports the first parse error, not the last", () => {
    expect(parseCliArgs(["--unknown", "alsobad"])).toEqual({
      kind: "error",
      message: "Unknown option: --unknown",
    });
  });

  test("treats arguments after -- as operands", () => {
    expect(parseCliArgs(["--"])).toEqual({
      kind: "start",
      options: { login: false, resume: false, overrideStatsFile: false },
    });
    expect(parseCliArgs(["s", "--", "-weird", "login", "--help"])).toEqual({
      kind: "start",
      options: {
        login: false,
        resume: false,
        overrideStatsFile: false,
        outerSandbox: { mode: "write", mounts: ["-weird", "login", "--help"] },
      },
    });
    expect(parseCliArgs(["sr", "-r", "--", "-p"])).toEqual({
      kind: "start",
      options: {
        login: false,
        resume: true,
        overrideStatsFile: false,
        outerSandbox: { mode: "read", mounts: ["-p"] },
      },
    });
    // Without a sandbox command there is nowhere for an operand to go.
    expect(parseCliArgs(["--", "-weird"])).toEqual({
      kind: "error",
      message: "Unknown command: -weird",
    });
  });

  test("rejects unknown options and commands", () => {
    expect(parseCliArgs(["--unknown"])).toEqual({
      kind: "error",
      message: "Unknown option: --unknown",
    });
    expect(parseCliArgs(["unknown"])).toEqual({
      kind: "error",
      message: "Unknown command: unknown",
    });
  });
});

describe("non-interactive CLI", () => {
  test("long and short version flags print only the package version", async () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) {
      const result = await runCli(flag);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${packageJson.version}\n`);
      expect(result.stderr).toBe("");
      await expectNoStartup(result);
    }
  });

  test("long and short help flags print the manual", async () => {
    const expected = helpText(await readPackageMetadata());
    for (const flag of ["--help", "-h"]) {
      const result = await runCli(flag);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:\n");
      expect(result.stdout).toContain("pum s [login] [options] [directory[:ro|:rw] ...]");
      expect(result.stdout).toContain("pum sr [login] [options] [directory[:ro|:rw] ...]");
      expect(result.stdout).toContain("pum ss");
      expect(result.stdout).toContain("--statsFile");
      expect(result.stdout).toContain("PUM_DIR");
      expect(result.stdout).toContain("Executable: pum");
      await expectNoStartup(result);
    }
  });

  test("one-shot prompt without a provider fails fast and never opens the TUI", async () => {
    const result = await runCli("-p", "say hi");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no provider is available");
  }, 20_000);

  test("writes a failure stats artifact without a provider", async () => {
    const statsPath = join(temporaryRoot, `stats-${crypto.randomUUID()}`, "result.json");
    const result = await runCli("-p", "say hi", "--statsFile", statsPath);
    expect(result.exitCode).toBe(1);
    const artifact = JSON.parse(readFileSync(statsPath, "utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      run: { prompt: "say hi", exitCode: 1, resume: false },
      stats: {
        models: [],
        tools: [],
        outcomes: { successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 0 },
      },
    });
  }, 20_000);

  test("rejects an existing stats file before startup", async () => {
    const statsPath = join(temporaryRoot, `existing-${crypto.randomUUID()}.json`);
    writeFileSync(statsPath, "keep me");
    const result = await runCli("-p", "say hi", "--statsFile", statsPath);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("stats file already exists");
    expect(readFileSync(statsPath, "utf8")).toBe("keep me");
    await expectNoStartup(result);
  });

  test("help and version still print when a later argument is invalid", async () => {
    const expected = helpText(await readPackageMetadata());
    const help = await runCli("-h", "badcmd");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toBe(expected);
    expect(help.stderr).toBe("");
    await expectNoStartup(help);

    const version = await runCli("-v", "badcmd");
    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe("");
    await expectNoStartup(version);
  });

  test("unknown long and short options fail with a concise help hint", async () => {
    for (const option of ["--unknown", "-x"]) {
      const result = await runCli(option);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(formatCliError(`Unknown option: ${option}`));
      await expectNoStartup(result);
    }
  });
});

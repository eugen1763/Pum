import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      options: { login: true, resume: true },
    });
    expect(parseCliArgs(["-r"])).toEqual({
      kind: "start",
      options: { login: false, resume: true },
    });
  });

  test("parses the one-shot prompt option", () => {
    expect(parseCliArgs(["-p", "write hello world"])).toEqual({
      kind: "start",
      options: { login: false, resume: false, prompt: "write hello world" },
    });
    expect(parseCliArgs(["--prompt", "task", "-r"])).toEqual({
      kind: "start",
      options: { login: false, resume: true, prompt: "task" },
    });
  });

  test("treats a prompt value that looks like a flag as prompt text", () => {
    expect(parseCliArgs(["-p", "--help"])).toEqual({
      kind: "start", options: { login: false, resume: false, prompt: "--help" },
    });
    expect(parseCliArgs(["--prompt", "-v"])).toEqual({
      kind: "start", options: { login: false, resume: false, prompt: "-v" },
    });
    // A real --help flag still short-circuits.
    expect(parseCliArgs(["--help", "-p", "x"])).toEqual({ kind: "help" });
  });

  test("rejects invalid prompt option forms", () => {
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

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxBackend, SandboxPolicy } from "./types";
import { createBubblewrapBackend } from "./linux";
import { createWindowsSandboxBackend } from "./windows";

function backend(): SandboxBackend | undefined {
  if (process.platform === "linux") return createBubblewrapBackend();
  if (process.platform === "win32") return createWindowsSandboxBackend();
  return undefined;
}

test("a real enforced backend denies writes to a protected file", async () => {
  const active = backend();
  if (!active) return;
  const capability = await active.probe();
  if (capability.state !== "enforced") return;

  const root = await mkdtemp(join(tmpdir(), "pum-real-sandbox-"));
  const privateTemp = join(root, "private-temp");
  const denied = join(root, "protected.txt");
  await mkdir(privateTemp);
  await writeFile(denied, "original", "utf8");
  const windows = process.platform === "win32";
  const executable = windows
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
    : "/bin/sh";
  const command = windows
    ? `echo changed>${JSON.stringify(denied)}`
    : `printf changed > ${JSON.stringify(denied)}`;
  const args = windows ? ["/d", "/s", "/c", command] : ["-c", command];
  const policy: SandboxPolicy = {
    version: 1,
    exactCommand: command,
    cwd: root,
    readOnlyPaths: [],
    readWritePaths: [root],
    deniedPaths: [denied],
    privateTemp,
    environment: windows
      ? { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
      : { PATH: "/usr/bin:/bin" },
    executable,
    args,
    network: "deny",
    rationale: "real backend denied-write test",
    accesses: [{ resolvedPath: denied, mode: "write", source: "redirection", stage: 0, external: false }],
  };

  try {
    const handle = active.spawn(policy, { onStdout() {}, onStderr() {}, timeoutSeconds: 10 });
    const result = await handle.completed.catch(() => ({ exitCode: 1, signal: null }));
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(denied, "utf8")).toBe("original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

import { describe, expect, test } from "bun:test";
import { analyzeCheckPolicy } from "./check-policy";
import {
  buildSandboxPolicy,
  decideSandboxMode,
  sanitizeSandboxEnvironment,
} from "./sandbox-policy";

const inertFileSystem = {
  exists: () => false,
  isSymbolicLink: () => false,
  realpath: (path: string) => path,
};

describe("sandbox policy generation", () => {
  test("uses authoritative roots and exact Balanced external read grants", () => {
    const cwd = "/work/repo";
    const shared = "/work/shared";
    const outside = "/opt/reference/data.txt";
    const command = `cat ${outside}`;
    const result = analyzeCheckPolicy({
      command,
      cwd,
      allowedPaths: [shared],
      profile: "balanced",
      fileSystem: inertFileSystem,
    });
    const policy = buildSandboxPolicy({
      command,
      cwd,
      additionalRoots: [shared, `${cwd}/nested`],
      result,
      executable: "/bin/bash",
      args: ["-c", command],
      privateTemp: "/tmp/pum-private",
      environment: { PATH: "/bin", OPENAI_API_KEY: "secret" },
      pumConfigRoot: "/home/user/.config/pum",
      home: "/home/user",
      platform: "linux",
    });

    expect(policy.exactCommand).toBe(command);
    expect(policy.cwd).toBe(cwd);
    expect(policy.executable).toBe("/bin/bash");
    expect(policy.args).toEqual(["-c", command]);
    expect(policy.readWritePaths).toEqual([cwd, shared]);
    expect(policy.readOnlyPaths).toEqual([outside]);
    expect(policy.environment).toEqual({ PATH: "/bin" });
    expect(policy.deniedPaths).toContain("/home/user/.config/pum");
    expect(policy.deniedPaths).toContain("/work/repo/.env");
    expect(policy.network).toBe("deny");
    expect(policy.accesses).toContainEqual(expect.objectContaining({
      resolvedPath: outside,
      mode: "read",
      external: true,
    }));
  });

  test("does not turn approved roots or denied paths into external read grants", () => {
    const command = "cat /shared/data.txt";
    const result = analyzeCheckPolicy({
      command,
      cwd: "/repo",
      allowedPaths: ["/shared"],
      profile: "ask",
      fileSystem: { exists: () => true, isSymbolicLink: () => false, realpath: (path) => path },
    });
    const policy = buildSandboxPolicy({
      command,
      cwd: "/repo",
      additionalRoots: ["/shared"],
      result,
      executable: "/bin/sh",
      args: ["-c", command],
      privateTemp: "/tmp/pum-private",
      pumConfigRoot: "/pum",
      home: "/home/user",
      platform: "linux",
      environment: {},
    });
    expect(policy.readWritePaths).toEqual(["/repo", "/shared"]);
    expect(policy.readOnlyPaths).toEqual([]);
    expect(policy.deniedPaths).toContain("/pum");
  });

  test("carries deterministic network intent from Check mode", () => {
    const command = "curl https://example.test/archive.tgz -o archive.tgz";
    const result = analyzeCheckPolicy({
      command,
      cwd: "/repo",
      profile: "balanced",
      fileSystem: inertFileSystem,
    });
    const policy = buildSandboxPolicy({
      command,
      cwd: "/repo",
      result,
      executable: "/bin/bash",
      args: ["-c", command],
      privateTemp: "/tmp/pum-private",
      environment: {},
      pumConfigRoot: "/pum",
      home: "/home/user",
      platform: "linux",
    });
    expect(policy.network).toBe("host");
    expect(policy.networkCommands).toEqual(["curl"]);
  });

  test("detects network intent in nested shell commands", () => {
    const result = analyzeCheckPolicy({
      command: "sh -c 'git fetch origin'",
      cwd: "/repo",
      profile: "balanced",
      fileSystem: inertFileSystem,
    });
    expect(result.network).toEqual({ access: "host", commands: ["git fetch"] });
  });

  test("rejects blocked or mismatched Check mode results", () => {
    const command = "cat ~/.ssh/id_ed25519";
    const result = analyzeCheckPolicy({ command, cwd: "/repo", profile: "balanced" });
    expect(() => buildSandboxPolicy({
      command,
      cwd: "/repo",
      result,
      executable: "/bin/sh",
      args: ["-c", command],
      privateTemp: "/tmp/pum-private",
    })).toThrow("blocked command");

    const allowed = analyzeCheckPolicy({ command: "pwd", cwd: "/repo", profile: "balanced" });
    expect(() => buildSandboxPolicy({
      command: "echo changed",
      cwd: "/repo",
      result: allowed,
      executable: "/bin/sh",
      args: ["-c", "echo changed"],
      privateTemp: "/tmp/pum-private",
    })).toThrow("does not match");
  });
});

describe("sandbox environment and mode", () => {
  test("redacts credentials, PUM state, session paths, and injection variables", () => {
    expect(sanitizeSandboxEnvironment({
      PATH: "/bin",
      CI: "1",
      GITHUB_TOKEN: "secret",
      PUM_DIR: "/private/pum",
      PI_SESSION_FILE: "/private/session.jsonl",
      NODE_OPTIONS: "--require evil",
      npm_config_registry: "https://registry.test",
    })).toEqual({ CI: "1", PATH: "/bin" });
  });

  test("uses direct fallback only for auto and blocks require", () => {
    const unavailable = { state: "unavailable", backend: "bubblewrap", reason: "not supported" } as const;
    expect(decideSandboxMode("off", unavailable)).toEqual({ action: "direct" });
    expect(decideSandboxMode("auto", unavailable)).toEqual(expect.objectContaining({
      action: "direct",
      warning: expect.stringContaining("Check mode"),
    }));
    expect(decideSandboxMode("require", unavailable)).toEqual(expect.objectContaining({
      action: "block",
      reason: expect.stringContaining("required"),
    }));
    expect(decideSandboxMode("auto", { state: "enforced", backend: "bubblewrap" })).toEqual({ action: "sandbox" });
  });
});

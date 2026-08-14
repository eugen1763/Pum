import { describe, expect, test } from "bun:test";
import type { SandboxPolicy } from "./types";
import type {
  BubblewrapProcessAdapter,
  BubblewrapProcessHandle,
  BubblewrapSpawnRequest,
} from "./linux";
import {
  buildBubblewrapArgv,
  createBubblewrapBackend,
  probeBubblewrap,
} from "./linux";

class FakeAdapter implements BubblewrapProcessAdapter {
  requests: BubblewrapSpawnRequest[] = [];
  kills: NodeJS.Signals[] = [];
  private resolveCompletion?: (result: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  autoComplete: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined = {
    exitCode: 0,
    signal: null,
  };
  spawnError: Error | undefined;

  spawn(request: BubblewrapSpawnRequest): BubblewrapProcessHandle {
    this.requests.push(request);
    const completed = this.spawnError
      ? Promise.reject(this.spawnError)
      : new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          this.resolveCompletion = resolve;
          if (this.autoComplete) queueMicrotask(() => resolve(this.autoComplete!));
        });
    return {
      pid: 123,
      completed,
      kill: (signal) => { this.kills.push(signal); },
    };
  }

  complete(exitCode: number | null = null, signal: NodeJS.Signals | null = "SIGTERM"): void {
    this.resolveCompletion?.({ exitCode, signal });
  }
}

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    version: 1,
    exactCommand: "git status --short",
    cwd: "/work/project",
    readOnlyPaths: ["/reference"],
    readWritePaths: ["/work/project"],
    deniedPaths: ["/home/user/.ssh", "/work/project/.env"],
    privateTemp: "/tmp",
    environment: { PATH: "/usr/bin", PI_SESSION_ID: "session" },
    executable: "/usr/bin/git",
    args: ["status", "--short"],
    network: "deny",
    rationale: "test",
    accesses: [],
    ...overrides,
  };
}

describe("Linux Bubblewrap sandbox", () => {
  test("probes a functional sandbox instead of only checking the executable", async () => {
    const adapter = new FakeAdapter();
    expect(await probeBubblewrap({ platform: "linux", processAdapter: adapter })).toEqual({
      state: "enforced",
      backend: "bubblewrap",
    });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.args).toContain("--unshare-user");
    expect(adapter.requests[0]!.args).toContain("--unshare-net");

    expect(await probeBubblewrap({ platform: "darwin", processAdapter: adapter })).toEqual({
      state: "unavailable",
      backend: "bubblewrap",
      reason: "Bubblewrap requires Linux",
    });
    expect(adapter.requests).toHaveLength(1);
  });

  test("reports probe spawn failures", async () => {
    const adapter = new FakeAdapter();
    adapter.spawnError = new Error("spawn bwrap ENOENT");
    expect(await probeBubblewrap({ platform: "linux", processAdapter: adapter })).toEqual({
      state: "unavailable",
      backend: "bubblewrap",
      reason: "spawn bwrap ENOENT",
    });
  });

  test("builds direct argv and masks protected paths after writable mounts", () => {
    const args = buildBubblewrapArgv(policy(), {
      systemMounts: ["/usr", "/etc"],
      pathKind: (path) => path.endsWith("/.ssh") ? "directory" : "file",
    });

    const writableIndex = args.indexOf("--bind");
    const privateTempIndex = args.findIndex((value, index) => value === "--tmpfs" && args[index + 1] === "/tmp");
    const deniedDirectoryIndex = args.findIndex(
      (value, index) => value === "--tmpfs" && args[index + 1] === "/home/user/.ssh",
    );
    const deniedFileIndex = args.findIndex(
      (value, index) => value === "--ro-bind" && args[index + 1] === "/dev/null",
    );
    expect(writableIndex).toBeGreaterThan(-1);
    expect(privateTempIndex).toBeGreaterThan(writableIndex);
    expect(deniedDirectoryIndex).toBeGreaterThan(writableIndex);
    expect(deniedFileIndex).toBeGreaterThan(writableIndex);
    expect(args.slice(-4)).toEqual(["--", "/usr/bin/git", "status", "--short"]);
    expect(args).toContain("--unshare-net");
  });

  test("shadows a missing denied path without remounting the host writable root", () => {
    const args = buildBubblewrapArgv(policy({ deniedPaths: ["/work/project/.env"] }), {
      systemMounts: ["/usr"],
      pathKind: (path) => path === "/work/project" ? "directory" : undefined,
      pathEntries: () => ["notes.txt", "src"],
    });
    const writableIndex = args.indexOf("--bind");
    const shadowIndex = args.findIndex((value, offset) => value === "--tmpfs"
      && args[offset + 1] === "/work/project");
    const siblingIndex = args.findIndex((value, offset) => value === "--bind"
      && args[offset + 1] === "/work/project/notes.txt"
      && args[offset + 2] === "/work/project/notes.txt");
    const maskIndex = args.findIndex((value, offset) => value === "--perms"
      && args[offset + 1] === "000"
      && args[offset + 2] === "--tmpfs"
      && args[offset + 3] === "/work/project/.env");
    const remountIndex = args.findIndex((value, offset) => value === "--remount-ro"
      && args[offset + 1] === "/work/project");
    expect(shadowIndex).toBeGreaterThan(writableIndex);
    expect(siblingIndex).toBeGreaterThan(shadowIndex);
    expect(maskIndex).toBeGreaterThan(siblingIndex);
    expect(remountIndex).toBeGreaterThan(maskIndex);
  });

  test("shadows only the nearest existing ancestor for a nested missing denied file", () => {
    const args = buildBubblewrapArgv(policy({ deniedPaths: ["/work/project/cache/private/key"] }), {
      systemMounts: ["/usr"],
      pathKind: (path) => path === "/work/project/cache" || path === "/work/project"
        ? "directory"
        : undefined,
      pathEntries: () => ["public.txt"],
    });
    const writableIndex = args.indexOf("--bind");
    const shadowIndex = args.findIndex((value, offset) => value === "--tmpfs"
      && args[offset + 1] === "/work/project/cache");
    const siblingIndex = args.findIndex((value, offset) => value === "--bind"
      && args[offset + 1] === "/work/project/cache/public.txt");
    const maskIndex = args.findIndex((value, offset) => value === "--tmpfs"
      && args[offset + 1] === "/work/project/cache/private/key");
    const remountIndex = args.findIndex((value, offset) => value === "--remount-ro"
      && args[offset + 1] === "/work/project/cache");
    expect(shadowIndex).toBeGreaterThan(writableIndex);
    expect(siblingIndex).toBeGreaterThan(shadowIndex);
    expect(maskIndex).toBeGreaterThan(siblingIndex);
    expect(remountIndex).toBeGreaterThan(maskIndex);
  });

  test("keeps existing denied masks after missing-path shadows", () => {
    const args = buildBubblewrapArgv(policy({
      deniedPaths: ["/work/project/secret.txt", "/work/project/.env"],
    }), {
      systemMounts: ["/usr"],
      pathKind: (path) => {
        if (path === "/work/project/secret.txt") return "file";
        if (path === "/work/project") return "directory";
        return undefined;
      },
      pathEntries: () => ["secret.txt", "notes.txt"],
    });
    const shadowIndex = args.findIndex((value, offset) => value === "--tmpfs"
      && args[offset + 1] === "/work/project");
    const reboundSecretIndex = args.findIndex((value, offset) => value === "--bind"
      && args[offset + 1] === "/work/project/secret.txt");
    const secretMaskIndex = args.findIndex((value, offset) => value === "--ro-bind"
      && args[offset + 1] === "/dev/null"
      && args[offset + 2] === "/work/project/secret.txt");
    expect(reboundSecretIndex).toBeGreaterThan(shadowIndex);
    expect(secretMaskIndex).toBeGreaterThan(reboundSecretIndex);
  });

  test("uses the host network only when the policy permits it", () => {
    const denied = buildBubblewrapArgv(policy({ deniedPaths: [] }), { systemMounts: ["/usr"] });
    const host = buildBubblewrapArgv(policy({ network: "host", deniedPaths: [] }), { systemMounts: ["/usr"] });
    expect(denied).toContain("--unshare-net");
    expect(host).not.toContain("--unshare-net");
  });

  test("mounts the shell executable directory read-only when no mount covers it", () => {
    const args = buildBubblewrapArgv(policy({
      executable: "/run/current-system/sw/bin/bash",
      args: ["-lc", "git status --short"],
      readOnlyPaths: [],
      readWritePaths: ["/work/project"],
      deniedPaths: [],
    }), { systemMounts: ["/usr", "/bin"], pathKind: () => undefined });

    const roIndex = args.findIndex(
      (value, index) => value === "--ro-bind"
        && args[index + 1] === "/run/current-system/sw/bin"
        && args[index + 2] === "/run/current-system/sw/bin",
    );
    const writableIndex = args.indexOf("--bind");
    expect(roIndex).toBeGreaterThan(-1);
    // Read-only executable mount stays before the writable project mount.
    expect(roIndex).toBeLessThan(writableIndex);
    expect(args.slice(-3)).toEqual(["/run/current-system/sw/bin/bash", "-lc", "git status --short"]);
  });

  test("does not add a redundant executable mount when a system mount covers it", () => {
    const args = buildBubblewrapArgv(policy({ deniedPaths: [] }), {
      systemMounts: ["/usr"],
      pathKind: () => undefined,
    });
    const executableDirMounts = args.filter(
      (value, index) => value === "--ro-bind" && args[index + 1] === "/usr/bin",
    );
    expect(executableDirMounts).toHaveLength(0);
  });

  test("rejects a working directory that is outside every mount", () => {
    expect(() => buildBubblewrapArgv(policy({
      cwd: "/outside",
      readOnlyPaths: [],
      readWritePaths: ["/work/project"],
      deniedPaths: [],
    }), { systemMounts: [] })).toThrow("Working directory is not visible in the sandbox");
  });

  test("spawns exact argv, environment, stdin, and separate output streams", async () => {
    const adapter = new FakeAdapter();
    const backend = createBubblewrapBackend({
      processAdapter: adapter,
      systemMounts: ["/usr"],
      pathKind: () => undefined,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdin = Buffer.from("input");
    const handle = backend.spawn(policy({ deniedPaths: [] }), {
      stdin,
      onStdout: (chunk) => stdout.push(Buffer.from(chunk).toString()),
      onStderr: (chunk) => stderr.push(Buffer.from(chunk).toString()),
    });

    expect(backend.id).toBe("bubblewrap");
    expect(adapter.requests[0]!.stdin).toEqual(stdin);
    expect(adapter.requests[0]!.env).toEqual({ PATH: "/usr/bin", PI_SESSION_ID: "session" });
    expect(adapter.requests[0]!.args.slice(-4)).toEqual(["--", "/usr/bin/git", "status", "--short"]);
    adapter.requests[0]!.onStdout(Buffer.from("out"));
    adapter.requests[0]!.onStderr(Buffer.from("err"));
    expect(await handle.completed).toEqual({ exitCode: 0, signal: null });
    expect(stdout).toEqual(["out"]);
    expect(stderr).toEqual(["err"]);
  });

  test("terminates the process tree on abort and escalates after the grace period", async () => {
    const adapter = new FakeAdapter();
    adapter.autoComplete = undefined;
    const controller = new AbortController();
    const backend = createBubblewrapBackend({
      processAdapter: adapter,
      systemMounts: ["/usr"],
      pathKind: () => undefined,
      killGraceMs: 5,
    });
    const handle = backend.spawn(policy({ deniedPaths: [] }), {
      onStdout: () => {},
      onStderr: () => {},
      signal: controller.signal,
    });
    controller.abort();
    expect(adapter.kills[0]).toBe("SIGTERM");
    await Bun.sleep(10);
    expect(adapter.kills).toEqual(["SIGTERM", "SIGKILL"]);
    adapter.complete();
    await expect(handle.completed).rejects.toThrow("aborted");
  });

  test("terminates the process tree on timeout and preserves normal nonzero exits", async () => {
    const timedAdapter = new FakeAdapter();
    timedAdapter.autoComplete = undefined;
    const backend = createBubblewrapBackend({
      processAdapter: timedAdapter,
      systemMounts: ["/usr"],
      pathKind: () => undefined,
      killGraceMs: 50,
    });
    const timedHandle = backend.spawn(policy({ deniedPaths: [] }), {
      onStdout: () => {},
      onStderr: () => {},
      timeoutSeconds: 0.005,
    });
    await Bun.sleep(10);
    expect(timedAdapter.kills[0]).toBe("SIGTERM");
    timedAdapter.complete();
    await expect(timedHandle.completed).rejects.toThrow("timeout:0.005");

    const exitAdapter = new FakeAdapter();
    exitAdapter.autoComplete = { exitCode: 7, signal: null };
    const exitBackend = createBubblewrapBackend({
      processAdapter: exitAdapter,
      systemMounts: ["/usr"],
      pathKind: () => undefined,
    });
    const exitHandle = exitBackend.spawn(policy({ deniedPaths: [] }), {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(await exitHandle.completed).toEqual({ exitCode: 7, signal: null });
  });
});

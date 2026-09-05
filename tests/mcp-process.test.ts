import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod, readlink, realpath } from "node:fs/promises";
import { mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBubblewrapArgv, createBubblewrapBackend, NodeBubblewrapProcessAdapter, probeBubblewrap } from "../src/sandbox/linux";
import type { SandboxPolicy, SandboxProcessExit, SandboxProcessHandle } from "../src/sandbox/types";
import {
  createMcpProcessAdapter, buildMcpProcessPolicy as buildPolicy, MCP_SYSTEM_MOUNTS, MCP_SCAN_MAX_DEPTH, MCP_SCAN_MAX_MASKS,
  manageMcpProcessHandle, mcpConfigOverlapsSystemSources, MCP_MAX_PENDING_WRITE_BYTES, MCP_MAX_PENDING_WRITES,
} from "../src/mcp-process";

const linux = process.platform === "linux";
// Policy tests never depend on or inspect the user's real PUM config.
let fixtureConfig: string;
beforeAll(async () => { fixtureConfig = await mkdtemp(join(tmpdir(), "pum-mcp-config-")); });
afterAll(async () => { await rm(fixtureConfig, { recursive: true, force: true }); });
const buildMcpProcessPolicy: typeof buildPolicy = (request, options) =>
  buildPolicy(request, { configDir: fixtureConfig, ...options });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockHandle() {
  const exit = deferred<SandboxProcessExit>();
  const writes: ReturnType<typeof deferred<void>>[] = [];
  let closes = 0;
  let kills = 0;
  const child: SandboxProcessHandle = {
    completed: exit.promise,
    write() { const write = deferred<void>(); writes.push(write); return write.promise; },
    closeInput() { closes++; },
    kill() { kills++; exit.reject(new Error("PRIVATE backend exception")); },
  };
  return { child, exit, writes, closes: () => closes, kills: () => kills };
}

describe("MCP mandatory native policy", () => {
  test("rejects invalid root without fallback", async () => {
    await expect(createMcpProcessAdapter().spawn({
      executable: "/bin/cat", args: [], cwd: "/", onStdout() {}, onStderr() {},
    })).rejects.toThrow("native policy");
  });
  test("revoked pending requests cannot start either", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(createMcpProcessAdapter().spawn({
      executable: "/bin/cat", args: [], cwd: "/", signal: abort.signal, onStdout() {}, onStderr() {},
    })).rejects.toThrow("native policy");
  });
});

describe.skipIf(!linux)("MCP readonly live-project planning", () => {
  test("recursively masks known secrets/config, keeps live data readonly, never mounts executable parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pum-mcp-plan-"));
    try {
      const cwd = join(root, "project");
      const configDir = join(cwd, "pum-private");
      const external = join(root, "runtime");
      await mkdir(join(cwd, "packages", "api"), { recursive: true });
      await mkdir(configDir);
      await mkdir(external);
      await writeFile(join(cwd, "packages", "api", ".env.prod"), "secret");
      await writeFile(join(cwd, "packages", "api", "private.key"), "secret");
      await writeFile(join(configDir, "auth.json"), "secret");
      const executable = join(external, "server");
      await writeFile(executable, "#!/bin/sh\ncat\n");
      await chmod(executable, 0o700);
      const policy = await buildMcpProcessPolicy({ cwd, executable, args: ["$(literal); argument"] }, { configDir });
      expect(policy.readWritePaths).toEqual([]);
      expect(policy.network).toBe("deny");
      expect(policy.readOnlyPaths).toEqual([cwd, executable]);
      expect(policy.deniedPaths.sort()).toEqual([configDir, join(cwd, "packages/api/.env.prod"), join(cwd, "packages/api/private.key")].sort());
      expect(policy.environment).toEqual({ PATH: "/usr/bin:/bin", HOME: "/pum-mcp-private-tmp", TMPDIR: "/pum-mcp-private-tmp", LANG: "C.UTF-8" });
      const argv = buildBubblewrapArgv(policy, { systemMounts: MCP_SYSTEM_MOUNTS });
      expect(argv).toContain("--unshare-net");
      expect(argv).not.toContain("--bind");
      expect(argv).not.toContain(external);
      expect(argv).not.toContain("/etc");
      expect(argv.slice(-3)).toEqual(["--", executable, "$(literal); argument"]);
      expect(argv.indexOf(configDir, argv.indexOf("--tmpfs"))).toBeGreaterThan(argv.indexOf(executable));
      // Temp masking must never cover a project launched beneath host /tmp.
      expect(policy.privateTemp.startsWith(cwd)).toBe(false);
      expect(cwd.startsWith(policy.privateTemp + "/")).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("does not traverse ordinary symlinks; refuses sensitive links, config overlap, and missing visible config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pum-mcp-links-"));
    try {
      const cwd = join(root, "project");
      await mkdir(cwd);
      const request = { cwd, executable: "/bin/cat", args: [] };
      await symlink(cwd, join(cwd, "loop"));
      const policy = await buildMcpProcessPolicy(request);
      expect(policy.deniedPaths).toEqual([]);
      await expect(buildMcpProcessPolicy(request, { configDir: root })).rejects.toThrow("native policy");
      await expect(buildMcpProcessPolicy(request, { configDir: join(cwd, "missing") })).rejects.toThrow("native policy");
      await symlink(cwd, join(root, "project-alias"));
      await expect(buildMcpProcessPolicy({ ...request, cwd: join(root, "project-alias") })).rejects.toThrow("native policy");
      await symlink(join(root, "missing"), join(cwd, ".env"));
      await expect(buildMcpProcessPolicy(request)).rejects.toThrow("native policy");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("canonical overlap comparison covers all merged-/usr aliases and nested config paths", () => {
    // Deterministic topology fixture; no host system/config writes or native claim.
    for (const name of ["bin", "sbin", "lib", "lib64"]) {
      const supplied = `/${name}/pum`;
      const canonical = `/usr/${name}/pum`;
      const sources = [`/${name}`, `/usr/${name}`];
      expect(mcpConfigOverlapsSystemSources([supplied, canonical], sources)).toBe(true);
      expect(mcpConfigOverlapsSystemSources([canonical], [sources[1]!])).toBe(true);
      expect(mcpConfigOverlapsSystemSources(["/usr"], [sources[1]!])).toBe(true);
      expect(mcpConfigOverlapsSystemSources(["/"], sources)).toBe(true);
      expect(mcpConfigOverlapsSystemSources([`/usr/${name}-private/pum`], sources)).toBe(false);
    }
    expect(mcpConfigOverlapsSystemSources(["/usr/pum"], ["/usr"])).toBe(true);
    expect(mcpConfigOverlapsSystemSources(["/home/user/.config/pum", "/srv/pum"], ["/usr", "/usr/lib", "/lib"])).toBe(false);
  });

  test("rejects every system source spelling, canonical subtree, and ancestor overlap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pum-mcp-system-overlap-"));
    try {
      const request = { cwd, executable: "/bin/cat", args: [] };
      for (const mount of MCP_SYSTEM_MOUNTS) {
        const canonical = await realpath(mount);
        // Existing sources make these substantive overlap tests, not ENOENT tests.
        for (const configDir of new Set([mount, canonical, "/usr", "/"])) {
          await expect(buildMcpProcessPolicy(request, { configDir })).rejects.toThrow("native policy");
        }
        // Never create a config or sentinel in host runtime/config directories.
        for (const base of new Set([mount, canonical])) {
          await expect(buildMcpProcessPolicy(request, { configDir: join(base, "pum-harmless-missing-config") }))
            .rejects.toThrow("native policy");
        }
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("supports existing default-layout and custom config outside runtime sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pum-mcp-outside-"));
    try {
      const cwd = join(root, "project");
      await mkdir(cwd);
      for (const configDir of [join(root, "home/.config/pum"), join(root, "custom-state")]) {
        await mkdir(configDir, { recursive: true });
        const policy = await buildMcpProcessPolicy({ cwd, executable: "/bin/cat", args: [] }, { configDir });
        expect(policy.readOnlyPaths).not.toContain(configDir);
        expect(policy.readWritePaths).toEqual([]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects malformed, missing, file-replaced and linked config boundaries outside visible roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pum-mcp-boundary-"));
    try {
      const cwd = join(root, "project");
      const configDir = join(root, "config");
      await mkdir(cwd);
      const request = { cwd, executable: "/bin/cat", args: [] };
      for (const invalid of ["relative", "", "/", `${root}/bad\nname`, `${root}/bad\u202ename`, `${root}/./project`, `${root}/missing/../project`, configDir]) {
        await expect(buildMcpProcessPolicy(request, { configDir: invalid })).rejects.toThrow("native policy");
      }
      await mkdir(configDir);
      await expect(buildMcpProcessPolicy(request, { configDir })).resolves.toBeDefined();
      await rm(configDir, { recursive: true });
      await writeFile(configDir, "harmless replacement");
      await expect(buildMcpProcessPolicy(request, { configDir })).rejects.toThrow("native policy");
      await rm(configDir);
      await symlink(fixtureConfig, configDir);
      await expect(buildMcpProcessPolicy(request, { configDir })).rejects.toThrow("native policy");
      await rm(configDir);
      await symlink(join(root, "missing"), configDir);
      await expect(buildMcpProcessPolicy(request, { configDir })).rejects.toThrow("native policy");
      await rm(configDir);
      await symlink(root, join(root, "ancestor-alias"));
      await expect(buildMcpProcessPolicy(request, { configDir: join(root, "ancestor-alias/project") })).rejects.toThrow("native policy");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("detects config and ancestor directory replacement during policy construction", async () => {
    for (const replaceAncestor of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), "pum-mcp-replaced-"));
      try {
        const cwd = join(root, "project");
        const parent = join(root, "state");
        const configDir = join(parent, "config");
        await mkdir(cwd);
        await mkdir(configDir, { recursive: true });
        let checks = 0;
        // The second abort check is the scan boundary, after initial identity
        // capture. Replace synchronously there; no timing-dependent race test.
        const signal = { get aborted() {
          if (++checks === 2) {
            const target = replaceAncestor ? parent : configDir;
            renameSync(target, `${target}-old`);
            mkdirSync(configDir, { recursive: true });
          }
          return false;
        } } as AbortSignal;
        await expect(buildMcpProcessPolicy({ cwd, executable: "/bin/cat", args: [], signal }, { configDir }))
          .rejects.toThrow("native policy");
        expect(checks).toBeGreaterThanOrEqual(2);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  test("fails closed when recursive sensitive masks exceed the bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "pum-mcp-masks-"));
    try {
      await Promise.all(Array.from({ length: MCP_SCAN_MAX_MASKS + 1 }, (_, i) => writeFile(join(root, `.env.${i}`), "secret")));
      await expect(buildMcpProcessPolicy({ cwd: root, executable: "/bin/cat", args: [] })).rejects.toThrow("native policy");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fails closed on recursion bound, abort, malformed arguments and executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pum-mcp-bounds-"));
    try {
      const request = { cwd: root, executable: "/bin/cat", args: [] };
      const abort = new AbortController(); abort.abort();
      await expect(buildMcpProcessPolicy({ ...request, signal: abort.signal })).rejects.toThrow("native policy");
      await expect(buildMcpProcessPolicy({ ...request, args: ["secret\nargument"] })).rejects.toThrow("native policy");
      await expect(buildMcpProcessPolicy({ ...request, executable: root })).rejects.toThrow("native policy");
      await expect(buildMcpProcessPolicy({ ...request, executable: "/not-present/private-secret" })).rejects.toThrow("native policy");
      let nested = root;
      for (let i = 0; i <= MCP_SCAN_MAX_DEPTH; i++) { nested = join(nested, "nested"); await mkdir(nested); }
      await expect(buildMcpProcessPolicy(request)).rejects.toThrow("native policy");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("persistent MCP transport lifecycle (no filesystem authority)", () => {
  test("bounds pending writes and bytes, propagates backpressure, rejects after close", async () => {
    const mock = mockHandle();
    const handle = manageMcpProcessHandle(mock.child, new AbortController().signal);
    const write = handle.write("hello\n");
    let resolved = false;
    void write.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    mock.writes[0]!.resolve();
    await write;
    await expect(handle.write("x".repeat(MCP_MAX_PENDING_WRITE_BYTES + 1))).rejects.toThrow("native policy");
    const writes = Array.from({ length: MCP_MAX_PENDING_WRITES }, () => handle.write("x"));
    await expect(handle.write("x")).rejects.toThrow("native policy");
    handle.close();
    expect(mock.closes()).toBe(1);
    handle.close();
    expect(mock.closes()).toBe(1);
    await expect(handle.write("late")).rejects.toThrow("native policy");
    const all = Promise.allSettled(writes);
    mock.exit.resolve({ exitCode: 0, signal: null });
    await handle.completed;
    expect((await all).every((result) => result.status === "rejected")).toBe(true);
    expect(mock.kills()).toBe(0);
  });
  test("bounds aggregate pending bytes and refuses missing persistent stdin", async () => {
    const mock = mockHandle();
    const handle = manageMcpProcessHandle(mock.child, new AbortController().signal);
    const pending = handle.write("x".repeat(MCP_MAX_PENDING_WRITE_BYTES));
    void pending.catch(() => {});
    await expect(handle.write("x")).rejects.toThrow("native policy");
    handle.kill();
    await expect(pending).rejects.toThrow("native policy");
    await expect(handle.completed).rejects.toThrow("native policy");
    const unsupported = mockHandle();
    delete unsupported.child.write;
    expect(() => manageMcpProcessHandle(unsupported.child, new AbortController().signal)).toThrow("native policy");
    expect(unsupported.kills()).toBe(1);
  });

  test("abort cancels blocked writes and redacts backend errors", async () => {
    const mock = mockHandle();
    const abort = new AbortController();
    const handle = manageMcpProcessHandle(mock.child, abort.signal);
    const write = handle.write("blocked");
    void write.catch(() => {});
    abort.abort();
    await expect(write).rejects.toThrow("native policy");
    await expect(handle.completed).rejects.toThrow("native policy");
    expect(mock.kills()).toBe(1);
    mock.writes[0]!.resolve(); // Late write callbacks cannot revive a closed handle.
    await expect(handle.write("late")).rejects.toThrow("native policy");
  });
  test("graceful close escalates for a server which does not exit", async () => {
    const mock = mockHandle();
    const handle = manageMcpProcessHandle(mock.child, new AbortController().signal);
    handle.close();
    expect(mock.closes()).toBe(1);
    expect(mock.kills()).toBe(0);
    await expect(handle.completed).rejects.toThrow("native policy");
    expect(mock.kills()).toBe(1);
  });
});

describe("isolated Linux persistent stdin plumbing", () => {
  test.skipIf(!linux)("preserves bytes and argv without shell interpolation; existing one-shot stdin still closes", async () => {
    const adapter = new NodeBubblewrapProcessAdapter();
    let output = "";
    const child = adapter.spawn({ executable: "/bin/cat", args: [], cwd: "/", env: {},
      persistentStdin: true, onStdout: (data) => { output += data.toString(); }, onStderr() {} });
    await child.write!("first\n");
    await child.write!("second\n");
    child.closeInput!();
    expect((await child.completed).exitCode).toBe(0);
    expect(output).toBe("first\nsecond\n");
    output = "";
    const oneShot = adapter.spawn({ executable: "/bin/cat", args: [], cwd: "/", env: {},
      stdin: Buffer.from("one-shot"), onStdout: (data) => { output += data.toString(); }, onStderr() {} });
    expect(oneShot.write).toBeUndefined();
    expect((await oneShot.completed).exitCode).toBe(0);
    expect(output).toBe("one-shot");
    output = "";
    const literal = adapter.spawn({ executable: "/usr/bin/printf", args: ["%s", "$(never-execute); literal"],
      cwd: "/", env: {}, onStdout: (data) => { output += data.toString(); }, onStderr() {} });
    await literal.completed;
    expect(output).toBe("$(never-execute); literal");
  });

  test.skipIf(!linux)("rejects revoked spawn and invalid timeout before process creation", () => {
    let spawned = false;
    const backend = createBubblewrapBackend({ processAdapter: { spawn() { spawned = true; throw new Error("unexpected"); } } });
    const controller = new AbortController();
    controller.abort();
    expect(() => backend.spawn({} as SandboxPolicy, {
      signal: controller.signal, persistentStdin: true, onStdout() {}, onStderr() {},
    })).toThrow("aborted");
    expect(() => backend.spawn({} as SandboxPolicy, {
      timeoutSeconds: NaN, persistentStdin: true, onStdout() {}, onStderr() {},
    })).toThrow("Invalid timeout");
    expect(spawned).toBe(false);
  });
});

// The real probe is the only criterion for native enforcement tests. No OS setup or fallback.
const capability = linux ? await probeBubblewrap() : undefined;
test.skipIf(capability?.state !== "enforced")("real MCP adapter confines scratch live project, secrets, executable sibling, environment and network", async () => {
  const root = await mkdtemp(join(tmpdir(), "pum-mcp-fixture-"));
  let handle: ReturnType<typeof manageMcpProcessHandle> | undefined;
  try {
    const cwd = join(root, "project");
    const configDir = join(cwd, "pum-private");
    await mkdir(join(cwd, "nested"), { recursive: true });
    await mkdir(configDir);
    await writeFile(join(cwd, "nested", ".env.production"), "secret");
    await writeFile(join(configDir, "auth.json"), "secret");
    await writeFile(join(root, "sibling-secret"), "secret");
    const executable = join(root, "server");
    await writeFile(executable, `#!/bin/sh
set -eu
if printf mutation > ./must-not-exist; then exit 11; fi
test ! -s nested/.env.production
test ! -e pum-private/auth.json
test ! -e '${join(root, "sibling-secret")}'
test ! -e /etc/shadow
test -z "\${OPENAI_API_KEY-}"
test -z "\${NODE_OPTIONS-}"
printf temporary > "$HOME/allowed"
readlink /proc/self/ns/net
cat
`);
    await chmod(executable, 0o700);
    let output = "";
    handle = await createMcpProcessAdapter({ configDir }).spawn({ cwd, executable, args: [],
      onStdout(data) { output += Buffer.from(data).toString(); }, onStderr() {} });
    await handle.write('{"jsonrpc":"2.0","id":1}\n');
    handle.close();
    expect(await handle.completed).toMatchObject({ exitCode: 0 });
    const [network, ...lines] = output.split("\n");
    expect(network).not.toBe(await readlink("/proc/self/ns/net"));
    expect(lines.join("\n")).toBe('{"jsonrpc":"2.0","id":1}\n');
  } finally { handle?.kill(); await rm(root, { recursive: true, force: true }); }
});

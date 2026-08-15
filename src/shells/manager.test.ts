import { describe, expect, test } from "bun:test";
import { ShellManager } from "./manager";
import type {
  CreateShellInput,
  ShellClock,
  ShellFileOperations,
  ShellManagerOptions,
  ShellOutputWriter,
  ShellProcessExit,
  ShellProcessSpawnRequest,
} from "./types";

class FakeClock implements ShellClock {
  time = 1_000;
  private id = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

class MemoryWriter implements ShellOutputWriter {
  chunks: Uint8Array[] = [];
  closed = false;
  removed = false;
  constructor(readonly path: string) {}
  async write(chunk: Uint8Array): Promise<void> { this.chunks.push(chunk.slice()) }
  async close(): Promise<void> { this.closed = true }
  async remove(): Promise<void> { this.closed = true; this.removed = true }
  bytes(): Uint8Array { return Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))) }
  text(): string { return new TextDecoder().decode(this.bytes()) }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const owner = { sessionId: "session-1", agentId: null, label: "main" } as const;
const otherOwner = { sessionId: "session-2", agentId: "agent-2", label: "worker" } as const;

function input(overrides: Partial<CreateShellInput> = {}): CreateShellInput {
  return {
    id: "shell-1",
    owner,
    executable: "server",
    args: ["--port", "3000"],
    cwd: "/project",
    ...overrides,
  };
}

function harness(overrides: Partial<ShellManagerOptions> & {
  spawn?: (request: ShellProcessSpawnRequest) => { completed: Promise<ShellProcessExit>; kill(signal?: string): void };
} = {}) {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock();
  const requests: ShellProcessSpawnRequest[] = [];
  const writers: MemoryWriter[] = [];
  let ids = 0;
  const files: ShellFileOperations = overrides.files ?? {
    async createPrivateOutput(id) {
      const writer = new MemoryWriter(`/private/${id}.log`);
      writers.push(writer);
      return writer;
    },
    async readOutput(path) {
      return writers.find((writer) => writer.path === path)?.bytes() ?? new Uint8Array();
    },
  };
  const manager = new ShellManager({
    process: overrides.process ?? {
      spawn(request) {
        requests.push(request);
        return overrides.spawn?.(request) ?? {
          completed: new Promise<ShellProcessExit>(() => {}),
          kill() {},
        };
      },
    },
    files,
    clock,
    safety: overrides.safety ?? { check() {} },
    environment: overrides.environment ?? { PATH: "/bin", HOME: "/home/test", NODE_OPTIONS: "unsafe" },
    runningLimit: overrides.runningLimit,
    retainedLimit: overrides.retainedLimit,
    outputLimitBytes: overrides.outputLimitBytes,
    terminationGraceMs: overrides.terminationGraceMs,
    createId: overrides.createId ?? (() => `generated-${++ids}`),
    onCompleted: overrides.onCompleted,
  });
  return { manager, clock, requests, writers };
}

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe("ShellManager", () => {
  test("checks the complete structured process before creating output or spawning", async () => {
    const checked: unknown[] = [];
    const h = harness({
      safety: {
        check(request) {
          checked.push(request);
          throw new Error("blocked by Check mode");
        },
      },
    });

    await expect(h.manager.create(input({ projectCwd: "/project-root" })))
      .rejects.toThrow("blocked by Check mode");
    expect(checked).toEqual([{
      proposal: {
        kind: "process",
        source: "managed-shell",
        executable: "server",
        args: ["--port", "3000"],
        cwd: "/project",
        operation: "start",
        env: {},
        shellName: undefined,
      },
      requester: { kind: "main", sessionId: "session-1", cwd: "/project-root" },
    }]);
    expect(h.requests).toEqual([]);
    expect(h.writers).toEqual([]);
    expect(h.manager.list()).toEqual([]);
  });

  test("binds sanitized environment additions into the checked proposal", async () => {
    const checked: any[] = [];
    const h = harness({ safety: { check(request) { checked.push(request); } } });

    await h.manager.create(input({ env: { API_BASE: "https://example.test" } }));

    expect(checked[0].proposal.env).toEqual({ API_BASE: "https://example.test" });
    expect(h.requests[0]?.env.API_BASE).toBe("https://example.test");
  });

  test("refuses an execution-hijacking variable before any process or output exists", async () => {
    const checked: unknown[] = [];
    const h = harness({ safety: { check(request) { checked.push(request); } } });

    await expect(h.manager.create(input({ env: { GIT_SSH_COMMAND: "./evil.sh" } })))
      .rejects.toThrow();
    expect(checked).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(h.writers).toEqual([]);
  });

  test("starts direct argv, waits for readiness, and captures marked output", async () => {
    const exit = deferred<ShellProcessExit>();
    const completed: string[] = [];
    const h = harness({
      spawn: (request) => ({ completed: exit.promise, kill() {} }),
      onCompleted(snapshot) { completed.push(snapshot.id); },
    });
    const starting = h.manager.create(input({ waitFor: "ready on \\d+", waitTimeoutMs: 5_000 }));
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ executable: "server", args: ["--port", "3000"], cwd: "/project" });
    expect(h.requests[0]?.env.NODE_OPTIONS).toBeUndefined();
    h.requests[0]?.onStderr(new TextEncoder().encode("booting"));
    h.requests[0]?.onStdout(new TextEncoder().encode("ready on 3000\n"));
    const ready = await starting;
    expect(ready).toMatchObject({ state: "running", ready: true, readyAt: 1_000 });
    await flush();
    expect(h.writers[0]?.text()).toBe("\n--- stderr ---\nbooting\n--- stdout ---\nready on 3000\n");

    exit.resolve({ exitCode: 0, signal: null });
    await flush(30);
    expect(h.manager.inspect("shell-1")).toMatchObject({ state: "exited", exitCode: 0, finishedAt: 1_000 });
    expect(completed).toEqual(["shell-1"]);
    await h.manager.terminate("shell-1");
    expect(completed).toEqual(["shell-1"]);
  });

  test("caps captured bytes but continues draining and can match later readiness output", async () => {
    const exit = deferred<ShellProcessExit>();
    const h = harness({ outputLimitBytes: 24, spawn: () => ({ completed: exit.promise, kill() {} }) });
    const starting = h.manager.create(input({ waitFor: "READY", waitTimeoutMs: 5_000 }));
    await flush();
    h.requests[0]?.onStdout(new TextEncoder().encode("012345678901234567890123456789"));
    h.requests[0]?.onStdout(new TextEncoder().encode("READY"));
    await expect(starting).resolves.toMatchObject({ ready: true });
    await flush();
    expect(h.manager.inspect("shell-1").output).toMatchObject({ bytes: 24, truncated: true });
    expect(h.writers[0]?.bytes().byteLength).toBe(24);
    exit.resolve({ exitCode: 0, signal: null });
    await flush();
  });

  test("enforces global running and retained limits", async () => {
    const exits = [deferred<ShellProcessExit>(), deferred<ShellProcessExit>()];
    let spawnIndex = 0;
    const h = harness({
      runningLimit: 1,
      retainedLimit: 2,
      spawn: () => ({ completed: exits[spawnIndex++]!.promise, kill() {} }),
    });
    await h.manager.create(input({ id: "one" }));
    await expect(h.manager.create(input({ id: "two" }))).rejects.toThrow("Running shell limit reached (1)");
    exits[0]!.resolve({ exitCode: 0, signal: null });
    await flush();
    await h.manager.create(input({ id: "two" }));
    await expect(h.manager.create(input({ id: "three" }))).rejects.toThrow("Retained shell limit reached (2)");
    exits[1]!.resolve({ exitCode: 0, signal: null });
    await flush();
  });

  test("reserves limit slots across concurrent private-output creation", async () => {
    const gate = deferred<void>();
    const writers: MemoryWriter[] = [];
    const h = harness({
      runningLimit: 1,
      files: {
        async createPrivateOutput(id) {
          await gate.promise;
          const writer = new MemoryWriter(`/private/${id}.log`);
          writers.push(writer);
          return writer;
        },
        async readOutput(path) { return writers.find((writer) => writer.path === path)?.bytes() ?? new Uint8Array(); },
      },
    });
    const first = h.manager.create(input({ id: "one" }));
    await expect(h.manager.create(input({ id: "two" }))).rejects.toThrow("Running shell limit reached (1)");
    gate.resolve();
    await first;
  });

  test("sends TERM and then KILL to the complete process adapter", async () => {
    const exit = deferred<ShellProcessExit>();
    const signals: string[] = [];
    const h = harness({
      terminationGraceMs: 2_000,
      spawn: () => ({
        completed: exit.promise,
        kill(signal = "SIGTERM") {
          signals.push(signal);
          if (signal === "SIGKILL") exit.resolve({ exitCode: null, signal });
        },
      }),
    });
    await h.manager.create(input());
    const terminating = h.manager.terminate("shell-1", owner);
    expect(signals).toEqual(["SIGTERM"]);
    h.clock.advance(1_999);
    expect(signals).toEqual(["SIGTERM"]);
    h.clock.advance(1);
    await terminating;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.manager.inspect("shell-1")).toMatchObject({ state: "terminated", signal: "SIGKILL" });
  });

  test("returns bounded output tails and waits for a matching line", async () => {
    const exit = deferred<ShellProcessExit>();
    const h = harness({ spawn: () => ({ completed: exit.promise, kill() {} }) });
    await h.manager.create(input());
    h.requests[0]?.onStdout(new TextEncoder().encode("first\nsecond\n"));
    const output = h.manager.getOutput("shell-1", { lineLimit: 2, waitPattern: "done", timeoutMs: 500 }, owner);
    await flush();
    h.requests[0]?.onStdout(new TextEncoder().encode("done now\n"));
    await expect(output).resolves.toMatchObject({
      tail: "second\ndone now",
      matchingLines: ["done now"],
      matched: true,
      timedOut: false,
    });
    exit.resolve({ exitCode: 0, signal: null });
    await flush();
  });

  test("enforces exact owner access and cleans all records on owner invalidation", async () => {
    const exits = [deferred<ShellProcessExit>(), deferred<ShellProcessExit>()];
    let index = 0;
    const h = harness({
      spawn: () => ({
        completed: exits[index]!.promise,
        kill() { exits[index++]!.resolve({ exitCode: null, signal: "SIGTERM" }); },
      }),
    });
    await h.manager.create(input({ id: "main" }));
    await h.manager.create(input({ id: "child", owner: otherOwner }));
    expect(() => h.manager.inspect("main", otherOwner)).toThrow("Shell not found");
    expect(h.manager.list(owner).map((shell) => shell.id)).toEqual(["main"]);
    await h.manager.invalidateSession("session-1");
    expect(h.manager.list().map((shell) => shell.id)).toEqual(["child"]);
    expect(h.writers[0]?.removed).toBe(true);
    await h.manager.invalidateAgent("session-2", "agent-2");
    expect(h.manager.list()).toEqual([]);
    expect(h.writers[1]?.removed).toBe(true);
  });

  test("times out readiness and terminates the process", async () => {
    const exit = deferred<ShellProcessExit>();
    const signals: string[] = [];
    const h = harness({
      spawn: () => ({
        completed: exit.promise,
        kill(signal = "SIGTERM") {
          signals.push(signal);
          exit.resolve({ exitCode: null, signal });
        },
      }),
    });
    const starting = h.manager.create(input({ waitFor: "never", waitTimeoutMs: 100 }));
    await flush();
    h.clock.advance(100);
    await expect(starting).rejects.toThrow("readiness wait timed out");
    await flush();
    expect(signals).toEqual(["SIGTERM"]);
    expect(h.manager.inspect("shell-1").state).toBe("terminated");
  });
});

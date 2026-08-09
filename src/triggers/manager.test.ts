import { describe, expect, test } from "bun:test";
import { TriggerManager } from "./manager";
import { sanitizeTriggerEnvironment } from "./process";
import type {
  CreateTriggerInput,
  ProcessExit,
  ProcessSpawnRequest,
  TriggerClock,
  TriggerDeliveryRequest,
  TriggerManagerOptions,
  TriggerOutputWriter,
  TriggerProcessAdapter,
  TriggerRequester,
  TriggerSafetyRequest,
  TriggerTarget,
} from "./types";

class FakeClock implements TriggerClock {
  time = 1_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  runDue(): void {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
  advance(ms: number): void { this.time += ms; this.runDue() }
}

class MemoryWriter implements TriggerOutputWriter {
  chunks: Uint8Array[] = [];
  closed = false;
  removed = false;
  constructor(readonly path: string) {}
  async write(chunk: Uint8Array): Promise<void> { this.chunks.push(chunk.slice()) }
  async close(): Promise<void> { this.closed = true }
  async remove(): Promise<void> { this.closed = true; this.removed = true }
  text(): string { return new TextDecoder().decode(Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk)))) }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const requester: TriggerRequester = { kind: "main", sessionId: "session-1", cwd: "/project" };
const target: TriggerTarget = { sessionId: "session-1", agentId: null, label: "main" };

async function flushAsync(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function input(overrides: Partial<CreateTriggerInput> = {}): CreateTriggerInput {
  return {
    name: "watch build",
    target,
    executable: "tool",
    args: ["--check"],
    mode: "once",
    ...overrides,
  };
}

function harness(overrides: Partial<TriggerManagerOptions> & {
  spawn?: (request: ProcessSpawnRequest) => { completed: Promise<ProcessExit>; kill(signal?: string): void };
  deliver?: (request: TriggerDeliveryRequest) => Promise<{ deliveryId: string; turnId?: string }>;
} = {}) {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock();
  const safetyCalls: TriggerSafetyRequest[] = [];
  const spawnCalls: ProcessSpawnRequest[] = [];
  const deliveries: TriggerDeliveryRequest[] = [];
  const writers: MemoryWriter[] = [];
  let ids = 0;
  const processAdapter: TriggerProcessAdapter = {
    spawn(request) {
      spawnCalls.push(request);
      return overrides.spawn?.(request) ?? {
        completed: Promise.resolve({ exitCode: 0, signal: null }),
        kill() {},
      };
    },
  };
  const manager = new TriggerManager({
    process: processAdapter,
    clock,
    safety: overrides.safety ?? {
      check(request) { safetyCalls.push(request); return { safe: true }; },
    },
    targets: overrides.targets ?? {
      resolve(requested) { return { target: { ...requested }, value: { id: requested.label } }; },
    },
    delivery: overrides.delivery ?? {
      async deliver(request) {
        deliveries.push(request);
        return overrides.deliver?.(request) ?? { deliveryId: `delivery-${deliveries.length}`, turnId: `turn-${deliveries.length}` };
      },
    },
    files: overrides.files ?? {
      async createPrivateOutput(id) {
        const writer = new MemoryWriter(`/private/${id}-${writers.length}.log`);
        writers.push(writer);
        return writer;
      },
    },
    environment: overrides.environment ?? { PATH: "/bin", HOME: "/home/test", NODE_OPTIONS: "--require evil" },
    triggerLimit: overrides.triggerLimit,
    runningLimit: overrides.runningLimit,
    pendingLimit: overrides.pendingLimit,
    deliveredLimit: overrides.deliveredLimit,
    outputLimitBytes: overrides.outputLimitBytes,
    createId: overrides.createId ?? (() => `id-${++ids}`),
    onPersistEvent: overrides.onPersistEvent,
  });
  return { manager, clock, safetyCalls, spawnCalls, deliveries, writers };
}

describe("TriggerManager lifecycle", () => {
  test("runs a one-shot trigger, delivers it, and cleans output after target settlement", async () => {
    const h = harness({
      spawn(request) {
        request.onStdout(new TextEncoder().encode("hello"));
        request.onStderr(new TextEncoder().encode("warning"));
        return { completed: Promise.resolve({ exitCode: 3, signal: null }), kill() {} };
      },
    });
    const created = await h.manager.create(input({ id: "one" }), requester);
    expect(created.state).toBe("idle");
    h.clock.runDue();
    await flushAsync(30);

    const waiting = h.manager.inspect("one");
    expect(waiting.state).toBe("waiting");
    expect(waiting.fireCount).toBe(1);
    expect(waiting.lastResult?.exitCode).toBe(3);
    expect(waiting.output).toMatchObject({ bytes: 44, truncated: false, exists: true });
    expect(h.writers[0]?.text()).toBe("\n--- stdout ---\nhello\n--- stderr ---\nwarning");
    expect(h.deliveries[0]?.message).toContain("External trigger watch build (one) finished.");

    await h.manager.markTargetSettled("session-1", null);
    expect(h.manager.inspect("one").state).toBe("expired");
    expect(h.manager.inspect("one").output?.exists).toBe(false);
    expect(h.writers[0]?.removed).toBe(true);
  });

  test("supports pause, resume, manual run, synthetic fire, and expiry", async () => {
    const h = harness();
    await h.manager.create(input({ id: "paused", mode: "repeat", restartDelayMs: 60_000, maxFires: 4 }), requester);
    expect((await h.manager.pause("paused")).state).toBe("paused");
    h.clock.runDue();
    await flushAsync();
    expect(h.spawnCalls).toHaveLength(0);

    await h.manager.resume("paused");
    await flushAsync();
    expect(h.spawnCalls).toHaveLength(1);
    await h.manager.markTargetSettled("session-1", null);
    await h.manager.invoke("paused", "fire");
    expect(h.manager.inspect("paused").lastResult).toMatchObject({ synthetic: true, manual: true });
    await h.manager.markTargetSettled("session-1", null);
    await h.manager.invoke("paused", "run");
    await flushAsync();
    expect(h.manager.inspect("paused").lastResult).toMatchObject({ synthetic: false, manual: true });
    expect(h.safetyCalls.map((call) => call.proposal.operation)).toEqual(["create", "resume", "invoke-run"]);

    const expiring = await h.manager.create(input({ id: "expiry", expiresAt: h.clock.now() + 100 }), requester);
    expect(expiring.state).toBe("idle");
    await h.manager.pause("expiry");
    h.clock.advance(100);
    expect(h.manager.inspect("expiry").state).toBe("expired");
  });

  test("rejects repeats below 60 seconds and enforces trigger and fire limits", async () => {
    const h = harness({ triggerLimit: 1 });
    await expect(h.manager.create(input({ mode: "repeat", restartDelayMs: 59_999 }), requester)).rejects.toThrow("at least 60000ms");
    await h.manager.create(input({ id: "only", maxFires: 1 }), requester);
    await expect(h.manager.create(input({ id: "extra" }), requester)).rejects.toThrow("Trigger limit reached");
  });

  test("cancels timers and active processes and performs idempotent shutdown", async () => {
    const exit = deferred<ProcessExit>();
    let killed = 0;
    const h = harness({ spawn: () => ({ completed: exit.promise, kill() { killed += 1; } }) });
    await h.manager.create(input({ id: "active" }), requester);
    h.clock.runDue();
    await flushAsync(4);
    expect(h.manager.inspect("active").state).toBe("running");
    await h.manager.cancel("active");
    expect(killed).toBe(1);
    expect(h.manager.inspect("active").state).toBe("cancelled");
    expect(h.writers[0]?.removed).toBe(true);
    exit.resolve({ exitCode: 0, signal: null });
    await flushAsync();
    expect(h.deliveries).toHaveLength(0);
    await h.manager.shutdown();
    await h.manager.shutdown();
  });
});

describe("TriggerManager security and exact targeting", () => {
  test("authorizes the exact requester target and filters untrusted inspection", async () => {
    const h = harness();
    await h.manager.create(input({ id: "owned" }), requester);
    const other: TriggerRequester = { kind: "main", sessionId: "other", cwd: "/project" };
    await expect(h.manager.create(input({ id: "bad" }), other)).rejects.toThrow("exact trigger target");
    expect(h.manager.getTriggers(other)).toEqual([]);
    expect(() => h.manager.inspect("owned", other)).toThrow("Trigger not found");
    expect(h.manager.getTriggers()).toHaveLength(1);
  });

  test("preserves argv boundaries, sanitizes environment, and checks every process boundary", async () => {
    const h = harness();
    await h.manager.create(input({
      id: "argv",
      executable: "cmd.exe",
      args: ["/c", "echo unsafe-looking & still one arg"],
      env: { CUSTOM_OK: "yes" },
    }), requester);
    h.clock.runDue();
    await flushAsync();
    expect(h.spawnCalls[0]?.executable).toBe("cmd.exe");
    expect(h.spawnCalls[0]?.args).toEqual(["/c", "echo unsafe-looking & still one arg"]);
    expect(h.spawnCalls[0]?.env).toEqual({ PATH: "/bin", HOME: "/home/test", CUSTOM_OK: "yes" });
    expect(h.safetyCalls.map((call) => call.proposal.operation)).toEqual(["create", "start"]);
    expect(h.safetyCalls[1]?.proposal).toMatchObject({ kind: "process", source: "external-trigger" });
  });

  test("rejects dangerous environment injection and handles Windows environment names", () => {
    expect(() => sanitizeTriggerEnvironment(
      { PATH: "C:\\Windows", SystemRoot: "C:\\Windows", COMSPEC: "cmd.exe", NODE_OPTIONS: "bad" },
      { SAFE_NAME: "ok", node_options: "--require bad" },
    )).toThrow("Unsafe trigger environment variable");
    expect(sanitizeTriggerEnvironment(
      { Path: "C:\\Windows", SYSTEMROOT: "C:\\Windows", ComSpec: "cmd.exe", pathext: ".EXE", LD_PRELOAD: "bad" },
    )).toEqual({ PATH: "C:\\Windows", SystemRoot: "C:\\Windows", COMSPEC: "cmd.exe", PATHEXT: ".EXE" });
  });

  test("invalidates only the exact session or agent target", async () => {
    const h = harness();
    const childRequester: TriggerRequester = { kind: "subagent", sessionId: "session-1", agentId: "agent-a", cwd: "/project" };
    await h.manager.create(input({ id: "main" }), requester);
    await h.manager.create(input({ id: "child", target: { sessionId: "session-1", agentId: "agent-a", label: "agent-a" } }), childRequester);
    await h.manager.invalidateAgent("session-1", "agent-a");
    expect(h.manager.inspect("child").state).toBe("unavailable");
    expect(h.manager.inspect("main").state).toBe("idle");
    await h.manager.invalidateSession("session-1");
    expect(h.manager.inspect("main").state).toBe("unavailable");
  });
});

describe("TriggerManager limits, coalescing, and races", () => {
  test("caps output at the byte limit while all stdout and stderr callbacks keep draining", async () => {
    let callbackBytes = 0;
    const h = harness({
      outputLimitBytes: 32,
      spawn(request) {
        const stdout = new Uint8Array(100).fill(65);
        const stderr = new Uint8Array(100).fill(66);
        callbackBytes += stdout.byteLength;
        request.onStdout(stdout);
        callbackBytes += stderr.byteLength;
        request.onStderr(stderr);
        return { completed: Promise.resolve({ exitCode: 0, signal: null }), kill() {} };
      },
    });
    await h.manager.create(input({ id: "cap" }), requester);
    h.clock.runDue();
    await flushAsync();
    expect(callbackBytes).toBe(200);
    expect(h.manager.inspect("cap").output).toMatchObject({ bytes: 32, truncated: true });
    expect(h.writers[0]?.text().length).toBe(32);
  });

  test("enforces the global pending maximum of five and coalesces the sixth fire", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<{ deliveryId: string }>());
    let deliveryIndex = 0;
    const h = harness({
      pendingLimit: 5,
      deliver: () => gates[deliveryIndex++]!.promise,
    });
    for (let index = 0; index < 6; index += 1) {
      const id = `pending-${index}`;
      await h.manager.create(input({ id }), requester);
      await h.manager.pause(id);
      void h.manager.invoke(id, "fire");
    }
    await flushAsync();
    expect(h.manager.getTriggers().filter((item) => item.state === "waiting")).toHaveLength(5);
    expect(h.manager.inspect("pending-5").coalescedCount).toBe(1);
    for (let index = 0; index < gates.length; index += 1) gates[index]!.resolve({ deliveryId: `d-${index}` });
    await flushAsync();
  });

  test("retains at most ten delivered results and removes the oldest output", async () => {
    const h = harness({ deliveredLimit: 10, pendingLimit: 20, runningLimit: 20 });
    for (let index = 0; index < 11; index += 1) await h.manager.create(input({ id: `delivery-${index}` }), requester);
    h.clock.runDue();
    await flushAsync(30);
    expect(h.deliveries).toHaveLength(11);
    expect(h.writers[0]?.removed).toBe(true);
    expect(h.manager.inspect("delivery-0").output?.exists).toBe(false);
    expect(h.writers.slice(1).every((writer) => !writer.removed)).toBe(true);
  });

  test("reserves trigger IDs and running slots across asynchronous safety checks", async () => {
    const createGate = deferred<{ safe: boolean }>();
    const startGate = deferred<{ safe: boolean }>();
    const calls: TriggerSafetyRequest[] = [];
    const h = harness({
      runningLimit: 1,
      safety: {
        check(request) {
          calls.push(request);
          if (request.proposal.operation === "create" && request.triggerId === "same") return createGate.promise;
          if (request.proposal.operation === "start") return startGate.promise;
          return { safe: true };
        },
      },
    });
    const firstCreate = h.manager.create(input({ id: "same" }), requester);
    await flushAsync();
    await expect(h.manager.create(input({ id: "same" }), requester)).rejects.toThrow("already exists");
    createGate.resolve({ safe: true });
    await firstCreate;

    await h.manager.create(input({ id: "second" }), requester);
    h.clock.runDue();
    await flushAsync();
    expect(calls.filter((call) => call.proposal.operation === "start")).toHaveLength(1);
    expect(h.manager.inspect("second").coalescedCount).toBe(1);
    startGate.resolve({ safe: true });
    await flushAsync(30);
  });

  test("invalidating a target while resolution is pending prevents late delivery", async () => {
    const resolution = deferred<{ target: TriggerTarget; value: unknown } | undefined>();
    const h = harness({ targets: { resolve: () => resolution.promise } });
    await h.manager.create(input({ id: "resolve-race" }), requester);
    h.clock.runDue();
    await flushAsync(20);
    expect(h.manager.inspect("resolve-race").state).toBe("waiting");
    await h.manager.invalidateSession("session-1");
    resolution.resolve({ target, value: {} });
    await flushAsync();
    expect(h.deliveries).toHaveLength(0);
    expect(h.manager.inspect("resolve-race").state).toBe("unavailable");
    expect(h.writers[0]?.removed).toBe(true);
  });

  test("coalesces concurrent run requests and does not deliver after cancellation wins the race", async () => {
    const first = deferred<ProcessExit>();
    let spawns = 0;
    const h = harness({
      spawn: () => {
        spawns += 1;
        return { completed: first.promise, kill() {} };
      },
    });
    await h.manager.create(input({ id: "race", mode: "repeat", restartDelayMs: 60_000 }), requester);
    h.clock.runDue();
    await flushAsync(4);
    void h.manager.invoke("race", "run");
    await flushAsync();
    expect(spawns).toBe(1);
    expect(h.manager.inspect("race").coalescedCount).toBe(1);
    await h.manager.cancel("race");
    first.resolve({ exitCode: 0, signal: null });
    await flushAsync();
    expect(h.deliveries).toHaveLength(0);
    expect(h.manager.inspect("race").state).toBe("cancelled");
  });
});

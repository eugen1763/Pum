import { describe, expect, test } from "bun:test";
import { bindRuntimeSettingsActivity, isRuntimeIdle, RuntimeSettingsCoordinator, runtimeSettingsPendingNotice, type RuntimeSecuritySettings } from "../src/runtime-settings";

const strict: RuntimeSecuritySettings = { checkMode: "on", checkModel: "mock/check", sandboxMode: "require", checkPaths: ["/old", "/keep"], webSearch: false };
const relaxed: RuntimeSecuritySettings = { ...strict, checkMode: "off", sandboxMode: "off", checkPaths: ["/keep", "/new"], webSearch: true };
function fixture(initial = strict) {
  const coordinator = new RuntimeSettingsCoordinator();
  const applied: RuntimeSecuritySettings[] = [];
  coordinator.configure(initial, (value) => applied.push(value));
  return { coordinator, applied };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function runtime(coordinator: RuntimeSettingsCoordinator, run: () => Promise<void> = async () => {}) {
  const listeners = new Set<(event: any) => void>();
  const session = {
    isStreaming: false,
    agent: { state: { isStreaming: false }, prompt: run, continue: run },
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    prompt: run,
    executeBash: run,
    sendCustomMessage: async (_message: any, _options: any) => { await run(); },
    abort: async () => {},
    dispose: () => {},
  } as any;
  bindRuntimeSettingsActivity(session, coordinator);
  const emit = (type: string) => {
    if (type === "agent_start") session.isStreaming = true;
    if (type === "agent_end" || type === "agent_settled") session.isStreaming = false;
    for (const listener of listeners) listener({ type });
  };
  return { session, emit };
}

describe("all-affected-runtime settings boundary", () => {
  test("mixed changes revoke roots now and commit coherent relaxations only after the final runtime", () => {
    const { coordinator, applied } = fixture();
    const main = coordinator.begin("main");
    const worker = coordinator.begin("worker");
    coordinator.request(relaxed);
    expect(coordinator.snapshot()).toMatchObject({ desired: relaxed, pending: true, active: 2, effective: { ...strict, checkPaths: ["/keep"] } });
    main();
    expect(coordinator.snapshot()?.pending).toBe(true);
    worker();
    expect(coordinator.snapshot()).toMatchObject({ effective: relaxed, pending: false, active: 0 });
    expect(applied).toEqual([strict, { ...strict, checkPaths: ["/keep"] }, relaxed]);
  });
  test("tightening advances a revocation epoch before apply; desired-only and committed relaxations do not", () => {
    const coordinator = new RuntimeSettingsCoordinator();
    const observed: number[] = [];
    coordinator.configure(strict, () => observed.push(coordinator.securityEpoch));
    const release = coordinator.begin("worker");
    coordinator.request({ ...strict, checkMode: "off", webSearch: true });
    expect(coordinator.securityEpoch).toBe(0);
    coordinator.request(relaxed); // Mixed root removal tightens immediately.
    expect(coordinator.securityEpoch).toBe(1);
    expect(observed.at(-1)).toBe(1);
    release();
    expect(coordinator.securityEpoch).toBe(1);
    coordinator.request({ ...strict, checkPaths: ["/keep"] });
    expect(coordinator.securityEpoch).toBe(2);
    expect(observed.at(-1)).toBe(2);
  });
  test("tightening every field applies during running work", () => {
    const { coordinator } = fixture(relaxed);
    coordinator.begin("worker");
    coordinator.request({ ...strict, checkPaths: ["/keep"] });
    expect(coordinator.snapshot()).toMatchObject({ effective: { ...strict, checkPaths: ["/keep"] }, pending: false, active: 1 });
  });
  test("require to auto is a relaxation; auto to require is immediate", () => {
    const { coordinator } = fixture();
    const release = coordinator.begin("readonly");
    coordinator.request({ ...strict, sandboxMode: "auto" });
    expect(coordinator.snapshot()?.effective.sandboxMode).toBe("require");
    release();
    expect(coordinator.snapshot()?.effective.sandboxMode).toBe("auto");
    coordinator.begin("judge");
    coordinator.request(strict);
    expect(coordinator.snapshot()?.effective.sandboxMode).toBe("require");
  });
  test("pending desired changes replace earlier requests, including revoked pending roots", () => {
    const { coordinator } = fixture();
    const release = coordinator.begin("afk");
    coordinator.request(relaxed);
    coordinator.request({ ...strict, checkPaths: ["/keep"] });
    expect(coordinator.snapshot()?.pending).toBe(false);
    release();
    expect(coordinator.snapshot()?.effective).toEqual({ ...strict, checkPaths: ["/keep"] });
  });
  test("commit is synchronous before later admission; idle/completed records require no leases", () => {
    const { coordinator, applied } = fixture();
    const release = coordinator.begin("starting worker");
    coordinator.request(relaxed);
    release();
    coordinator.begin("next main");
    expect(applied.at(-1)).toEqual(relaxed);
    expect(coordinator.snapshot()?.active).toBe(1);
  });
  test("duplicate releases and an old lease cannot release a new generation", () => {
    const { coordinator } = fixture();
    const old = coordinator.begin("main");
    old();
    const current = coordinator.begin("main");
    old();
    coordinator.request(relaxed);
    expect(coordinator.snapshot()?.pending).toBe(true);
    current();
    expect(coordinator.snapshot()?.pending).toBe(false);
  });
  test("snapshots and callback inputs cannot mutate private desired/effective roots", () => {
    const { coordinator, applied } = fixture();
    (coordinator.snapshot()!.effective.checkPaths as string[]).push("/evil");
    (applied[0]!.checkPaths as string[]).push("/evil");
    expect(coordinator.snapshot()?.effective.checkPaths).toEqual(strict.checkPaths);
  });
  test("UI distinguishes desired pending from effective policies without dumping paths", () => {
    const { coordinator } = fixture();
    coordinator.begin("worker");
    coordinator.request(relaxed);
    const notice = runtimeSettingsPendingNotice(coordinator.snapshot());
    expect(notice).toContain("Check off (effective on)");
    expect(notice).toContain("Sandbox off (effective require)");
    expect(notice).toContain("Search on (effective off)");
    expect(notice).toContain("added Check roots (not yet effective)");
    expect(notice).not.toContain("/new");
    coordinator.settle("worker");
    expect(runtimeSettingsPendingNotice(coordinator.snapshot())).toBeUndefined();
  });
});

describe("runtime activity binding", () => {
  test("exact idle requires a live bound session, both flags and no own reservations", async () => {
    const { coordinator } = fixture();
    const gate = deferred();
    const f = runtime(coordinator, () => gate.promise);
    const idle = runtime(coordinator);
    expect(isRuntimeIdle(undefined)).toBe(false);
    expect(isRuntimeIdle({ isStreaming: false, agent: { state: { isStreaming: false } } } as any)).toBe(false);
    expect(isRuntimeIdle(f.session)).toBe(true);
    f.session.agent.state.isStreaming = true;
    expect(isRuntimeIdle(f.session)).toBe(false);
    f.session.agent.state.isStreaming = false;
    f.session.isStreaming = true;
    expect(isRuntimeIdle(f.session)).toBe(false);
    f.session.isStreaming = false;
    const observed: boolean[] = [];
    const stop = coordinator.subscribe(() => { if (coordinator.snapshot()?.active) observed.push(isRuntimeIdle(f.session)); });
    const prompt = f.session.prompt("preflight");
    const shell = f.session.executeBash("shell");
    expect(isRuntimeIdle(f.session)).toBe(false);
    expect(isRuntimeIdle(idle.session)).toBe(true);
    expect(observed).toEqual([false, false]);
    stop(); gate.resolve(); await Promise.all([prompt, shell]);
    expect(isRuntimeIdle(f.session)).toBe(true);
    f.session.dispose(); idle.session.dispose();
    expect(isRuntimeIdle(f.session)).toBe(false);
  });
  test("each independent core and user-shell owner denies idle even when both flags are false", async () => {
    const { coordinator } = fixture();
    for (const kind of ["prompt", "continue", "shell"] as const) {
      const gate = deferred(); const f = runtime(coordinator, () => gate.promise);
      const work = kind === "shell" ? f.session.executeBash("test") : f.session.agent[kind]("test");
      expect(f.session.isStreaming).toBe(false);
      expect(f.session.agent.state.isStreaming).toBe(false);
      expect(isRuntimeIdle(f.session)).toBe(false);
      gate.resolve(); await work;
      expect(isRuntimeIdle(f.session)).toBe(true);
      f.session.dispose();
    }
  });
  test("synchronous coordinator disposal during owner publication fails closed without leaking", async () => {
    for (const kind of ["prompt", "core", "shell"] as const) {
      const { coordinator } = fixture(); let dispatched = 0;
      const f = runtime(coordinator, async () => { dispatched++; });
      const stop = coordinator.subscribe(() => { if (coordinator.snapshot()?.active) f.session.dispose(); });
      const work = kind === "prompt" ? f.session.prompt("test") : kind === "core" ? f.session.agent.prompt("test") : f.session.executeBash("test");
      await expect(work).rejects.toThrow();
      stop();
      expect(dispatched).toBe(0);
      expect(coordinator.snapshot()?.active).toBe(0);
      expect(isRuntimeIdle(f.session)).toBe(false);
    }
  });
  test("admission starts before async preflight; preflight failure/handled prompt releases", async () => {
    const { coordinator } = fixture();
    const gate = deferred();
    const { session } = runtime(coordinator, () => gate.promise);
    const pending = session.prompt("hello");
    coordinator.request(relaxed);
    expect(coordinator.snapshot()?.pending).toBe(true);
    gate.resolve();
    await pending;
    expect(coordinator.snapshot()?.pending).toBe(false);
    session.dispose();
  });
  test("agent_end, promise return and retry events do not release a running lease", async () => {
    const { coordinator } = fixture();
    const gate = deferred();
    const { session, emit } = runtime(coordinator, () => gate.promise);
    const pending = session.prompt("hello");
    emit("agent_start");
    emit("agent_end");
    emit("auto_retry_start");
    gate.resolve();
    await pending;
    coordinator.request(relaxed);
    expect(coordinator.snapshot()?.pending).toBe(true);
    emit("auto_retry_end");
    emit("agent_start");
    emit("agent_end");
    expect(coordinator.snapshot()?.pending).toBe(true);
    emit("agent_settled");
    expect(coordinator.snapshot()?.pending).toBe(false);
    session.dispose();
  });
  test("each role holds identical security boundary, but an idle retained runtime does not", () => {
    const { coordinator } = fixture();
    const active = ["main", "mutable", "readonly", "judge", "afk"].map(() => runtime(coordinator));
    const idle = runtime(coordinator);
    for (const item of active) item.emit("agent_start");
    coordinator.request(relaxed);
    for (const item of active.slice(0, -1)) item.emit("agent_settled");
    expect(coordinator.snapshot()?.pending).toBe(true);
    active.at(-1)!.emit("agent_settled");
    expect(coordinator.snapshot()).toMatchObject({ pending: false, active: 0 });
    for (const item of [...active, idle]) item.session.dispose();
  });
  test("a user shell outliving agent settlement keeps its independent lease", async () => {
    const { coordinator } = fixture();
    const gate = deferred();
    const { session, emit } = runtime(coordinator, () => gate.promise);
    emit("agent_start");
    const shell = session.executeBash("fixture");
    coordinator.request(relaxed);
    emit("agent_settled");
    expect(coordinator.snapshot()?.pending).toBe(true);
    gate.resolve();
    await shell;
    expect(coordinator.snapshot()?.pending).toBe(false);
    session.dispose();
  });
  test("abort and disposal release even without agent_settled", async () => {
    const { coordinator } = fixture();
    const aborted = runtime(coordinator);
    const disposed = runtime(coordinator);
    aborted.emit("agent_start");
    disposed.emit("agent_start");
    coordinator.request(relaxed);
    await aborted.session.abort();
    expect(coordinator.snapshot()?.pending).toBe(true);
    disposed.session.dispose();
    expect(coordinator.snapshot()?.pending).toBe(false);
    aborted.session.dispose();
  });
  test("triggerTurn custom messages acquire before asynchronous work; nextTurn data does not", async () => {
    const { coordinator } = fixture();
    const gate = deferred();
    const { session } = runtime(coordinator, () => gate.promise);
    const queued = session.sendCustomMessage({}, { deliverAs: "nextTurn", triggerTurn: true });
    expect(coordinator.snapshot()?.active).toBe(0);
    const running = session.sendCustomMessage({}, { triggerTurn: true });
    expect(coordinator.snapshot()?.active).toBe(1);
    gate.resolve();
    await Promise.all([queued, running]);
    expect(coordinator.snapshot()?.active).toBe(0);
    session.dispose();
  });
});

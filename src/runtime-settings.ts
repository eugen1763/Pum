import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CheckModeProfile } from "./settings";
import type { SandboxMode } from "./sandbox/types";

/** Process-wide policies affect main, workers and internal runtimes together. */
export interface RuntimeSecuritySettings {
  checkMode: CheckModeProfile;
  checkModel: string;
  sandboxMode: SandboxMode;
  checkPaths: readonly string[];
  webSearch: boolean;
}
export interface RuntimeSettingsSnapshot {
  desired: RuntimeSecuritySettings;
  effective: RuntimeSecuritySettings;
  pending: boolean;
  /** Outstanding activity reservations, not the managed-agent capacity count. */
  active: number;
}
const strength: Record<SandboxMode, number> = { off: 0, auto: 1, require: 2 };
const copy = (value: RuntimeSecuritySettings): RuntimeSecuritySettings => ({ ...value, checkPaths: [...new Set(value.checkPaths)] });
const equal = (a: RuntimeSecuritySettings, b: RuntimeSecuritySettings): boolean =>
  a.checkMode === b.checkMode && a.checkModel === b.checkModel && a.sandboxMode === b.sandboxMode &&
  a.webSearch === b.webSearch && a.checkPaths.length === b.checkPaths.length && a.checkPaths.every((path) => b.checkPaths.includes(path));

/** Tighten now; commit all pending relaxations together at the last true settlement. */
export class RuntimeSettingsCoordinator {
  private desired?: RuntimeSecuritySettings;
  private effective?: RuntimeSecuritySettings;
  private apply?: (settings: RuntimeSecuritySettings) => void;
  private active = new Map<object | string, symbol>();
  private listeners = new Set<() => void>();
  private tighteningEpoch = 0;
  get securityEpoch(): number { return this.tighteningEpoch; }

  configure(initial: RuntimeSecuritySettings, apply: (settings: RuntimeSecuritySettings) => void): void {
    if (this.desired) throw new Error("Runtime settings already configured");
    this.apply = apply;
    this.desired = copy(initial);
    this.commit(copy(initial));
  }

  request(settings: RuntimeSecuritySettings, apply?: (settings: RuntimeSecuritySettings) => void): void {
    if (apply) this.apply = apply;
    if (!this.effective) {
      this.configure(settings, this.apply ?? (() => {}));
      return;
    }
    this.desired = copy(settings);
    const old = this.effective;
    const next = this.active.size === 0 ? this.desired : {
      ...this.desired,
      checkMode: old.checkMode === "on" ? "on" as const : this.desired.checkMode,
      sandboxMode: strength[old.sandboxMode] > strength[this.desired.sandboxMode] ? old.sandboxMode : this.desired.sandboxMode,
      checkPaths: old.checkPaths.filter((path) => this.desired!.checkPaths.includes(path)),
      webSearch: old.webSearch && this.desired.webSearch,
    };
    this.commit(copy(next));
  }

  /** Call synchronously before asynchronous setup/preflight, not just agent_start. */
  begin(key: object | string): () => void {
    this.flush();
    let token = this.active.get(key);
    if (!token) {
      token = Symbol();
      this.active.set(key, token);
      this.notify();
    }
    return () => {
      if (this.active.get(key) !== token) return;
      this.settle(key);
    };
  }

  settle(key: object | string): void {
    if (!this.active.delete(key)) return;
    this.flush();
    this.notify();
  }

  snapshot(): RuntimeSettingsSnapshot | undefined {
    if (!this.desired || !this.effective) return undefined;
    return { desired: copy(this.desired), effective: copy(this.effective), pending: !equal(this.desired, this.effective), active: this.active.size };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private flush(): void {
    if (this.active.size === 0 && this.desired && this.effective && !equal(this.desired, this.effective)) this.commit(copy(this.desired));
  }
  private commit(next: RuntimeSecuritySettings): void {
    // Invalidate already-awaiting policy reviews before any enforcement setter.
    const old = this.effective;
    if (old && ((old.checkMode === "off" && next.checkMode === "on") ||
      strength[next.sandboxMode] > strength[old.sandboxMode] ||
      old.checkPaths.some((path) => !next.checkPaths.includes(path)) ||
      (old.webSearch && !next.webSearch))) this.tighteningEpoch++;
    // Set every actual policy synchronously before notifying consumers/admitting work.
    if (!old || !equal(old, next)) this.apply?.(copy(next));
    this.effective = next;
    this.notify();
  }
  private notify(): void {
    // A view observer must never interrupt a security commit or run admission.
    for (const listener of this.listeners) { try { listener(); } catch { /* Best-effort view refresh. */ } }
  }
}

export const runtimeSettings = new RuntimeSettingsCoordinator();

const activity = new WeakMap<AgentSession, () => boolean>();
const admissionFreezers = new WeakMap<AgentSession, () => void>();

/** Permanently retire an exact idle runtime before awaited shutdown hooks.
 * Queue cancellation, abort and disposal remain available; no new input, shell
 * or core work may enter. This is not disposal and does not release ownership.
 */
export function freezeRuntimeAdmissions(session: AgentSession): void {
  if (!isRuntimeIdle(session)) throw new Error("Only an exact idle runtime can be retired.");
  const freeze = admissionFreezers.get(session);
  if (!freeze) throw new Error("Runtime admission tracking is unavailable.");
  freeze();
}

/** Exact-runtime consent boundary. Missing/binding/disposed runtimes are not idle.
 * SDK session flags can be reset by an older cancelled preflight; neither those
 * flags nor App busy state alone proves that the core or its admissions settled.
 */
export function isRuntimeIdle(session: AgentSession | undefined): boolean {
  if (!session) return false;
  try { return activity.get(session)?.() === true; }
  catch { return false; }
}
/** Cover direct prompts and custom-message starts, including async preflight and retries. */
export function bindRuntimeSettingsActivity(session: AgentSession, coordinator = runtimeSettings): void {
  if (activity.has(session)) return;
  // Remain unavailable until every admission/dispatch/disposal wrapper is ready.
  activity.set(session, () => false);
  // Every public admission owns a distinct lease, even when it reenters from
  // an older run's extension hook. Async scope follows the SDK's entire
  // _runAgentPrompt (including retry/queued continuations and true settlement).
  // Never settle by session key: extensions run before ordinary subscribers.
  type Admission = { epoch: number; started: boolean; released: boolean; parent?: Admission; release: () => void };
  let epoch = 0;
  let disposed = false;
  let frozen = false;
  const requireAdmission = () => {
    if (disposed || frozen) throw new Error("Runtime is disposed or retiring");
  };
  const shellReleases = new Set<() => void>();
  const scopes = new AsyncLocalStorage<Admission>();
  const admissions = new Set<Admission>();
  const reserve = (): Admission => {
    let release = () => {};
    const admission: Admission = { epoch, started: false, released: false, release: () => {
      if (admission.released) return;
      admission.released = true;
      admissions.delete(admission);
      release();
    } };
    admissions.add(admission);
    release = coordinator.begin({});
    if (admission.released) release(); // A synchronous observer may dispose during begin.
    return admission;
  };
  // A session already running at bind time has no admission scope. Keep this
  // compatibility lease separate; unscoped events cannot release scoped work.
  let unscoped: Admission | undefined = session.isStreaming || session.agent?.state?.isStreaming ? reserve() : undefined;
  if (unscoped) unscoped.started = true;
  const unsubscribe = session.subscribe((event) => {
    const admission = scopes.getStore();
    // A cancelled preflight may unwind after a newer accepted prompt starts.
    // Its SDK finally still emits settled; that event does not own the new run.
    if (disposed) return;
    if (event.type === "agent_start") {
      if (admission) {
        if (admission.epoch === epoch && !admission.released) {
          admission.started = true;
          if (admission.parent && !admission.parent.released) admission.parent.started = true;
        }
      } else {
        unscoped ??= reserve();
        unscoped.started = true;
      }
    } else if (event.type === "agent_settled") {
      if (admission) admission.release();
      else {
        const settled = unscoped;
        unscoped = undefined;
        settled?.release();
      }
    }
  });
  const admit = async <T>(run: () => Promise<T>): Promise<T> => {
    requireAdmission();
    const admission = reserve();
    try {
      if (disposed || frozen || admission.released || admission.epoch !== epoch) throw new Error("Runtime admission was cancelled");
      return await scopes.run(admission, run);
    }
    finally {
      // Handled/failed preflight has no lifecycle event. A started session run
      // remains owned until true settlement, never agent_end or a queued return.
      if (!admission.started) admission.release();
    }
  };
  // Last synchronous dispatch boundary after async SDK preflight. Continuations
  // retain their public admission; do not release it between retry attempts.
  const dispatch = async <T>(run: () => Promise<T>): Promise<T> => {
    const admission = scopes.getStore();
    if (disposed || frozen || (admission && admission.epoch !== epoch)) {
      throw new Error("Runtime admission was cancelled");
    }
    // A dispatch has its own identity too: a direct agent.prompt/continue can
    // reenter from an older extension callback without a public admission.
    // The public owner spans retries; this owner spans only this core promise.
    const direct = reserve();
    // Core execution may begin before awaited agent_start hooks reach us.
    // Its promise, not the session's shared idle flag, proves completion.
    direct.started = true;
    if (admission && !admission.released) direct.parent = admission;
    try {
      if (disposed || frozen || direct.released || direct.epoch !== epoch) throw new Error("Runtime admission was cancelled");
      return await scopes.run(direct, run);
    }
    finally { direct.release(); }
  };
  if (session.agent?.prompt) {
    const agentPrompt = session.agent.prompt.bind(session.agent);
    session.agent.prompt = ((...args: Parameters<typeof agentPrompt>) => {
      return dispatch(() => agentPrompt(...args));
    }) as typeof session.agent.prompt;
  }
  if (session.agent?.continue) {
    const agentContinue = session.agent.continue.bind(session.agent);
    session.agent.continue = (...args) => {
      return dispatch(() => agentContinue(...args));
    };
  }
  const prompt = session.prompt.bind(session);
  session.prompt = (...args) => admit(() => prompt(...args));
  const custom = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = async (...args) => {
    requireAdmission();
    return args[1]?.triggerTurn && args[1]?.deliverAs !== "nextTurn"
      ? admit(() => custom(...args)) : custom(...args);
  };
  // These queue-only paths do not reserve a run, but accepting them after the
  // retirement fence would silently strand user/custom input in the old runtime.
  const guardQueueInput = <Args extends unknown[], Result>(send: (...args: Args) => Promise<Result>) => async (...args: Args): Promise<Result> => {
    requireAdmission();
    return send(...args);
  };
  if (session.steer) session.steer = guardQueueInput(session.steer.bind(session));
  if (session.followUp) session.followUp = guardQueueInput(session.followUp.bind(session));
  if (session.sendUserMessage) session.sendUserMessage = guardQueueInput(session.sendUserMessage.bind(session));
  // Summary/tree methods bypass the ordinary core prompt route. In particular,
  // shutdown ctx.compact() must not create an implicit summary after retirement.
  if (session.compact) session.compact = guardQueueInput(session.compact.bind(session));
  if (session.navigateTree) session.navigateTree = guardQueueInput(session.navigateTree.bind(session));
  // Retained public SessionManager objects must not switch files or select a
  // different tree during shutdown. Normal runtime semantics remain unchanged.
  // The branch transaction reopens a new manager under the same lock for its
  // own append after cleanup; it never thaws the retired manager.
  for (const name of ["newSession", "setSessionFile", "branch", "resetLeaf", "branchWithSummary", "createBranchedSession"] as const) {
    const manager = session.sessionManager;
    const original = manager?.[name]?.bind(manager);
    if (original) (manager as any)[name] = (...args: unknown[]) => {
      requireAdmission();
      return (original as (...args: unknown[]) => unknown)(...args);
    };
  }
  for (const name of ["steer", "followUp"] as const) {
    const original = session.agent?.[name]?.bind(session.agent);
    if (original) session.agent[name] = (...args) => {
      requireAdmission();
      original(...args);
    };
  }
  if (session.executeBash) {
    const executeBash = session.executeBash.bind(session);
    session.executeBash = async (...args) => {
      requireAdmission();
      // User shell execution can outlive agent_settled and has its own policy use.
      let release = () => {};
      let released = false;
      const owner = () => { released = true; release(); };
      shellReleases.add(owner);
      release = coordinator.begin({});
      if (released) release();
      try {
        requireAdmission();
        return await executeBash(...args);
      }
      finally { shellReleases.delete(owner); owner(); }
    };
  }
  const abort = session.abort.bind(session);
  session.abort = async () => {
    const cancelled = [...admissions];
    const cancelledUnscoped = unscoped;
    epoch++;
    // Retain executing work if the underlying abort rejects. Cancelled
    // preflights can no longer dispatch, even when their hook unwinds later.
    try {
      await abort();
      // SDK waitForIdle can return early after a stale preflight finally resets
      // isStreaming. Scoped execution still needs its own settled/promise proof.
      cancelledUnscoped?.release();
      if (unscoped?.released) unscoped = undefined;
    } finally {
      for (const admission of cancelled) if (!admission.started) admission.release();
    }
  };
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    disposed = true;
    epoch++;
    try { dispose(); }
    finally {
      unsubscribe();
      unscoped = undefined;
      for (const admission of admissions) admission.release();
      admissions.clear();
      for (const release of shellReleases) release();
      shellReleases.clear();
    }
  };
  admissionFreezers.set(session, () => {
    // isRuntimeIdle was checked without awaiting; setting the fence runs no
    // callbacks and cannot release or manufacture an activity owner.
    frozen = true;
    epoch++;
  });
  activity.set(session, () => !disposed && !frozen && admissions.size === 0 && shellReleases.size === 0
    && session.isStreaming === false && session.agent?.state?.isStreaming === false);
}

/** Bounded UI text; desired values remain in the ordinary Settings controls. */
export function runtimeSettingsPendingNotice(snapshot: RuntimeSettingsSnapshot | undefined): string | undefined {
  if (!snapshot?.pending) return undefined;
  const { desired, effective } = snapshot;
  const differences: string[] = [];
  if (desired.checkMode !== effective.checkMode) differences.push(`Check ${desired.checkMode} (effective ${effective.checkMode})`);
  if (desired.sandboxMode !== effective.sandboxMode) differences.push(`Sandbox ${desired.sandboxMode} (effective ${effective.sandboxMode})`);
  if (desired.webSearch !== effective.webSearch) differences.push(`Search ${desired.webSearch ? "on" : "off"} (effective ${effective.webSearch ? "on" : "off"})`);
  if (desired.checkPaths.some((path) => !effective.checkPaths.includes(path))) differences.push("added Check roots (not yet effective)");
  return `Pending until all affected agents settle: ${differences.join("; ")}. Desired settings are saved immediately.`;
}

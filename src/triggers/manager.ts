import { randomUUID } from "node:crypto";
import {
  DEFAULT_TRIGGER_MESSAGE_TEMPLATE,
  renderTriggerTemplate,
  triggerTemplateValues,
  validateTriggerTemplate,
} from "./template";
import { sanitizeTriggerEnvironment, sanitizeTriggerEnvironmentAdditions } from "./process";
import {
  DEFAULT_DELIVERED_LIMIT,
  DEFAULT_OUTPUT_LIMIT_BYTES,
  DEFAULT_PENDING_LIMIT,
  DEFAULT_RUNNING_LIMIT,
  DEFAULT_TRIGGER_LIFETIME_MS,
  DEFAULT_TRIGGER_LIMIT,
  MAX_TRIGGER_FIRES,
  MAX_TRIGGER_LIFETIME_MS,
  EXTERNAL_TRIGGER_CUSTOM_TYPE,
  MIN_TRIGGER_REPEAT_MS,
  type CreateTriggerInput,
  type ExternalTriggerCustomEvent,
  type ExternalTriggerEventData,
  type PublicTriggerManager,
  type TriggerLastResult,
  type TriggerManagerEvent,
  type TriggerManagerOptions,
  type TriggerOutputMetadata,
  type TriggerOutputWriter,
  type TriggerProcessHandle,
  type TriggerRequester,
  type TriggerSafetyOperation,
  type TriggerSnapshot,
  type TriggerTarget,
} from "./types";

type DeliveryRecord = {
  token: string;
  triggerId: string;
  target: TriggerTarget;
  event: ExternalTriggerEventData;
  message: string;
  writer?: TriggerOutputWriter;
  deliveryId?: string;
  turnId?: string;
  delivering?: boolean;
};

type TriggerRecord = {
  snapshot: TriggerSnapshot;
  env: Readonly<Record<string, string>>;
  /** Model-supplied additions alone. The safety identity binds these values. */
  envAdditions: Readonly<Record<string, string>>;
  requester: TriggerRequester;
  messageTemplate: string;
  timer?: unknown;
  expiryTimer?: unknown;
  handle?: TriggerProcessHandle;
  writer?: TriggerOutputWriter;
  generation: number;
  rerunRequested: boolean;
};

const encoder = new TextEncoder();
const STDOUT_MARKER = encoder.encode("\n--- stdout ---\n");
const STDERR_MARKER = encoder.encode("\n--- stderr ---\n");

/** Grace period between the SIGTERM and the SIGKILL escalation for a supervised process. */
const TERMINATION_GRACE_MS = 2_000;
/** Extra wait after the SIGKILL escalation before shutdown gives up on a child. */
const TERMINATION_KILL_WAIT_MS = 500;
/** Total bound on the shutdown wait, so one wedged child cannot hang the exit. */
const SHUTDOWN_TERMINATION_MS = 5_000;
/** Node clamps a longer setTimeout delay to 1ms, so long waits re-arm in chunks. */
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

function exactTarget(a: TriggerTarget, b: TriggerTarget): boolean {
  return a.sessionId === b.sessionId && a.agentId === b.agentId;
}

function requesterTarget(requester: TriggerRequester): TriggerTarget {
  return {
    sessionId: requester.sessionId,
    agentId: requester.kind === "subagent" ? requester.agentId : null,
    label: requester.kind === "subagent" ? requester.agentId : "main",
  };
}

function canAccess(requester: TriggerRequester | undefined, target: TriggerTarget): boolean {
  return requester === undefined || exactTarget(requesterTarget(requester), target);
}

function cloneSnapshot(snapshot: TriggerSnapshot): TriggerSnapshot {
  return {
    ...snapshot,
    target: { ...snapshot.target },
    args: [...snapshot.args],
    output: snapshot.output ? { ...snapshot.output } : undefined,
    lastResult: snapshot.lastResult
      ? { ...snapshot.lastResult, output: snapshot.lastResult.output ? { ...snapshot.lastResult.output } : undefined }
      : undefined,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export class TriggerManager implements PublicTriggerManager {
  private readonly records = new Map<string, TriggerRecord>();
  private readonly listeners = new Set<(event: TriggerManagerEvent) => void>();
  private readonly pending = new Map<string, DeliveryRecord>();
  private readonly delivered: DeliveryRecord[] = [];
  private readonly creatingIds = new Set<string>();
  /** Pending child terminations. Shutdown waits for these under a bounded deadline. */
  private readonly terminations = new Set<Promise<void>>();
  private readonly options: TriggerManagerOptions;
  private readonly triggerLimit: number;
  private readonly runningLimit: number;
  private readonly pendingLimit: number;
  private readonly deliveredLimit: number;
  private readonly outputLimitBytes: number;
  private readonly createId: () => string;
  private runningCount = 0;
  private shutdownRequested = false;

  constructor(options: TriggerManagerOptions) {
    this.options = options;
    this.triggerLimit = positiveInteger(options.triggerLimit ?? DEFAULT_TRIGGER_LIMIT, "triggerLimit");
    this.runningLimit = positiveInteger(options.runningLimit ?? DEFAULT_RUNNING_LIMIT, "runningLimit");
    this.pendingLimit = positiveInteger(options.pendingLimit ?? DEFAULT_PENDING_LIMIT, "pendingLimit");
    this.deliveredLimit = positiveInteger(options.deliveredLimit ?? DEFAULT_DELIVERED_LIMIT, "deliveredLimit");
    this.outputLimitBytes = positiveInteger(options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "outputLimitBytes");
    this.createId = options.createId ?? randomUUID;
  }

  subscribe(listener: (event: TriggerManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTriggers(requester?: TriggerRequester): TriggerSnapshot[] {
    this.refreshExpiries();
    return [...this.records.values()]
      .filter((record) => canAccess(requester, record.snapshot.target))
      .map((record) => cloneSnapshot(record.snapshot))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  inspect(id: string, requester?: TriggerRequester): TriggerSnapshot {
    const record = this.authorizedRecord(id, requester);
    this.refreshExpiry(record);
    return cloneSnapshot(record.snapshot);
  }

  async create(input: CreateTriggerInput, requester: TriggerRequester): Promise<TriggerSnapshot> {
    this.assertOpen();
    this.validateInput(input);
    const messageTemplate = input.template ?? input.messageTemplate ?? DEFAULT_TRIGGER_MESSAGE_TEMPLATE;
    validateTriggerTemplate(messageTemplate);
    if (requester.kind === "subagent" && !canAccess(requester, input.target)) {
      throw new Error("Requester cannot access the exact trigger target");
    }
    if (this.records.size + this.creatingIds.size >= this.triggerLimit) this.pruneTerminalRecords();
    if (this.records.size + this.creatingIds.size >= this.triggerLimit) throw new Error(`Trigger limit reached (${this.triggerLimit})`);
    const id = input.id?.trim() || this.createId();
    if (this.records.has(id) || this.creatingIds.has(id)) throw new Error(`Trigger already exists: ${id}`);
    const mode = input.mode ?? "once";
    const restartDelayMs = mode === "repeat" ? (input.restartDelayMs ?? MIN_TRIGGER_REPEAT_MS) : null;
    if (mode === "repeat" && restartDelayMs! < MIN_TRIGGER_REPEAT_MS) {
      throw new Error(`Repeat delay must be at least ${MIN_TRIGGER_REPEAT_MS}ms`);
    }
    const createdAt = this.options.clock.now();
    const lifetimeMs = input.lifetimeMs ?? DEFAULT_TRIGGER_LIFETIME_MS;
    const expiresAt = input.expiresAt ?? createdAt + lifetimeMs;
    if (expiresAt - createdAt > MAX_TRIGGER_LIFETIME_MS) {
      throw new Error(`Trigger lifetime cannot exceed ${MAX_TRIGGER_LIFETIME_MS}ms`);
    }
    const envAdditions = sanitizeTriggerEnvironmentAdditions(input.env);
    const env = sanitizeTriggerEnvironment(this.options.environment ?? process.env, envAdditions);
    this.creatingIds.add(id);
    try {
      await this.checkSafety(id, input, requester, env, envAdditions, "create");
      this.assertOpen();
    } catch (error) {
      this.creatingIds.delete(id);
      throw error;
    }
    const now = this.options.clock.now();
    const paused = input.startBehavior === "paused";
    const snapshot: TriggerSnapshot = {
      id,
      name: input.name.trim(),
      state: expiresAt <= now ? "expired" : paused ? "paused" : "idle",
      target: { ...input.target },
      executable: input.executable,
      args: [...(input.args ?? [])],
      cwd: input.cwd,
      mode,
      restartDelayMs,
      createdAt,
      expiresAt,
      nextRestartAt: null,
      fireCount: 0,
      maxFires: Math.min(input.maxFires ?? MAX_TRIGGER_FIRES, MAX_TRIGGER_FIRES),
      pendingCount: 0,
      coalescedCount: 0,
      paused,
    };
    const record: TriggerRecord = {
      snapshot,
      env,
      envAdditions,
      requester: { ...requester },
      messageTemplate,
      generation: 0,
      rerunRequested: false,
    };
    this.creatingIds.delete(id);
    this.records.set(id, record);
    this.emitExternal(record, "created");
    if (snapshot.state !== "expired") {
      this.armExpiry(record);
      if (!snapshot.paused) this.schedule(record, now, "start");
    } else {
      this.emitExternal(record, "expired", "Trigger expired before creation completed");
    }
    return cloneSnapshot(snapshot);
  }

  async pause(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot> {
    const record = this.authorizedRecord(id, requester);
    this.refreshExpiry(record);
    if (["cancelled", "expired", "unavailable"].includes(record.snapshot.state)) return cloneSnapshot(record.snapshot);
    record.snapshot.paused = true;
    if (record.timer !== undefined) this.options.clock.clearTimeout(record.timer);
    record.timer = undefined;
    record.snapshot.nextRestartAt = null;
    if (record.snapshot.state !== "running" && record.snapshot.state !== "waiting") record.snapshot.state = "paused";
    this.emitExternal(record, "paused");
    return cloneSnapshot(record.snapshot);
  }

  async resume(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot> {
    const record = this.authorizedRecord(id, requester);
    this.refreshExpiry(record);
    if (!record.snapshot.paused) return cloneSnapshot(record.snapshot);
    if (["cancelled", "expired", "unavailable"].includes(record.snapshot.state)) return cloneSnapshot(record.snapshot);
    record.snapshot.paused = false;
    if (record.snapshot.state !== "running" && record.snapshot.state !== "waiting") record.snapshot.state = "idle";
    this.emitExternal(record, "resumed");
    if (record.snapshot.state === "waiting") {
      const held = [...this.pending.values()].filter((delivery) => delivery.triggerId === id);
      await Promise.all(held.map((delivery) => this.deliverPending(record, delivery)));
    } else if (record.snapshot.state === "idle") {
      await this.start(record, false, false, "resume");
    }
    return cloneSnapshot(record.snapshot);
  }

  async cancel(id: string, requester?: TriggerRequester): Promise<void> {
    const record = this.authorizedRecord(id, requester);
    await this.cancelRecord(record, "cancelled", "Trigger cancelled");
  }

  async invoke(id: string, requester?: TriggerRequester): Promise<TriggerSnapshot | void> {
    const record = this.authorizedRecord(id, requester);
    this.refreshExpiry(record);
    if (["cancelled", "expired", "unavailable"].includes(record.snapshot.state)) {
      throw new Error(`Trigger is ${record.snapshot.state}`);
    }
    await this.start(record, true, true, "invoke-run");
    return cloneSnapshot(record.snapshot);
  }

  list(requester?: TriggerRequester): TriggerSnapshot[] { return this.getTriggers(requester) }
  get(id: string, requester?: TriggerRequester): TriggerSnapshot { return this.inspect(id, requester) }

  async invalidateSession(sessionId: string): Promise<void> {
    const records = [...this.records.values()].filter((record) => record.snapshot.target.sessionId === sessionId);
    await Promise.all(records.map((record) => this.invalidate(record, "Target session is unavailable")));
  }

  async invalidateAgent(sessionId: string, agentId: string): Promise<void> {
    const records = [...this.records.values()].filter((record) =>
      record.snapshot.target.sessionId === sessionId && record.snapshot.target.agentId === agentId,
    );
    await Promise.all(records.map((record) => this.invalidate(record, "Target agent is unavailable")));
  }

  async invalidateTarget(target: TriggerTarget): Promise<void> {
    if (target.agentId === null) {
      const records = [...this.records.values()].filter((record) => exactTarget(record.snapshot.target, target));
      await Promise.all(records.map((record) => this.invalidate(record, "Target is unavailable")));
    } else await this.invalidateAgent(target.sessionId, target.agentId);
  }

  async markTargetSettled(sessionId: string, agentId: string | null): Promise<void> {
    const matches = this.delivered.filter((delivery) =>
      delivery.target.sessionId === sessionId && delivery.target.agentId === agentId,
    );
    for (const delivery of matches) await this.settleDeliveryRecord(delivery);
  }

  settleTargetTurn(target: TriggerTarget): Promise<void> {
    return this.markTargetSettled(target.sessionId, target.agentId);
  }

  async settleDelivery(deliveryId: string): Promise<void> {
    const delivery = this.delivered.find((item) => item.deliveryId === deliveryId);
    if (delivery) await this.settleDeliveryRecord(delivery);
  }

  async remove(id: string, requester?: TriggerRequester): Promise<void> {
    const record = this.authorizedRecord(id, requester);
    await this.cancelRecord(record, "cancelled", "Trigger removed");
    this.records.delete(id);
    this.emit({ type: "removed", id });
  }

  /**
   * Drop terminal (cancelled, expired, or unavailable) definitions so their
   * slots no longer count against the trigger limit. A terminal definition
   * keeps no live process, so freeing it cannot orphan a running child. Any
   * lingering output files for the definition are cleaned before removal.
   */
  private pruneTerminalRecords(): void {
    for (const [id, record] of [...this.records]) {
      if (!this.isTerminal(record)) continue;
      this.dropTerminalRecord(id, record);
    }
  }

  private dropTerminalRecord(id: string, record: TriggerRecord): void {
    for (const delivery of this.delivered.filter((item) => item.triggerId === id)) {
      const index = this.delivered.indexOf(delivery);
      if (index >= 0) this.delivered.splice(index, 1);
      void this.cleanupDelivery(delivery);
    }
    for (const delivery of [...this.pending.values()].filter((item) => item.triggerId === id)) {
      this.pending.delete(delivery.token);
      void this.cleanupDelivery(delivery);
    }
    if (record.writer) {
      void record.writer.remove().catch(() => {});
      record.writer = undefined;
    }
    this.records.delete(id);
    this.emit({ type: "removed", id });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    await Promise.all([...this.records.values()].map((record) => this.cancelRecord(record, "cancelled", "Shutdown")));
    await this.awaitTerminations();
    for (const delivery of [...this.delivered]) await this.cleanupDelivery(delivery);
    for (const delivery of [...this.pending.values()]) await this.cleanupDelivery(delivery);
    this.pending.clear();
    this.delivered.length = 0;
    this.listeners.clear();
  }

  private validateInput(input: CreateTriggerInput): void {
    if (!input.name?.trim()) throw new Error("Trigger name is required");
    if (!input.executable?.trim() || input.executable.includes("\0")) throw new Error("Trigger executable is invalid");
    for (const arg of input.args ?? []) if (arg.includes("\0")) throw new Error("Trigger argument contains NUL");
    if (!input.target?.sessionId || !input.target.label) throw new Error("Trigger target is invalid");
    if (input.target.agentId === "") throw new Error("Trigger target agentId is invalid");
    if (!input.cwd?.trim() || input.cwd.includes("\0")) throw new Error("Trigger cwd is invalid");
    if (input.lifetimeMs !== undefined
      && (!Number.isFinite(input.lifetimeMs) || input.lifetimeMs < 1 || input.lifetimeMs > MAX_TRIGGER_LIFETIME_MS)) {
      throw new Error(`lifetimeMs must be between 1 and ${MAX_TRIGGER_LIFETIME_MS}`);
    }
    if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) throw new Error("expiresAt must be finite");
    if (input.maxFires !== undefined) positiveInteger(input.maxFires, "maxFires");
  }

  private authorizedRecord(id: string, requester?: TriggerRequester): TriggerRecord {
    const record = this.records.get(id);
    if (!record || !canAccess(requester, record.snapshot.target)) throw new Error(`Trigger not found: ${id}`);
    return record;
  }

  private assertOpen(): void {
    if (this.shutdownRequested) throw new Error("Trigger manager is shut down");
  }

  private async checkSafety(
    id: string,
    input: Pick<CreateTriggerInput, "name" | "target" | "executable" | "args" | "cwd">,
    requester: TriggerRequester,
    env: Readonly<Record<string, string>>,
    envAdditions: Readonly<Record<string, string>>,
    operation: TriggerSafetyOperation,
  ): Promise<void> {
    const result = await this.options.safety.check({
      proposal: {
        kind: "process",
        source: "external-trigger",
        executable: input.executable,
        args: [...(input.args ?? [])],
        cwd: input.cwd,
        operation,
        env: { ...envAdditions },
        triggerName: input.name,
      },
      triggerId: id,
      env,
      target: { ...input.target },
      requester: { ...requester },
    });
    if (!result.safe) throw new Error(result.reason || "Trigger process failed the safety check");
  }

  private schedule(record: TriggerRecord, at: number, operation: TriggerSafetyOperation): void {
    if (record.snapshot.paused || this.isTerminal(record)) return;
    if (record.timer !== undefined) this.options.clock.clearTimeout(record.timer);
    record.snapshot.nextRestartAt = at;
    const delay = Math.max(0, at - this.options.clock.now());
    this.armLongTimeout(delay, (handle) => { record.timer = handle; }, () => {
      void this.start(record, false, false, operation).catch((error) => this.fail(record, error));
    });
    this.emitChanged(record);
  }

  private armExpiry(record: TriggerRecord): void {
    if (record.snapshot.expiresAt === undefined) return;
    const delay = Math.max(0, record.snapshot.expiresAt - this.options.clock.now());
    this.armLongTimeout(delay, (handle) => { record.expiryTimer = handle; }, () => {
      this.refreshExpiry(record);
    });
  }

  private refreshExpiries(): void {
    for (const record of this.records.values()) this.refreshExpiry(record);
  }

  private refreshExpiry(record: TriggerRecord): void {
    if (this.options.clock.now() < record.snapshot.expiresAt || this.isTerminal(record)) return;
    record.snapshot.state = "expired";
    record.snapshot.paused = false;
    record.snapshot.nextRestartAt = null;
    record.generation += 1;
    if (record.timer !== undefined) this.options.clock.clearTimeout(record.timer);
    record.timer = undefined;
    if (record.handle) {
      this.beginTermination(record.handle);
      record.handle = undefined;
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
    if (record.writer) {
      void record.writer.remove().catch(() => {});
      record.writer = undefined;
    }
    for (const delivery of [...this.delivered].filter((item) => item.triggerId === record.snapshot.id)) {
      this.delivered.splice(this.delivered.indexOf(delivery), 1);
      void this.cleanupDelivery(delivery);
    }
    for (const delivery of [...this.pending.values()].filter((item) => item.triggerId === record.snapshot.id)) {
      this.pending.delete(delivery.token);
      void this.cleanupDelivery(delivery);
    }
    record.snapshot.pendingCount = 0;
    this.emitExternal(record, "expired", "Trigger expiry reached");
    this.drainCoalesced();
  }

  private async start(
    record: TriggerRecord,
    manual: boolean,
    forceWhilePaused: boolean,
    operation: TriggerSafetyOperation,
  ): Promise<void> {
    this.assertOpen();
    this.refreshExpiry(record);
    if (this.isTerminal(record) || (record.snapshot.paused && !forceWhilePaused)) return;
    if (record.snapshot.fireCount >= record.snapshot.maxFires) {
      this.expire(record, "Maximum run count reached");
      return;
    }
    if (record.snapshot.state === "running" || record.snapshot.state === "waiting" || this.runningCount >= this.runningLimit) {
      record.rerunRequested = true;
      record.snapshot.coalescedCount += 1;
      this.emitExternal(record, "coalesced", "A run was coalesced");
      return;
    }
    const generation = ++record.generation;
    record.snapshot.state = "running";
    record.snapshot.nextRestartAt = null;
    this.runningCount += 1;
    this.emitChanged(record);
    try {
      await this.checkSafety(record.snapshot.id, {
        name: record.snapshot.name,
        target: record.snapshot.target,
        executable: record.snapshot.executable,
        args: record.snapshot.args,
        cwd: record.snapshot.cwd,
      }, record.requester, record.env, record.envAdditions, operation);
    } catch (error) {
      if (record.generation === generation) record.snapshot.state = record.snapshot.paused ? "paused" : "idle";
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drainCoalesced();
      throw error;
    }
    if (this.shutdownRequested || this.isTerminal(record) || record.generation !== generation) {
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drainCoalesced();
      return;
    }
    const startedAt = this.options.clock.now();
    let writer: TriggerOutputWriter;
    try {
      writer = await this.options.files.createPrivateOutput(record.snapshot.id);
    } catch (error) {
      record.snapshot.state = record.snapshot.paused ? "paused" : "idle";
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drainCoalesced();
      throw error;
    }
    if (this.shutdownRequested || this.isTerminal(record) || record.generation !== generation) {
      await writer.remove().catch(() => {});
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drainCoalesced();
      return;
    }
    record.writer = writer;
    this.emitExternal(record, "started");

    let stream: "stdout" | "stderr" | undefined;
    let bytes = 0;
    let truncated = false;
    let writeError: unknown;
    let writes = Promise.resolve();
    const append = (kind: "stdout" | "stderr", chunk: Uint8Array): void => {
      const marker = stream === kind ? undefined : (kind === "stdout" ? STDOUT_MARKER : STDERR_MARKER);
      stream = kind;
      for (const part of marker ? [marker, chunk] : [chunk]) {
        const remaining = this.outputLimitBytes - bytes;
        if (remaining <= 0) { truncated = true; continue; }
        const accepted = part.byteLength <= remaining ? part : part.subarray(0, remaining);
        if (accepted.byteLength < part.byteLength) truncated = true;
        bytes += accepted.byteLength;
        const copy = accepted.slice();
        writes = writes.then(() => writer.write(copy)).catch((error) => { writeError = error; });
      }
    };

    try {
      const handle = this.options.process.spawn({
        executable: record.snapshot.executable,
        args: record.snapshot.args,
        cwd: record.snapshot.cwd,
        env: record.env,
        onStdout: (chunk) => append("stdout", chunk),
        onStderr: (chunk) => append("stderr", chunk),
      });
      record.handle = handle;
      const exit = await handle.completed;
      await writes;
      if (writeError) throw writeError;
      await writer.close();
      if (record.generation !== generation) return;
      const finishedAt = this.options.clock.now();
      const output: TriggerOutputMetadata = { path: writer.path, bytes, truncated, exists: true };
      const result: TriggerLastResult = {
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        exitCode: exit.exitCode,
        signal: exit.signal,
        manual,
        output,
      };
      record.snapshot.lastResult = result;
      record.snapshot.output = output;
      record.snapshot.fireCount += 1;
      record.writer = undefined;
      await this.queueDelivery(record, result, writer);
    } catch (error) {
      await writer.remove().catch(() => {});
      record.writer = undefined;
      if (record.generation === generation && !this.isTerminal(record)) this.fail(record, error);
    } finally {
      if (record.generation === generation) {
        record.handle = undefined;
        this.runningCount = Math.max(0, this.runningCount - 1);
        this.afterRun(record);
        this.drainCoalesced();
      }
    }
  }

  private async queueDelivery(record: TriggerRecord, result: TriggerLastResult, writer?: TriggerOutputWriter): Promise<void> {
    if (this.pending.size >= this.pendingLimit) {
      record.snapshot.coalescedCount += 1;
      await writer?.remove().catch(() => {});
      if (result.output) result.output.exists = false;
      this.emitExternal(record, "coalesced", `Global pending delivery limit reached (${this.pendingLimit})`);
      return;
    }
    const token = `${record.snapshot.id}:${record.snapshot.fireCount}:${this.createId()}`;
    const event = this.eventData(record, "waiting", undefined, result);
    const message = renderTriggerTemplate(
      record.messageTemplate,
      triggerTemplateValues(record.snapshot, event),
    );
    event.renderedMessage = message;
    const pending: DeliveryRecord = {
      token,
      triggerId: record.snapshot.id,
      target: { ...record.snapshot.target },
      event,
      message,
      writer,
    };
    this.pending.set(token, pending);
    record.snapshot.pendingCount += 1;
    record.snapshot.state = "waiting";
    this.emitExternalData(record, event);
    if (!record.snapshot.paused) await this.deliverPending(record, pending);
  }

  private async deliverPending(record: TriggerRecord, pending: DeliveryRecord): Promise<void> {
    if (pending.delivering || this.pending.get(pending.token) !== pending
      || record.snapshot.paused || this.isTerminal(record)) return;
    pending.delivering = true;
    try {
      const target = await this.options.targets.resolve(record.snapshot.target);
      if (this.pending.get(pending.token) !== pending || this.isTerminal(record)) return;
      if (record.snapshot.paused) return;
      if (!target || !exactTarget(target.target, record.snapshot.target)) {
        this.pending.delete(pending.token);
        record.snapshot.pendingCount = Math.max(0, record.snapshot.pendingCount - 1);
        await this.cleanupDelivery(pending);
        record.snapshot.state = "unavailable";
        this.emitExternal(record, "target-invalidated", "Exact target is unavailable");
        return;
      }
      const delivery = await this.options.delivery.deliver({
        event: pending.event,
        target,
        message: pending.message,
        outputPath: pending.event.output?.path,
      });
      if (this.pending.get(pending.token) !== pending || this.isTerminal(record)) {
        await this.cleanupDelivery(pending);
        return;
      }
      this.pending.delete(pending.token);
      pending.deliveryId = delivery.deliveryId;
      pending.turnId = delivery.turnId;
      this.delivered.push(pending);
      this.emitExternalData(record, {
        ...this.eventData(record, "delivered", undefined, pending.event.result),
        renderedMessage: pending.message,
        deliveryId: delivery.deliveryId,
        turnId: delivery.turnId,
      });
      while (this.delivered.length > this.deliveredLimit) {
        const oldest = this.delivered[0];
        if (oldest) await this.settleDeliveryRecord(oldest);
      }
    } catch (error) {
      if (this.pending.get(pending.token) !== pending || record.snapshot.paused) return;
      this.pending.delete(pending.token);
      record.snapshot.pendingCount = Math.max(0, record.snapshot.pendingCount - 1);
      await this.cleanupDelivery(pending);
      this.fail(record, error);
    } finally {
      pending.delivering = false;
    }
  }

  private afterRun(record: TriggerRecord): void {
    if (record.snapshot.state !== "waiting") this.refreshExpiry(record);
    if (this.isTerminal(record) || record.snapshot.state === "waiting") return;
    if (record.snapshot.fireCount >= record.snapshot.maxFires) {
      this.expire(record, "Maximum run count reached");
      return;
    }
    if (record.snapshot.mode === "repeat" && !record.snapshot.paused) {
      const at = this.options.clock.now() + (record.snapshot.restartDelayMs ?? MIN_TRIGGER_REPEAT_MS);
      this.schedule(record, at, "repeat");
    } else if (record.snapshot.paused) {
      record.snapshot.state = "paused";
      this.emitChanged(record);
    } else {
      record.snapshot.state = "idle";
      this.emitChanged(record);
    }
  }

  private drainCoalesced(): void {
    if (this.runningCount >= this.runningLimit) return;
    for (const record of this.records.values()) {
      if (!record.rerunRequested || record.snapshot.state !== "idle" || record.snapshot.paused || this.isTerminal(record)) continue;
      record.rerunRequested = false;
      void this.start(record, false, false, "repeat").catch((error) => this.fail(record, error));
      if (this.runningCount >= this.runningLimit) break;
    }
  }

  private async settleDeliveryRecord(delivery: DeliveryRecord): Promise<void> {
    const index = this.delivered.indexOf(delivery);
    // Idempotent: a delivery already removed from the settled list must not
    // mutate the trigger again. A second settle of the same delivery would
    // otherwise double-decrement pendingCount, re-emit `settled`, and reset a
    // now-running trigger back to idle.
    if (index < 0) return;
    this.delivered.splice(index, 1);
    await this.cleanupDelivery(delivery);
    const record = this.records.get(delivery.triggerId);
    if (!record) return;
    record.snapshot.pendingCount = Math.max(0, record.snapshot.pendingCount - 1);
    const output = record.snapshot.output;
    const resultOutput = record.snapshot.lastResult?.output;
    if (output && output.path === delivery.writer?.path) output.exists = false;
    if (resultOutput && resultOutput.path === delivery.writer?.path) resultOutput.exists = false;
    this.emitExternal(record, "settled");
    if (this.isTerminal(record)) return;
    if (record.rerunRequested && !record.snapshot.paused) {
      record.rerunRequested = false;
      record.snapshot.state = "idle";
      // A denied safety check or a failed output file makes `start` throw. That
      // failure must stay local to this delivery: it must not abort the settle
      // loop and leave the other deliveries stuck in "waiting" with leaked
      // output files. Record the failure and let the caller settle the rest.
      try {
        await this.start(record, false, false, "repeat");
      } catch (error) {
        if (!this.isTerminal(record)) this.fail(record, error);
      }
    } else {
      record.snapshot.state = record.snapshot.paused ? "paused" : "idle";
      this.afterRun(record);
    }
  }

  private async cleanupDelivery(delivery: DeliveryRecord): Promise<void> {
    await delivery.writer?.remove().catch(() => {});
  }

  private async invalidate(record: TriggerRecord, reason: string): Promise<void> {
    await this.cancelRuntime(record);
    record.snapshot.state = "unavailable";
    record.snapshot.paused = false;
    record.snapshot.nextRestartAt = null;
    for (const delivery of [...this.delivered].filter((item) => item.triggerId === record.snapshot.id)) {
      await this.settleDeliveryRecord(delivery);
    }
    for (const delivery of [...this.pending.values()].filter((item) => item.triggerId === record.snapshot.id)) {
      this.pending.delete(delivery.token);
      await this.cleanupDelivery(delivery);
    }
    record.snapshot.pendingCount = 0;
    this.emitExternal(record, "target-invalidated", reason);
  }

  private async cancelRecord(record: TriggerRecord, state: "cancelled", reason: string): Promise<void> {
    if (record.snapshot.state === "cancelled") return;
    await this.cancelRuntime(record);
    record.snapshot.state = state;
    record.snapshot.paused = false;
    record.snapshot.nextRestartAt = null;
    for (const delivery of [...this.delivered].filter((item) => item.triggerId === record.snapshot.id)) {
      await this.cleanupDelivery(delivery);
      this.delivered.splice(this.delivered.indexOf(delivery), 1);
    }
    for (const delivery of [...this.pending.values()].filter((item) => item.triggerId === record.snapshot.id)) {
      this.pending.delete(delivery.token);
      await this.cleanupDelivery(delivery);
    }
    record.snapshot.pendingCount = 0;
    this.emitExternal(record, "cancelled", reason);
  }

  /**
   * Terminate a supervised process. A single SIGTERM to the direct child is not
   * enough: a grandchild or a signal that the child ignores would let the
   * process outlive a "cancelled" report. So this sends SIGTERM, then escalates
   * to SIGKILL after a bounded grace period if the child has not exited. The
   * process adapter widens each signal to the process group or tree where the
   * platform allows.
   */
  private async terminateHandle(handle: TriggerProcessHandle): Promise<void> {
    let exited = false;
    const completed = handle.completed.then(() => { exited = true; }, () => { exited = true; });
    try { handle.kill("SIGTERM"); } catch { /* the child may already be gone */ }
    await this.race(completed, TERMINATION_GRACE_MS);
    if (exited) return;
    try { handle.kill("SIGKILL"); } catch { /* best effort */ }
    await this.race(completed, TERMINATION_KILL_WAIT_MS);
  }

  /**
   * Start a termination without blocking the caller, and keep the promise so
   * shutdown can wait for the child. Cancel must not hang on a child that never
   * exits, but shutdown must not orphan one either: the parent exits within
   * milliseconds, and a detached escalation timer dies with it.
   */
  private beginTermination(handle: TriggerProcessHandle): void {
    const termination = this.terminateHandle(handle)
      .catch(() => {})
      .finally(() => { this.terminations.delete(termination); });
    this.terminations.add(termination);
  }

  /** Wait for the supervised children, bounded so one wedged child cannot hang the exit. */
  private async awaitTerminations(): Promise<void> {
    if (this.terminations.size === 0) return;
    await this.race(Promise.all([...this.terminations]).then(() => {}), SHUTDOWN_TERMINATION_MS);
  }

  /** Settle when `operation` settles or when the deadline passes, leaving no live timer. */
  private async race(operation: Promise<unknown>, delayMs: number): Promise<void> {
    let timer: unknown;
    const deadline = new Promise<void>((resolve) => { timer = this.options.clock.setTimeout(resolve, delayMs); });
    try {
      await Promise.race([operation, deadline]);
    } finally {
      this.options.clock.clearTimeout(timer);
    }
  }

  /**
   * Arm a timer for an arbitrary delay. Node clamps a single delay above the
   * 32-bit bound to 1ms, so a long wait re-arms in chunks until the real
   * deadline arrives.
   */
  private armLongTimeout(delayMs: number, store: (handle: unknown) => void, callback: () => void): void {
    const deadline = this.options.clock.now() + Math.max(0, delayMs);
    const arm = (): void => {
      const remaining = Math.max(0, deadline - this.options.clock.now());
      store(this.options.clock.setTimeout(() => {
        if (this.options.clock.now() < deadline) {
          arm();
          return;
        }
        store(undefined);
        callback();
      }, Math.min(remaining, MAX_TIMEOUT_DELAY_MS)));
    };
    arm();
  }

  private async cancelRuntime(record: TriggerRecord): Promise<void> {
    record.generation += 1;
    if (record.timer !== undefined) this.options.clock.clearTimeout(record.timer);
    if (record.expiryTimer !== undefined) this.options.clock.clearTimeout(record.expiryTimer);
    record.timer = undefined;
    record.expiryTimer = undefined;
    if (record.handle) {
      this.beginTermination(record.handle);
      record.handle = undefined;
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
    if (record.writer) {
      await record.writer.remove().catch(() => {});
      record.writer = undefined;
    }
  }

  private expire(record: TriggerRecord, reason: string): void {
    if (record.timer !== undefined) this.options.clock.clearTimeout(record.timer);
    record.timer = undefined;
    record.snapshot.state = "expired";
    record.snapshot.nextRestartAt = null;
    this.emitExternal(record, "expired", reason);
  }

  private fail(record: TriggerRecord, error: unknown): void {
    if (this.isTerminal(record)) return;
    record.snapshot.state = "idle";
    const reason = error instanceof Error ? error.message : String(error);
    this.emitExternal(record, "failed", reason);
    this.afterRun(record);
  }

  private isTerminal(record: TriggerRecord): boolean {
    return ["expired", "cancelled", "unavailable"].includes(record.snapshot.state);
  }

  private eventData(
    record: TriggerRecord,
    state: ExternalTriggerEventData["state"],
    reason?: string,
    result = record.snapshot.lastResult,
  ): ExternalTriggerEventData {
    const clonedResult = result
      ? { ...result, output: result.output ? { ...result.output } : undefined }
      : undefined;
    return {
      version: 1,
      triggerId: record.snapshot.id,
      name: record.snapshot.name,
      state,
      target: { ...record.snapshot.target },
      executable: record.snapshot.executable,
      args: [...record.snapshot.args],
      at: this.options.clock.now(),
      fireCount: record.snapshot.fireCount,
      pendingCount: record.snapshot.pendingCount,
      coalescedCount: record.snapshot.coalescedCount,
      startedAt: clonedResult?.startedAt ?? null,
      finishedAt: clonedResult?.finishedAt ?? null,
      durationMs: clonedResult?.durationMs ?? null,
      exitCode: clonedResult?.exitCode ?? null,
      signal: clonedResult?.signal ?? null,
      manual: clonedResult?.manual ?? false,
      output: clonedResult?.output,
      result: clonedResult,
      reason,
    };
  }

  private emitExternal(record: TriggerRecord, state: ExternalTriggerEventData["state"], reason?: string): void {
    this.emitExternalData(record, this.eventData(record, state, reason));
  }

  private emitExternalData(record: TriggerRecord, data: ExternalTriggerEventData): void {
    const event: ExternalTriggerCustomEvent = { type: "custom", customType: EXTERNAL_TRIGGER_CUSTOM_TYPE, data };
    this.options.onPersistEvent?.(event);
    this.emit({ type: "external", event });
    this.emitChanged(record);
  }

  private emitChanged(record: TriggerRecord): void {
    this.emit({ type: "changed", snapshot: cloneSnapshot(record.snapshot) });
  }

  private emit(event: TriggerManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

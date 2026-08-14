import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { sanitizeShellEnvironment } from "./process";
import {
  DEFAULT_SHELL_OUTPUT_LIMIT_BYTES,
  DEFAULT_SHELL_RETAINED_LIMIT,
  DEFAULT_SHELL_RUNNING_LIMIT,
  DEFAULT_SHELL_TERMINATION_GRACE_MS,
  type CreateShellInput,
  type GetShellOutputOptions,
  type PublicShellManager,
  type ShellClock,
  type ShellManagerEvent,
  type ShellManagerOptions,
  type ShellOutputResult,
  type ShellOutputWriter,
  type ShellOwner,
  type ShellProcessExit,
  type ShellProcessHandle,
  type ShellSnapshot,
} from "./types";

const encoder = new TextEncoder();
const STDOUT_MARKER = encoder.encode("\n--- stdout ---\n");
const STDERR_MARKER = encoder.encode("\n--- stderr ---\n");
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_SCAN_LIMIT = 1024 * 1024;

type ReadyWait = {
  regex: RegExp;
  decoder: TextDecoder;
  text: string;
  timer?: unknown;
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
};

type OutputWait = {
  regex: RegExp;
  timer?: unknown;
  settled: boolean;
  resolve(result: { matched: boolean; timedOut: boolean }): void;
};

type ShellRecord = {
  snapshot: ShellSnapshot;
  writer: ShellOutputWriter;
  handle?: ShellProcessHandle;
  completion?: Promise<void>;
  writeQueue: Promise<void>;
  wroteStdoutMarker: boolean;
  wroteStderrMarker: boolean;
  terminationRequested: boolean;
  killTimer?: unknown;
  readyWait?: ReadyWait;
  outputDecoder: TextDecoder;
  recentText: string;
  outputWaits: Set<OutputWait>;
  finalized: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function exactOwner(a: ShellOwner, b: ShellOwner): boolean {
  return a.sessionId === b.sessionId && a.agentId === b.agentId;
}

function cloneSnapshot(snapshot: ShellSnapshot): ShellSnapshot {
  return {
    ...snapshot,
    owner: { ...snapshot.owner },
    args: [...snapshot.args],
    output: { ...snapshot.output },
  };
}

function active(state: ShellSnapshot["state"]): boolean {
  return state === "starting" || state === "running";
}

export class ShellManager implements PublicShellManager {
  private readonly records = new Map<string, ShellRecord>();
  private readonly creatingIds = new Set<string>();
  private readonly listeners = new Set<(event: ShellManagerEvent) => void>();
  private readonly options: ShellManagerOptions;
  private readonly clock: ShellClock;
  private readonly runningLimit: number;
  private readonly retainedLimit: number;
  private readonly outputLimitBytes: number;
  private readonly terminationGraceMs: number;
  private readonly createId: () => string;
  private shutdownRequested = false;

  constructor(options: ShellManagerOptions) {
    this.options = options;
    this.clock = options.clock;
    this.runningLimit = positiveInteger(options.runningLimit ?? DEFAULT_SHELL_RUNNING_LIMIT, "runningLimit");
    this.retainedLimit = positiveInteger(options.retainedLimit ?? DEFAULT_SHELL_RETAINED_LIMIT, "retainedLimit");
    this.outputLimitBytes = positiveInteger(options.outputLimitBytes ?? DEFAULT_SHELL_OUTPUT_LIMIT_BYTES, "outputLimitBytes");
    this.terminationGraceMs = positiveInteger(
      options.terminationGraceMs ?? DEFAULT_SHELL_TERMINATION_GRACE_MS,
      "terminationGraceMs",
    );
    this.createId = options.createId ?? randomUUID;
  }

  subscribe(listener: (event: ShellManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(owner?: ShellOwner): ShellSnapshot[] {
    return [...this.records.values()]
      .filter((record) => owner === undefined || exactOwner(record.snapshot.owner, owner))
      .map((record) => cloneSnapshot(record.snapshot))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  getShells(owner?: ShellOwner): ShellSnapshot[] { return this.list(owner) }

  inspect(id: string, owner?: ShellOwner): ShellSnapshot {
    return cloneSnapshot(this.authorizedRecord(id, owner).snapshot);
  }

  async getOutput(id: string, options: GetShellOutputOptions, owner?: ShellOwner): Promise<ShellOutputResult> {
    const record = this.authorizedRecord(id, owner);
    if (!Number.isSafeInteger(options.lineLimit) || options.lineLimit < 1) {
      throw new Error("lineLimit must be a positive integer");
    }
    let pattern: RegExp | undefined;
    if (options.waitPattern !== undefined) {
      if (!options.waitPattern) throw new Error("waitPattern must not be empty");
      try {
        pattern = new RegExp(options.waitPattern);
      } catch (error) {
        throw new Error(`Invalid shell output regex: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error("timeoutMs must be a positive number");
    }

    const waitResult = pattern
      ? await this.waitForOutput(record, pattern, options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
      : undefined;
    await record.writeQueue.catch(() => {});
    const bytes = record.snapshot.output.exists
      ? await this.options.files.readOutput(record.snapshot.output.path).catch(() => new Uint8Array())
      : new Uint8Array();
    const text = new TextDecoder().decode(bytes);
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const tail = lines.slice(-options.lineLimit).join("\n");
    const matchingLines = pattern
      ? lines.filter((line) => { pattern!.lastIndex = 0; return pattern!.test(line); }).slice(-options.lineLimit)
      : undefined;
    return {
      shell: cloneSnapshot(record.snapshot),
      tail,
      matchingLines,
      matched: waitResult?.matched,
      timedOut: waitResult?.timedOut,
    };
  }

  async create(input: CreateShellInput): Promise<ShellSnapshot> {
    this.assertOpen();
    const readyRegex = this.validateInput(input);
    if (this.records.size + this.creatingIds.size >= this.retainedLimit) {
      throw new Error(`Retained shell limit reached (${this.retainedLimit})`);
    }
    if (this.runningCount() + this.creatingIds.size >= this.runningLimit) {
      throw new Error(`Running shell limit reached (${this.runningLimit})`);
    }

    const id = input.id?.trim() || this.createId();
    if (this.records.has(id) || this.creatingIds.has(id)) throw new Error(`Shell already exists: ${id}`);
    this.creatingIds.add(id);
    const createdAt = this.clock.now();
    let writer: ShellOutputWriter | undefined;
    try {
      writer = await this.options.files.createPrivateOutput(id);
      this.assertOpen();
    } catch (error) {
      this.creatingIds.delete(id);
      await writer?.remove().catch(() => {});
      throw error;
    }
    const snapshot: ShellSnapshot = {
      id,
      name: input.name?.trim() || basename(input.executable),
      owner: { ...input.owner },
      executable: input.executable,
      args: [...(input.args ?? [])],
      cwd: input.cwd,
      state: "starting",
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      exitCode: null,
      signal: null,
      ready: readyRegex === undefined,
      readyAt: readyRegex === undefined ? createdAt : null,
      output: { path: writer.path, bytes: 0, truncated: false, exists: true },
    };
    const record: ShellRecord = {
      snapshot,
      writer,
      writeQueue: Promise.resolve(),
      wroteStdoutMarker: false,
      wroteStderrMarker: false,
      terminationRequested: false,
      outputDecoder: new TextDecoder(),
      recentText: "",
      outputWaits: new Set(),
      finalized: false,
    };
    this.creatingIds.delete(id);
    this.records.set(id, record);
    this.emitChanged(record);

    let readyPromise: Promise<void> | undefined;
    if (readyRegex) {
      readyPromise = new Promise<void>((resolve, reject) => {
        const wait: ReadyWait = { regex: readyRegex, decoder: new TextDecoder(), text: "", settled: false, resolve, reject };
        const timeoutMs = input.waitTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
        wait.timer = this.clock.setTimeout(() => {
          if (wait.settled) return;
          wait.settled = true;
          reject(new Error(`Shell readiness wait timed out after ${timeoutMs}ms: ${id}`));
          void this.terminate(id).catch(() => {});
        }, timeoutMs);
        record.readyWait = wait;
      });
    }

    try {
      const environment = sanitizeShellEnvironment(this.options.environment ?? process.env, input.env);
      record.handle = this.options.process.spawn({
        executable: input.executable,
        args: input.args ?? [],
        cwd: input.cwd,
        env: environment,
        onStdout: (chunk) => this.capture(record, "stdout", chunk),
        onStderr: (chunk) => this.capture(record, "stderr", chunk),
      });
      record.snapshot.state = "running";
      record.snapshot.startedAt = this.clock.now();
      this.emitChanged(record);
      record.completion = record.handle.completed.then(
        (result) => this.finalize(record, result),
        (error) => this.finalize(record, { exitCode: null, signal: null }, error),
      );
      void record.completion;
    } catch (error) {
      await this.finalize(record, { exitCode: null, signal: null }, error);
      await readyPromise?.catch(() => {});
      throw error;
    }

    if (readyPromise) await readyPromise;
    return cloneSnapshot(record.snapshot);
  }

  start(input: CreateShellInput): Promise<ShellSnapshot> { return this.create(input) }

  async terminate(id: string, owner?: ShellOwner): Promise<ShellSnapshot> {
    const record = this.authorizedRecord(id, owner);
    if (!active(record.snapshot.state) || !record.handle) return cloneSnapshot(record.snapshot);
    if (!record.terminationRequested) {
      record.terminationRequested = true;
      record.handle.kill("SIGTERM");
      record.killTimer = this.clock.setTimeout(() => {
        if (!record.finalized) record.handle?.kill("SIGKILL");
      }, this.terminationGraceMs);
    }
    await record.completion?.catch(() => {});
    return cloneSnapshot(record.snapshot);
  }

  kill(id: string, owner?: ShellOwner): Promise<ShellSnapshot> { return this.terminate(id, owner) }

  async remove(id: string, owner?: ShellOwner): Promise<void> {
    const record = this.authorizedRecord(id, owner);
    if (active(record.snapshot.state)) await this.terminate(id, owner);
    await record.writeQueue.catch(() => {});
    await record.writer.remove().catch(() => {});
    record.snapshot.output.exists = false;
    this.records.delete(id);
    this.emit({ type: "removed", id });
  }

  async invalidateSession(sessionId: string): Promise<void> {
    await this.removeMatching((owner) => owner.sessionId === sessionId);
  }

  async invalidateAgent(sessionId: string, agentId: string): Promise<void> {
    await this.removeMatching((owner) => owner.sessionId === sessionId && owner.agentId === agentId);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    const records = [...this.records.values()];
    await Promise.all(records.map(async (record) => {
      if (active(record.snapshot.state)) await this.terminate(record.snapshot.id).catch(() => {});
      await record.writer.remove().catch(() => {});
      record.snapshot.output.exists = false;
    }));
    this.records.clear();
    this.listeners.clear();
  }

  private validateInput(input: CreateShellInput): RegExp | undefined {
    if (!input.owner?.sessionId || !input.owner.label || input.owner.agentId === "") throw new Error("Shell owner is invalid");
    if (!input.executable?.trim() || input.executable.includes("\0")) throw new Error("Shell executable is invalid");
    for (const arg of input.args ?? []) if (arg.includes("\0")) throw new Error("Shell argument contains NUL");
    if (!input.cwd?.trim() || input.cwd.includes("\0")) throw new Error("Shell cwd is invalid");
    if (input.name?.includes("\0")) throw new Error("Shell name contains NUL");
    if (input.waitTimeoutMs !== undefined && (!Number.isFinite(input.waitTimeoutMs) || input.waitTimeoutMs < 1)) {
      throw new Error("waitTimeoutMs must be a positive number");
    }
    if (input.waitFor === undefined) return undefined;
    if (!input.waitFor) throw new Error("waitFor must not be empty");
    try {
      return new RegExp(input.waitFor);
    } catch (error) {
      throw new Error(`Invalid shell readiness regex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private capture(record: ShellRecord, stream: "stdout" | "stderr", chunk: Uint8Array): void {
    if (record.finalized || chunk.byteLength === 0) return;
    const text = record.outputDecoder.decode(chunk, { stream: true });
    record.recentText = (record.recentText + text).slice(-READY_SCAN_LIMIT);
    this.scanReadiness(record, chunk);
    this.scanOutputWaits(record);
    const markerWritten = stream === "stdout" ? record.wroteStdoutMarker : record.wroteStderrMarker;
    const marker = stream === "stdout" ? STDOUT_MARKER : STDERR_MARKER;
    if (!markerWritten) {
      if (stream === "stdout") record.wroteStdoutMarker = true;
      else record.wroteStderrMarker = true;
      this.queueCapturedBytes(record, marker);
    }
    this.queueCapturedBytes(record, chunk);
  }

  private queueCapturedBytes(record: ShellRecord, chunk: Uint8Array): void {
    const remaining = Math.max(0, this.outputLimitBytes - record.snapshot.output.bytes);
    if (remaining === 0) {
      record.snapshot.output.truncated = true;
      return;
    }
    const captured = chunk.byteLength <= remaining ? chunk.slice() : chunk.slice(0, remaining);
    if (captured.byteLength < chunk.byteLength) record.snapshot.output.truncated = true;
    record.snapshot.output.bytes += captured.byteLength;
    record.writeQueue = record.writeQueue.then(() => record.writer.write(captured)).catch(() => {
      record.snapshot.output.exists = false;
    });
  }

  private scanReadiness(record: ShellRecord, chunk: Uint8Array): void {
    const wait = record.readyWait;
    if (!wait || wait.settled) return;
    wait.text += wait.decoder.decode(chunk, { stream: true });
    if (wait.text.length > READY_SCAN_LIMIT) wait.text = wait.text.slice(-READY_SCAN_LIMIT);
    wait.regex.lastIndex = 0;
    if (!wait.regex.test(wait.text)) return;
    wait.settled = true;
    if (wait.timer !== undefined) this.clock.clearTimeout(wait.timer);
    record.snapshot.ready = true;
    record.snapshot.readyAt = this.clock.now();
    wait.resolve();
    this.emitChanged(record);
  }

  private waitForOutput(
    record: ShellRecord,
    regex: RegExp,
    timeoutMs: number,
  ): Promise<{ matched: boolean; timedOut: boolean }> {
    regex.lastIndex = 0;
    if (regex.test(record.recentText)) return Promise.resolve({ matched: true, timedOut: false });
    if (record.finalized) return Promise.resolve({ matched: false, timedOut: false });
    return new Promise((resolve) => {
      const wait: OutputWait = { regex, settled: false, resolve };
      wait.timer = this.clock.setTimeout(() => {
        if (wait.settled) return;
        wait.settled = true;
        record.outputWaits.delete(wait);
        resolve({ matched: false, timedOut: true });
      }, timeoutMs);
      record.outputWaits.add(wait);
    });
  }

  private scanOutputWaits(record: ShellRecord): void {
    for (const wait of [...record.outputWaits]) {
      wait.regex.lastIndex = 0;
      if (!wait.regex.test(record.recentText)) continue;
      wait.settled = true;
      if (wait.timer !== undefined) this.clock.clearTimeout(wait.timer);
      record.outputWaits.delete(wait);
      wait.resolve({ matched: true, timedOut: false });
    }
  }

  private async finalize(record: ShellRecord, result: ShellProcessExit, error?: unknown): Promise<void> {
    if (record.finalized) return;
    record.finalized = true;
    if (record.killTimer !== undefined) this.clock.clearTimeout(record.killTimer);
    const wait = record.readyWait;
    if (wait && !wait.settled) {
      wait.settled = true;
      if (wait.timer !== undefined) this.clock.clearTimeout(wait.timer);
      wait.reject(new Error(`Shell exited before readiness matched: ${record.snapshot.id}`));
    }
    for (const outputWait of [...record.outputWaits]) {
      outputWait.settled = true;
      if (outputWait.timer !== undefined) this.clock.clearTimeout(outputWait.timer);
      record.outputWaits.delete(outputWait);
      outputWait.resolve({ matched: false, timedOut: false });
    }
    await record.writeQueue.catch(() => {});
    await record.writer.close().catch(() => { record.snapshot.output.exists = false; });
    record.snapshot.finishedAt = this.clock.now();
    record.snapshot.exitCode = result.exitCode;
    record.snapshot.signal = result.signal;
    record.snapshot.state = error
      ? "failed"
      : record.terminationRequested
        ? "terminated"
        : "exited";
    this.emitChanged(record);
    try {
      await this.options.onCompleted?.(cloneSnapshot(record.snapshot));
    } catch {
      // Completion notification failures must not repeat process settlement.
    }
  }

  private runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (active(record.snapshot.state)) count += 1;
    return count;
  }

  private authorizedRecord(id: string, owner?: ShellOwner): ShellRecord {
    const record = this.records.get(id);
    if (!record || (owner !== undefined && !exactOwner(record.snapshot.owner, owner))) {
      throw new Error(`Shell not found: ${id}`);
    }
    return record;
  }

  private async removeMatching(predicate: (owner: ShellOwner) => boolean): Promise<void> {
    const ids = [...this.records.values()]
      .filter((record) => predicate(record.snapshot.owner))
      .map((record) => record.snapshot.id);
    await Promise.all(ids.map((id) => this.remove(id)));
  }

  private assertOpen(): void {
    if (this.shutdownRequested) throw new Error("Shell manager is shut down");
  }

  private emitChanged(record: ShellRecord): void {
    this.emit({ type: "changed", snapshot: cloneSnapshot(record.snapshot) });
  }

  private emit(event: ShellManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

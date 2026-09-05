import {
  createEditToolDefinition, createWriteToolDefinition, withFileMutationQueue,
  type AgentSession, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AGENT_DIR } from "./config";
import { getCheckModeConfig } from "./check-mode";
import { pathSensitivity } from "./check-mutation";
import { validateSandboxPath } from "./filesystem-sandbox";
import { canonicalPathIdentityAllowMissing, isPathInsideOrSame } from "./platform";

export const CHECKPOINT_MAX_FILE_BYTES = 1024 * 1024;
export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
export const CHECKPOINT_MAX_RECORDS = 32;

type Snapshot = { bytes: Buffer; fingerprint: string };
export type FileCheckpointInfo = {
  id: string; path: string; toolName: "write" | "edit"; createdAt: number;
  bytes: number; priorAbsent: boolean;
};
type Record = FileCheckpointInfo & { before: Buffer | null; after: string };
type Pending = { path: string; before: Buffer | null; after: string };
const controllers = new Map<string, FileCheckpointController>();
const bindings = new Map<string, { controller?: FileCheckpointController }>();
/** AgentSession.dispose does NOT emit session_shutdown (notably worker closure). */
export function bindFileCheckpointSession(session: Pick<AgentSession, "sessionId" | "dispose">): void {
  const id = session.sessionId;
  const binding = { controller: controllers.get(id) };
  bindings.set(id, binding);
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    try { dispose(); }
    finally {
      binding.controller?.dispose();
      if (controllers.get(id) === binding.controller) controllers.delete(id);
      if (bindings.get(id) === binding) bindings.delete(id);
    }
  };
}
export function checkpointControllerForSession(sessionId: string): FileCheckpointController | undefined {
  return controllers.get(sessionId);
}
function metadata(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
class CheckpointConflictError extends Error {}
class RecoveryError extends Error {}
/** Only our finite recovery errors may reach the UI; raw IO failures stay private. */
export function checkpointRecoveryFailureText(error: unknown): string {
  return error instanceof RecoveryError ? error.message
    : "Checkpoint recovery failed; no in-place restore was attempted. List checkpoints to check availability.";
}

/** Runtime-private bytes. No persistence, model restore tool, or original-file restore. */
export class FileCheckpointController {
  private records: Record[] = [];
  private retainedBytes = 0;
  private skipped = 0;
  private evicted = 0;
  private disposed = false;
  private generation = 0;
  constructor(
    private readonly cwd: string,
    private readonly allowedPaths: () => readonly string[] = () => getCheckModeConfig().additionalPaths ?? [],
    private readonly agentDir = AGENT_DIR,
  ) {}

  private async validate(path: string): Promise<string> {
    const target = await validateSandboxPath(this.cwd, path, this.allowedPaths(), "write");
    const identity = await canonicalPathIdentityAllowMissing(target.absolute);
    const config = await canonicalPathIdentityAllowMissing(this.agentDir);
    if (isPathInsideOrSame(config, identity) || pathSensitivity(identity).credential) {
      throw new Error("Checkpoint path is private or credential-sensitive.");
    }
    return target.absolute;
  }

  private async snapshot(path: string): Promise<Snapshot | null> {
    await this.validate(path);
    let stat: Stats;
    try { stat = await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > CHECKPOINT_MAX_FILE_BYTES) {
      throw new Error("Checkpoint requires a singly linked regular file of at most 1 MiB.");
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const initial = await handle.stat();
      if (metadata(initial) !== metadata(stat)) throw new CheckpointConflictError("Checkpoint file changed while opening; mutation refused.");
      // Never use readFile: a concurrently growing file must not allocate unbounded memory.
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const final = await handle.stat();
      await this.validate(path);
      const named = await lstat(path);
      if (offset !== stat.size || metadata(final) !== metadata(stat) || metadata(named) !== metadata(stat)) {
        throw new CheckpointConflictError("Checkpoint file changed while reading; mutation refused.");
      }
      const content = Buffer.from(bytes.subarray(0, offset));
      return { bytes: content, fingerprint: `${metadata(stat)}:${digest(content)}` };
    } finally { await handle.close(); }
  }

  list(): FileCheckpointInfo[] {
    return this.records.map(({ before: _before, after: _after, ...info }) => ({ ...info }));
  }
  summary(): string {
    return `Runtime-only file-tool recovery copies: ${this.records.length}/32 checkpoints, ${this.retainedBytes}/8388608 bytes; ${this.skipped} skipped, ${this.evicted} evicted. Maximum file 1 MiB; oldest evicted first. No Bash coverage. Lost on clear, runtime replacement, worker closure or exit. Originals are never restored in place.`;
  }
  clear(): void {
    this.generation++;
    this.records = [];
    this.retainedBytes = 0;
    this.skipped = 0;
    this.evicted = 0;
  }
  dispose(): void { this.disposed = true; this.clear(); }

  /** Execute through pi's native queue and exact write/edit argument and diff contracts. */
  async execute(
    toolName: "write" | "edit", toolCallId: string, input: any,
    signal?: AbortSignal, onUpdate?: any,
  ): Promise<any> {
    if (this.disposed) throw new Error("Checkpoint runtime is disposed.");
    const generation = this.generation;
    let pending: Pending | undefined;
    let readState: Snapshot | undefined;
    let skip = false;
    const captureWrite = async (path: string, content: string) => {
      // This runs inside the SDK mutation queue, immediately at its write boundary.
      await validateSandboxPath(this.cwd, path, this.allowedPaths(), "write");
      let before: Snapshot | null | undefined;
      try {
        before = await this.snapshot(path);
        if (readState && before?.fingerprint !== readState.fingerprint) {
          throw new CheckpointConflictError("Checkpoint conflict: file changed since edit read; mutation refused.");
        }
      } catch (error) {
        if (readState || error instanceof CheckpointConflictError) throw error;
        skip = true;
      }
      // A skipped capture must never bypass a boundary that changed during IO.
      await validateSandboxPath(this.cwd, path, this.allowedPaths(), "write");
      if (signal?.aborted || this.disposed) throw new Error("Operation aborted");
      await writeFile(path, content, "utf8");
      if (skip || before === undefined || Buffer.byteLength(content) > CHECKPOINT_MAX_FILE_BYTES) { skip = true; return; }
      try {
        const after = await this.snapshot(path);
        if (!after || !after.bytes.equals(Buffer.from(content, "utf8"))) { skip = true; return; }
        pending = { path, before: before?.bytes ?? null, after: after.fingerprint };
      } catch { skip = true; }
    };
    const write = createWriteToolDefinition(this.cwd, { operations: {
      mkdir: async (path) => {
        await validateSandboxPath(this.cwd, path, this.allowedPaths(), "write");
        if (signal?.aborted || this.disposed) throw new Error("Operation aborted");
        await mkdir(path, { recursive: true });
      }, writeFile: captureWrite,
    } });
    const edit = createEditToolDefinition(this.cwd, { operations: {
      access: async (path) => { await access(path, constants.R_OK | constants.W_OK); },
      readFile: async (path) => {
        // Oversized edits retain native functionality, without checkpoint coverage.
        await validateSandboxPath(this.cwd, path, this.allowedPaths(), "write");
        try { readState = (await this.snapshot(path)) ?? undefined; }
        catch (error) {
          if (error instanceof CheckpointConflictError) throw error;
          skip = true;
        }
        if (readState) return Buffer.from(readState.bytes);
        const { readFile } = await import("node:fs/promises");
        return readFile(path);
      }, writeFile: captureWrite,
    } });
    const tool = toolName === "write" ? write : edit;
    const result = await tool.execute(toolCallId, input, signal, onUpdate, { cwd: this.cwd } as any);
    if (signal?.aborted || this.disposed || generation !== this.generation) return result;
    let note: string;
    if (!skip && pending) {
      const record: Record = {
        id: randomUUID(), path: pending.path, toolName, createdAt: Date.now(),
        bytes: pending.before?.length ?? 0, priorAbsent: pending.before === null,
        before: pending.before, after: pending.after,
      };
      while (this.records.length >= CHECKPOINT_MAX_RECORDS || this.retainedBytes + record.bytes > CHECKPOINT_MAX_BYTES) {
        this.retainedBytes -= this.records.shift()!.bytes;
        this.evicted++;
      }
      this.records.push(record);
      this.retainedBytes += record.bytes;
      note = record.priorAbsent
        ? "Checkpoint records prior absence; no preimage to recover and no automatic deletion."
        : "Runtime-only file checkpoint retained; user may export a recovery copy with /checkpoint. No in-place rewind.";
    } else {
      this.skipped++;
      note = "No file checkpoint retained (unsupported, oversized, unavailable or concurrently changed file).";
    }
    return { ...result, content: [...result.content, { type: "text", text: note }] };
  }

  /** User-only export. Never write, rename over, chmod or unlink the original. */
  async recover(id: string): Promise<string> {
    const record = this.records.find((item) => item.id === id);
    if (!record || this.disposed) throw new RecoveryError("Checkpoint unavailable or expired.");
    if (record.before === null) throw new RecoveryError("File was newly created: no prior bytes to recover. Original was not deleted.");
    const generation = this.generation;
    const preimage = record.before;
    return withFileMutationQueue(record.path, async () => {
      const current = await this.snapshot(record.path);
      if (current?.fingerprint !== record.after) throw new RecoveryError("Checkpoint conflict: original changed; no recovery file created.");
      if (generation !== this.generation || this.disposed) throw new RecoveryError("Checkpoint expired during recovery.");
      // Random flat sibling, independent of a potentially special source basename.
      const destination = join(dirname(record.path), `pum-recovery-${randomUUID()}.txt`);
      await this.validate(destination);
      let handle;
      try { handle = await open(destination, "wx", 0o600); }
      catch { throw new RecoveryError("Recovery file could not be exclusively created. Original is unchanged."); }
      try {
        // Validate the opened name again BEFORE releasing any private preimage bytes.
        await this.validate(destination);
        const opened = await handle.stat();
        const linked = await lstat(destination);
        if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0
          || metadata(opened) !== metadata(linked)
          || generation !== this.generation || this.disposed) {
          throw new Error("Recovery destination changed before write");
        }
        await handle.writeFile(preimage);
        await handle.sync();
        await this.validate(destination);
        const exported = await this.snapshot(destination);
        const own = await handle.stat();
        const named = await lstat(destination);
        const final = await this.snapshot(record.path);
        if (metadata(own) !== metadata(named) || !exported?.bytes.equals(preimage)
          || final?.fingerprint !== record.after || generation !== this.generation || this.disposed) {
          throw new Error("Recovery validation conflict");
        }
      } catch {
        // Never unlink by name: another writer may have replaced/edited the artifact.
        throw new RecoveryError(`Recovery failed or conflicted; possible partial recovery file: ${JSON.stringify(destination)}. Original was not changed by recovery.`);
      } finally {
        try { await handle.close(); }
        catch { throw new RecoveryError(`Recovery close failed; inspect possible recovery file: ${JSON.stringify(destination)}. Original was not changed by recovery.`); }
      }
      return destination;
    });
  }
}

/** A fresh extension instance per runtime; no state survives session replacement. */
export function createFileCheckpointExtension(options: { readonly?: boolean } = {}): InlineExtension {
  return {
    name: "pum-file-checkpoints",
    factory(pi) {
      if (options.readonly) return;
      let controller: FileCheckpointController | undefined;
      let sessionId: string | undefined;
      let retired = false;
      const obtain = (ctx: { cwd: string; sessionManager: { getSessionId(): string } }) => {
        const id = ctx.sessionManager.getSessionId();
        if (retired || (sessionId !== undefined && sessionId !== id)) throw new Error("Checkpoint runtime is unavailable.");
        if (!controller) {
          controller = new FileCheckpointController(ctx.cwd);
          sessionId = id;
          controllers.set(id, controller);
          const binding = bindings.get(id);
          if (binding) binding.controller = controller;
        }
        return controller;
      };
      pi.on("session_start", (_event, ctx) => { obtain(ctx); });
      pi.on("session_shutdown", () => {
        retired = true;
        controller?.dispose();
        if (sessionId && controllers.get(sessionId) === controller) controllers.delete(sessionId);
        controller = undefined;
      });
      const write = createWriteToolDefinition(process.cwd());
      const edit = createEditToolDefinition(process.cwd());
      pi.registerTool({ ...write, execute: (id, args, signal, onUpdate, ctx) => obtain(ctx).execute("write", id, args, signal, onUpdate) });
      pi.registerTool({ ...edit, execute: (id, args, signal, onUpdate, ctx) => obtain(ctx).execute("edit", id, args, signal, onUpdate) });
    },
  };
}

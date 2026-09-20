import { createReadToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { getCheckModeConfig } from "./check-mode";
import { validateSandboxPath } from "./filesystem-sandbox";
import { canonicalPathIdentityAllowMissing } from "./platform";

export const MUTATION_BASELINE_MAX_FILE_BYTES = 1024 * 1024;
export const MUTATION_BASELINE_MAX_BYTES = 8 * 1024 * 1024;
export const MUTATION_BASELINE_MAX_FILES = 128;
const guidance = "Read the file again, reconcile the changes, and retry. Coordinate overlapping work or use spawn_subagent with worktree: true. Bash and external editors are not locked by this guard.";
export class FileMutationConflictError extends Error {
  constructor(reason: string) { super(`File mutation conflict: ${reason}. ${guidance}`); }
}
type Snapshot = { fingerprint: string; bytes?: Buffer; absent: boolean };
type Proposal = {
  path: string; key: string; inputKey: string; id: string; tool: "write" | "edit";
  baseline: Snapshot; observed: boolean;
};
export type MutationAdmission = { path: string; current: Snapshot; rebased: boolean; notice?: string };
const queues = new Map<string, Promise<void>>();

function metadata(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function normalized(bytes: Buffer): string { return bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"); }
function uniqueLines(text: string, needle: string): string | undefined {
  const at = text.indexOf(needle);
  if (!needle.length || at < 0 || text.indexOf(needle, at + 1) >= 0) return undefined;
  // Include the whole touched lines, not just the substring: "value = 1" still
  // matches "value = 10", but overwriting that prefix would clobber a newer edit.
  const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at + needle.length - 1);
  return text.slice(start, end < 0 ? text.length : end + 1);
}
/** Deliberately stricter than pi's fuzzy matcher when rebasing a stale proposal. */
function unchangedEditTargets(before: Snapshot, now: Snapshot, input: any): boolean {
  if (!before.bytes || !now.bytes || !Array.isArray(input.edits) || !input.edits.length) return false;
  // Invalid UTF-8 / binary bytes cannot safely be reasoned about as text.
  if (!Buffer.from(before.bytes.toString("utf8")).equals(before.bytes)
    || !Buffer.from(now.bytes.toString("utf8")).equals(now.bytes)
    || before.bytes.includes(0) || now.bytes.includes(0)) return false;
  const currentText = now.bytes.toString("utf8");
  // pi normalizes every line ending before editing and restores one style for
  // the whole file. A stale rebase must not erase another writer's untouched
  // mixed/bare-CR endings while claiming to preserve their changes. Uniform LF
  // and CRLF round-trip; fresh (non-rebased) edits retain native behavior.
  if (currentText.replace(/\r\n/g, "").includes("\r")
    || (currentText.includes("\r\n") && /(?<!\r)\n/.test(currentText))) return false;
  const a = normalized(before.bytes), b = normalized(now.bytes);
  return input.edits.every((edit: any) => {
    if (typeof edit?.oldText !== "string") return false;
    const needle = normalized(Buffer.from(edit.oldText));
    const original = uniqueLines(a, needle);
    return original !== undefined && original === uniqueLines(b, needle);
  });
}

/** Separate from pi's queue: canonical Windows/missing-path identities must also serialize. */
async function inQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  queues.set(key, tail);
  await previous;
  try { return await run(); }
  finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}

/** Runtime-owned observations, never persisted, never populated from replay/model input. */
export class FileMutationGuard {
  private baselines = new Map<string, Snapshot>();
  private retainedBytes = 0;
  private proposals = new Map<object, Proposal>();
  private proposalBytes = 0;
  private disposed = false;
  constructor(
    private readonly cwd: string,
    private readonly allowedPaths: () => readonly string[] = () => getCheckModeConfig().additionalPaths ?? [],
  ) {}
  dispose(): void {
    this.disposed = true;
    this.baselines.clear(); this.clearProposals(); this.retainedBytes = 0;
  }
  clearProposals(): void { this.proposals.clear(); this.proposalBytes = 0; }
  forgetProposal(input: object): void {
    this.proposalBytes -= this.proposals.get(input)?.baseline.bytes?.length ?? 0;
    this.proposals.delete(input);
  }
  private live(): void { if (this.disposed) throw new Error("File mutation guard runtime is disposed."); }
  private remember(key: string, value: Snapshot): void {
    this.live();
    const prior = this.baselines.get(key);
    this.retainedBytes -= prior?.bytes?.length ?? 0;
    this.baselines.delete(key);
    while (this.baselines.size >= MUTATION_BASELINE_MAX_FILES
      || this.retainedBytes + (value.bytes?.length ?? 0) > MUTATION_BASELINE_MAX_BYTES) {
      const first = this.baselines.keys().next().value!;
      this.retainedBytes -= this.baselines.get(first)?.bytes?.length ?? 0;
      this.baselines.delete(first);
    }
    this.baselines.set(key, value);
    this.retainedBytes += value.bytes?.length ?? 0;
  }
  private async target(path: string, operation: "read" | "write") {
    this.live();
    const { absolute } = await validateSandboxPath(this.cwd, path, this.allowedPaths(), operation);
    return { path: absolute, key: await canonicalPathIdentityAllowMissing(absolute) };
  }
  private async snapshot(path: string, operation: "read" | "write"): Promise<Snapshot> {
    await this.target(path, operation);
    let stat: Stats;
    try { stat = await lstat(path); }
    catch (error) { if (missing(error)) return { fingerprint: "absent", absent: true }; throw error; }
    if (!stat.isFile()) throw new FileMutationConflictError("target is not a regular file");
    // Large files keep metadata-only observations, never allocate unbounded retained bytes.
    if (stat.size > MUTATION_BASELINE_MAX_FILE_BYTES) return { fingerprint: metadata(stat), absent: false };
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (metadata(await handle.stat()) !== metadata(stat)) throw new FileMutationConflictError("file changed while opening");
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      await this.target(path, operation);
      if (size !== stat.size || metadata(await handle.stat()) !== metadata(stat)
        || metadata(await lstat(path)) !== metadata(stat)) throw new FileMutationConflictError("file changed while reading");
      const content = Buffer.from(bytes.subarray(0, size));
      return { fingerprint: `${metadata(stat)}:${digest(content)}`, bytes: content, absent: false };
    } finally { await handle.close(); }
  }

  /** Preserve native image handling and filename retries; observe only a stable successful read. */
  async read(id: string, input: any, signal?: AbortSignal, onUpdate?: any, ctx?: ExtensionContext, autoResizeImages?: boolean): Promise<any> {
    const target = await this.target(input.path, "read");
    const before = await this.snapshot(target.path, "read");
    const result = await createReadToolDefinition(this.cwd, { autoResizeImages }).execute(
      id, input, signal, onUpdate, ctx ?? { cwd: this.cwd } as ExtensionContext,
    );
    const after = await this.snapshot(target.path, "read");
    if (!signal?.aborted && !this.disposed && before.fingerprint === after.fingerprint) this.remember(target.key, before);
    else if (!this.disposed) {
      return { ...result, content: [...result.content, { type: "text", text: "File changed during read; no fresh mutation baseline recorded. Read it again before editing." }] };
    }
    return result;
  }

  /** Called at tool_call, before asynchronous Check review and before any parallel execution. */
  async prepare(tool: "write" | "edit", id: string, input: any): Promise<void> {
    const target = await this.target(input.path, "write");
    const current = await this.snapshot(target.path, "write");
    this.live();
    const observed = this.baselines.get(target.key);
    if (this.proposals.has(input)) throw new FileMutationConflictError("proposal object was reused");
    const baseline = observed ?? current;
    if (this.proposals.size >= MUTATION_BASELINE_MAX_FILES
      || this.proposalBytes + (baseline.bytes?.length ?? 0) > MUTATION_BASELINE_MAX_BYTES) {
      throw new FileMutationConflictError("too many pending file proposals or baseline bytes");
    }
    this.proposals.set(input, {
      ...target, tool, id, inputKey: JSON.stringify(input), baseline, observed: !!observed,
    });
    this.proposalBytes += baseline.bytes?.length ?? 0;
  }

  /** Proposals are consumed exactly once; every queued execution rechecks its immutable baseline. */
  async run<T>(tool: "write" | "edit", id: string, input: any, signal: AbortSignal | undefined,
    execute: (admission: MutationAdmission) => Promise<T>, requirePrepared = false): Promise<T> {
    if (!this.proposals.has(input)) {
      if (requirePrepared) throw new FileMutationConflictError("prepared proposal is missing or expired");
      await this.prepare(tool, id, input);
    }
    const proposal = this.proposals.get(input)!;
    this.forgetProposal(input);
    if (proposal.id !== id || proposal.tool !== tool || proposal.inputKey !== JSON.stringify(input)) throw new FileMutationConflictError("proposal arguments changed");
    return inQueue(proposal.key, async () => {
      this.live();
      if (signal?.aborted) throw new Error("Operation aborted");
      const target = await this.target(input.path, "write");
      if (target.key !== proposal.key) throw new FileMutationConflictError("target identity changed");
      const current = await this.snapshot(target.path, "write");
      const changed = proposal.baseline.fingerprint !== current.fingerprint;
      if (changed && !(tool === "edit" && unchangedEditTargets(proposal.baseline, current, input))) {
        throw new FileMutationConflictError("baseline changed since this runtime's read or mutation proposal");
      }
      const admission: MutationAdmission = {
        path: target.path, current, rebased: changed,
        notice: changed
          ? "File baseline changed outside the exact, unique edit targets and their lines; preserved those other changes. Read again before further mutations."
          : !proposal.observed && !current.absent
            ? "No prior read baseline was available; only changes since this proposal were checked. Read existing files before mutating them; use worktrees for overlapping work."
            : undefined,
      };
      if (!current.absent && !current.bytes) admission.notice = (admission.notice ? `${admission.notice} ` : "")
        + "Large-file conflict detection uses metadata only (over 1 MiB); no stale edit rebasing.";
      // Waiting for another runtime and filesystem validation are asynchronous;
      // the exact prepared object must still carry the originally pinned args.
      if (proposal.inputKey !== JSON.stringify(input)) throw new FileMutationConflictError("proposal arguments changed");
      return execute(admission);
    });
  }

  /** Invoke immediately before the actual write, inside both mutation queues. Not filesystem CAS. */
  async assertUnchanged(admission: MutationAdmission): Promise<void> {
    this.live();
    const current = await this.snapshot(admission.path, "write");
    if (current.fingerprint !== admission.current.fingerprint) throw new FileMutationConflictError("file changed during mutation execution");
  }
  async didWrite(admission: MutationAdmission, content: string): Promise<void> {
    if (this.disposed || admission.rebased) return; // Do not bless unseen changes from a safe rebase.
    const after = await this.snapshot(admission.path, "write");
    if (after.bytes?.equals(Buffer.from(content)) || (!after.absent && !after.bytes)) {
      const { key } = await this.target(admission.path, "write");
      if (!this.disposed) this.remember(key, after);
    } else throw new FileMutationConflictError("postimage changed after writing");
  }
}

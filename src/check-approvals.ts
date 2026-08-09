import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_DIR } from "./config";
import { projectStorageKey } from "./platform";

export const CHECK_APPROVALS_PATH = join(AGENT_DIR, "check-mode-approvals.json");
export const CHECK_APPROVALS_LIMIT = 256;

export type CheckedToolName = "bash" | "edit" | "apply_patch";
export type CheckApprovalChoice = "allow-once" | "allow-session" | "allow-project" | "deny";

export type CheckApprovalRequest = {
  id: string;
  toolName: CheckedToolName;
  model: string;
  cwd: string;
  canonicalInput: string;
  summary: string;
  reason: string;
  paths: string[];
  preview: string;
  taskContext?: string;
  rationale?: string;
};

export function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite canonical input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cyclic canonical input");
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cyclic canonical input");
    seen.add(value);
    const object = value as Record<string, unknown>;
    const result = `{${Object.keys(object).sort().map((key) => {
      if (object[key] === undefined) throw new TypeError("Undefined canonical input");
      return `${JSON.stringify(key)}:${canonicalJson(object[key], seen)}`;
    }).join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new TypeError("Unsupported canonical input");
}

type ApprovalEntry = {
  tool: CheckedToolName;
  model: string;
  cwd: string;
  input: string;
};

type ApprovalFile = { version: 1; entries: ApprovalEntry[] };

function isApprovalEntry(value: unknown): value is ApprovalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ApprovalEntry>;
  return ["bash", "edit", "apply_patch"].includes(entry.tool ?? "")
    && typeof entry.model === "string"
    && typeof entry.cwd === "string"
    && typeof entry.input === "string";
}

export class CheckApprovalStore {
  private loaded = false;
  private entries: ApprovalEntry[] = [];

  constructor(
    private readonly path = CHECK_APPROVALS_PATH,
    private readonly limit = CHECK_APPROVALS_LIMIT,
  ) {}

  has(tool: CheckedToolName, model: string, cwd: string, canonicalInput: string): boolean {
    this.load();
    const key = projectStorageKey(cwd);
    return this.entries.some((entry) =>
      entry.tool === tool && entry.model === model && entry.cwd === key && entry.input === canonicalInput,
    );
  }

  add(tool: CheckedToolName, model: string, cwd: string, canonicalInput: string): boolean {
    this.load();
    const entry = { tool, model, cwd: projectStorageKey(cwd), input: canonicalInput };
    if (this.entries.some((candidate) =>
      candidate.tool === entry.tool
      && candidate.model === entry.model
      && candidate.cwd === entry.cwd
      && candidate.input === entry.input,
    )) return true;
    const previous = this.entries;
    this.entries = this.limit > 0 ? [...this.entries, entry].slice(-this.limit) : [];
    if (this.persist()) return true;
    this.entries = previous;
    return false;
  }

  clearProject(cwd: string): number {
    this.load();
    const key = projectStorageKey(cwd);
    const previous = this.entries;
    this.entries = this.entries.filter((entry) => entry.cwd !== key);
    const removed = previous.length - this.entries.length;
    if (removed > 0 && !this.persist()) {
      this.entries = previous;
      return 0;
    }
    return removed;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ApprovalFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      const valid = parsed.entries.filter(isApprovalEntry);
      this.entries = this.limit > 0 ? valid.slice(-this.limit) : [];
    } catch {
      this.entries = [];
    }
  }

  private persist(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: this.entries } satisfies ApprovalFile, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      return true;
    } catch {
      return false;
    }
  }
}

type PendingApproval = {
  request: CheckApprovalRequest;
  resolve: (choice: CheckApprovalChoice) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class CheckApprovalCoordinator {
  private readonly queue: PendingApproval[] = [];
  private readonly listeners = new Set<(request: CheckApprovalRequest | null) => void>();

  subscribe(listener: (request: CheckApprovalRequest | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.denyAll();
    };
  }

  current(): CheckApprovalRequest | null {
    return this.queue[0]?.request ?? null;
  }

  request(
    request: Omit<CheckApprovalRequest, "id">,
    signal?: AbortSignal,
  ): Promise<CheckApprovalChoice> {
    if (signal?.aborted || this.listeners.size === 0) return Promise.resolve("deny");
    return new Promise((resolve) => {
      const pending: PendingApproval = {
        request: { ...request, id: randomUUID() },
        resolve,
        signal,
      };
      pending.abort = () => this.finish(pending, "deny");
      signal?.addEventListener("abort", pending.abort, { once: true });
      this.queue.push(pending);
      if (this.queue.length === 1) this.emit();
    });
  }

  resolve(id: string, choice: CheckApprovalChoice): boolean {
    const pending = this.queue[0];
    if (!pending || pending.request.id !== id) return false;
    this.finish(pending, choice);
    return true;
  }

  denyAll(): void {
    for (const pending of [...this.queue]) this.finish(pending, "deny", false);
    this.emit();
  }

  private finish(pending: PendingApproval, choice: CheckApprovalChoice, emit = true): void {
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(choice);
    if (emit && index === 0) this.emit();
  }

  private emit(): void {
    const current = this.current();
    for (const listener of this.listeners) listener(current);
  }
}

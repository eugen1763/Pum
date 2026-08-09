import type { SpawnSubagentOptions } from "./types";

export type SpawnPreviewRequester = {
  sessionId: string;
  agentId: string | null;
  name: string;
};

export type SpawnPreviewRequest = {
  id: string;
  requester: SpawnPreviewRequester;
  options: SpawnSubagentOptions;
};

export type SpawnPreviewResult = {
  approved: boolean;
  note: string;
  reason?: "cancelled" | "aborted" | "shutdown" | "unavailable";
};

type PendingSpawnPreview = SpawnPreviewRequest & {
  resolve: (result: SpawnPreviewResult) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export class SpawnPreviewManager {
  private active?: PendingSpawnPreview;
  private readonly queue: PendingSpawnPreview[] = [];
  private readonly listeners = new Set<() => void>();
  private uiCount = 0;
  private nextId = 1;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.uiCount += 1;
    listener();
    return () => {
      this.listeners.delete(listener);
      this.uiCount = Math.max(0, this.uiCount - 1);
    };
  }

  current(): SpawnPreviewRequest | undefined {
    return this.active;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private showNext(): void {
    if (!this.active) this.active = this.queue.shift();
  }

  private finish(request: PendingSpawnPreview, result: SpawnPreviewResult): void {
    if (request.abortListener) request.signal?.removeEventListener("abort", request.abortListener);
    if (this.active === request) this.active = undefined;
    else {
      const index = this.queue.indexOf(request);
      if (index >= 0) this.queue.splice(index, 1);
    }
    request.resolve(result);
    this.showNext();
    this.emit();
  }

  request(
    requester: SpawnPreviewRequester,
    options: SpawnSubagentOptions,
    signal?: AbortSignal,
  ): Promise<SpawnPreviewResult> {
    if (this.uiCount === 0) throw new Error("The PUM spawn preview UI is unavailable");
    return new Promise((resolve) => {
      const request: PendingSpawnPreview = {
        id: `spawn-preview-${this.nextId++}`,
        requester,
        options: { ...options },
        resolve,
        signal,
      };
      request.abortListener = () => this.finish(request, {
        approved: false,
        note: "",
        reason: "aborted",
      });
      if (signal?.aborted) {
        resolve({ approved: false, note: "", reason: "aborted" });
        return;
      }
      signal?.addEventListener("abort", request.abortListener, { once: true });
      this.queue.push(request);
      this.showNext();
      this.emit();
    });
  }

  approve(note: string): boolean {
    const request = this.active;
    if (!request) return false;
    this.finish(request, { approved: true, note: note.trim() });
    return true;
  }

  cancel(reason: SpawnPreviewResult["reason"] = "cancelled"): boolean {
    const request = this.active;
    if (!request) return false;
    this.finish(request, { approved: false, note: "", reason });
    return true;
  }

  cancelRequester(sessionId: string, agentId?: string | null, reason: SpawnPreviewResult["reason"] = "shutdown"): void {
    const matches = (request: PendingSpawnPreview) =>
      request.requester.sessionId === sessionId &&
      (agentId === undefined || request.requester.agentId === agentId);
    for (const request of [this.active, ...this.queue].filter(Boolean) as PendingSpawnPreview[]) {
      if (matches(request)) this.finish(request, { approved: false, note: "", reason });
    }
  }

  cancelAll(reason: SpawnPreviewResult["reason"] = "shutdown"): void {
    for (const request of [this.active, ...this.queue].filter(Boolean) as PendingSpawnPreview[]) {
      this.finish(request, { approved: false, note: "", reason });
    }
  }
}

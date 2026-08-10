import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promptCacheStore } from "./prompt-stash";
import type { PromptCacheOwner, PromptCacheState, StashedPrompt } from "./prompt-cache";

export const MESSAGE_CACHE_TOOLS = [
  "message_cache_list",
  "message_cache_read",
  "message_cache_add",
  "message_cache_delete",
  "message_cache_send",
] as const;

export type MessageCacheRequester =
  | { kind: "main"; id: string; name: "main" }
  | { kind: "subagent"; id: string; name: string };

export type MessageCacheSendRequest = {
  requester: MessageCacheRequester;
  ids: string[];
};

export type MessageCacheSendResult = {
  count: number;
  route: "main" | "subagent";
};

type MessageCacheExecutor = (request: MessageCacheSendRequest) => Promise<MessageCacheSendResult>;
type RequesterFactory = (ctx: ExtensionContext) => MessageCacheRequester;

const IdSchema = Type.String({ minLength: 1, maxLength: 100, description: "Stable cache entry ID" });
const IdsSchema = Type.Array(IdSchema, {
  minItems: 1,
  maxItems: 100,
  description: "Stable cache entry IDs. Order and duplicates are preserved.",
});

function safeDisplayName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean || "agent";
}

function ownerFor(requester: MessageCacheRequester): Extract<PromptCacheOwner, { type: "agent" }> {
  return { type: "agent", id: requester.id, name: safeDisplayName(requester.name) };
}

function ownerText(owner: PromptCacheOwner): string {
  return owner.type === "user" ? "user" : `${owner.name} (${owner.id})`;
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 157)}…`;
}

function listText(entries: readonly StashedPrompt[]): string {
  if (entries.length === 0) return "The message cache is empty.";
  return entries.map((entry) =>
    `${entry.id}  ${entry.executed ? "executed" : "pending"}  ${ownerText(entry.owner)}\n  ${preview(entry.text)}`
  ).join("\n");
}

function readText(entries: readonly StashedPrompt[]): string {
  const text = JSON.stringify(entries, null, 2);
  if (text.length > 48_000) throw new Error("The requested cache content exceeds 48KB. Read fewer IDs.");
  return text;
}

export function messageCacheDetail(result: unknown): string | undefined {
  const details = (result as any)?.details;
  if (!details || typeof details !== "object" || typeof details.action !== "string") return undefined;
  const count = typeof details.count === "number" ? details.count : undefined;
  if (details.action === "send" && count !== undefined) return `${count} sent`;
  if (details.action === "add") return "added";
  if (details.action === "delete") return "deleted";
  if ((details.action === "list" || details.action === "read") && count !== undefined) {
    return `${count} entr${count === 1 ? "y" : "ies"}`;
  }
  return undefined;
}

export class MessageCacheController {
  private executor?: MessageCacheExecutor;
  private readonly listeners = new Set<() => void>();
  private readonly active = new Set<string>();
  private mainSessionId?: string;

  constructor(
    readonly workspaceCwd: string,
    private readonly store = promptCacheStore,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  bindExecutor(sessionId: string, executor: MessageCacheExecutor): () => void {
    this.mainSessionId = sessionId;
    this.executor = executor;
    return () => {
      if (this.executor === executor) this.executor = undefined;
      if (this.mainSessionId === sessionId) {
        this.mainSessionId = undefined;
        this.active.clear();
      }
    };
  }

  releaseRequester(requester: Pick<MessageCacheRequester, "kind" | "id">): void {
    this.active.delete(`${requester.kind}:${requester.id}`);
  }

  list(): StashedPrompt[] {
    return this.store.loadStash(this.workspaceCwd);
  }

  read(ids: readonly string[]): StashedPrompt[] {
    const byId = new Map(this.list().map((entry) => [entry.id, entry]));
    return ids.map((id) => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`Unknown or stale cache entry: ${id}`);
      return entry;
    });
  }

  add(requester: MessageCacheRequester, text: string): StashedPrompt {
    const entry = this.store.addAgentStash(this.workspaceCwd, text, ownerFor(requester));
    this.emit();
    return entry;
  }

  delete(requester: MessageCacheRequester, id: string): void {
    this.store.removeStashById(this.workspaceCwd, id, requester.id);
    this.emit();
  }

  execute(ids: readonly string[]): { entries: StashedPrompt[]; state: PromptCacheState } {
    const result = this.store.executeStashByIds(this.workspaceCwd, ids);
    this.emit();
    return result;
  }

  async send(requester: MessageCacheRequester, ids: string[]): Promise<MessageCacheSendResult> {
    if (!this.executor || !this.mainSessionId) throw new Error("The PUM message-cache execution bridge is unavailable");
    if (requester.kind === "main" && requester.id !== this.mainSessionId) {
      throw new Error("The requesting main session is no longer active");
    }
    this.read(ids);
    const requesterKey = `${requester.kind}:${requester.id}`;
    const targetKey = ids.length > 1 || requester.kind === "main"
      ? `main:${this.mainSessionId}`
      : requesterKey;
    if (this.active.has(requesterKey) || this.active.has(targetKey)) {
      throw new Error("A message-cache send is already active for this requester or target");
    }
    this.active.add(requesterKey);
    this.active.add(targetKey);
    try {
      return await this.executor({ requester, ids: [...ids] });
    } catch (error) {
      this.active.delete(requesterKey);
      this.active.delete(targetKey);
      throw error;
    }
  }

  registerTools(pi: Pick<ExtensionAPI, "registerTool">, requesterFactory: RequesterFactory): void {
    pi.registerTool({
      name: "message_cache_list",
      label: "Message Cache List",
      description: "List message-cache IDs, state, ownership, and concise previews for the current PUM workspace.",
      promptSnippet: "List cached messages with stable IDs and ownership",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, _params, _signal, _update, ctx) => {
        requesterFactory(ctx);
        const entries = this.list();
        return { content: [{ type: "text" as const, text: listText(entries) }], details: { action: "list", count: entries.length } };
      },
    });

    pi.registerTool({
      name: "message_cache_read",
      label: "Message Cache Read",
      description: "Read one or more message-cache entries by stable ID in the supplied order.",
      parameters: Type.Object({ ids: IdsSchema }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params, _signal, _update, ctx) => {
        requesterFactory(ctx);
        const entries = this.read(params.ids);
        return { content: [{ type: "text" as const, text: readText(entries) }], details: { action: "read", count: entries.length, ids: params.ids } };
      },
    });

    pi.registerTool({
      name: "message_cache_add",
      label: "Message Cache Add",
      description: "Add one agent-owned message to the current PUM workspace cache.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 12_000, description: "Message text to cache" }),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params, _signal, _update, ctx) => {
        const entry = this.add(requesterFactory(ctx), params.text);
        return { content: [{ type: "text" as const, text: `Added cache entry ${entry.id}.` }], details: { action: "add", count: 1, id: entry.id } };
      },
    });

    pi.registerTool({
      name: "message_cache_delete",
      label: "Message Cache Delete",
      description: "Delete one cache entry only when the exact requesting agent created it.",
      parameters: Type.Object({ id: IdSchema }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_toolId, params, _signal, _update, ctx) => {
        this.delete(requesterFactory(ctx), params.id);
        return { content: [{ type: "text" as const, text: `Deleted cache entry ${params.id}.` }], details: { action: "delete", count: 1, id: params.id } };
      },
    });

    pi.registerTool({
      name: "message_cache_send",
      label: "Message Cache Send",
      description: "Execute cached messages by stable ID through PUM's authoritative user execution path. This marks entries executed and produces the main-agent coordination path. Order and duplicates are preserved.",
      promptSnippet: "Send one or more cached messages through PUM coordination",
      promptGuidelines: [
        "Use stable IDs from message_cache_list or message_cache_read.",
        "When the user asks to do, run, or execute open or pending cached tasks, call message_cache_send before spawning or assigning work.",
        "Listing entries or reading previews is not execution and does not replace message_cache_send.",
        "After the generated coordination prompt arrives, reuse agents already assigned to those tasks and never create duplicate assignments.",
        "Do not retry a send while the requester or target is still processing a prior cache send.",
      ],
      parameters: Type.Object({ ids: IdsSchema }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params, _signal, _update, ctx) => {
        const result = await this.send(requesterFactory(ctx), params.ids);
        return {
          content: [{ type: "text" as const, text: `Sent ${result.count} cached message${result.count === 1 ? "" : "s"} through ${result.route}.` }],
          details: { action: "send", count: result.count, route: result.route, ids: params.ids },
        };
      },
    });
  }

  extension(requesterFactory: RequesterFactory, name: string): InlineExtension {
    return { name, factory: (pi) => this.registerTools(pi, requesterFactory) };
  }
}

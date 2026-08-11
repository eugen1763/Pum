import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Web search through the Codex subscription.
 *
 * OpenAI's `web_search` is a hosted tool. The model calls it, OpenAI runs it,
 * and the answer comes back already informed by the results.
 */
const HOSTED_SEARCH_PROVIDERS = ["openai-codex"];

/** Session entry type used for searches, which pi does not represent as tools. */
export const WEB_SEARCH_CUSTOM_TYPE = "pum.web_search";

/** Mutable so the Ctrl+P toggle takes effect without rebuilding the provider. */
export const webSearch = { enabled: false };

const searchRoute = new AsyncLocalStorage<string>();
let socketObserverInstalled = false;

function addSearchTool(payload: unknown): unknown | undefined {
  if (!webSearch.enabled || !payload || typeof payload !== "object") return undefined;
  const body = payload as { tools?: unknown[] };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((t) => (t as { type?: string })?.type === "web_search")) return undefined;
  return { ...body, tools: [...tools, { type: "web_search" }] };
}

/** Delegates through the prototype so the provider's other members survive. */
function wrapProvider(base: Provider): Provider {
  const wrapped: Provider = Object.create(base);
  wrapped.stream = ((model: any, context: any, options: any) =>
    base.stream(model, context, { ...options, onPayload: addSearchTool })) as Provider["stream"];
  wrapped.streamSimple = ((model: any, context: any, options: any) =>
    base.streamSimple(model, context, {
      ...options,
      onPayload: addSearchTool,
    })) as Provider["streamSimple"];
  return wrapped;
}

export type SearchCall =
  | { phase: "start"; id: string; query: string }
  | { phase: "end"; id: string; query: string; ok: boolean };

export type SearchCallRecord = {
  id: string;
  query: string;
  state: "running" | "ok" | "error";
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Return only the documented argument for a hosted web-search action. */
export function webSearchArgument(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const action = record.action && typeof record.action === "object"
    ? record.action as Record<string, unknown>
    : record;
  const type = nonEmptyString(action.type);

  if (!type || type === "search") {
    const queries = Array.isArray(action.queries)
      ? action.queries.map(nonEmptyString).filter(Boolean)
      : [];
    if (queries.length > 0) return queries.join(" · ");
    return nonEmptyString(action.query);
  }
  if (type === "open_page") return nonEmptyString(action.url);
  if (type === "find_in_page") {
    const pattern = nonEmptyString(action.pattern);
    const url = nonEmptyString(action.url);
    return pattern && url ? `${pattern} · ${url}` : pattern || url;
  }
  return "";
}

/** Decode output-item events while retaining an argument seen in an earlier frame. */
export class SearchCallTracker {
  private readonly seen = new Map<string, string>();

  accept(event: any): SearchCall | undefined {
    const item = event?.item;
    if (item?.type !== "web_search_call") return undefined;
    const id = nonEmptyString(item.id);
    if (!id) return undefined;
    const argument = webSearchArgument(item) || this.seen.get(id) || "";
    if (argument) this.seen.set(id, argument);

    if (event.type === "response.output_item.added") {
      return { phase: "start", id, query: argument };
    }
    if (event.type === "response.output_item.done") {
      this.seen.delete(id);
      return {
        phase: "end",
        id,
        query: argument,
        ok: item.status !== "failed",
      };
    }
    return undefined;
  }
}

export class SearchCallRouter {
  private readonly listeners = new Map<string, Set<(call: SearchCall) => void>>();

  subscribe(route: string, listener: (call: SearchCall) => void): () => void {
    const listeners = this.listeners.get(route) ?? new Set();
    listeners.add(listener);
    this.listeners.set(route, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(route);
    };
  }

  emit(route: string, call: SearchCall): void {
    for (const listener of this.listeners.get(route) ?? []) listener(call);
  }
}

const searchCalls = new SearchCallRouter();

/** Keep the route active through the asynchronous agent and provider call chain. */
export function withSearchRoute<T>(route: string, operation: () => T): T {
  return searchRoute.run(route, operation);
}

/** Subscribe one transcript to searches from only its own agent session. */
export function observeSearchCalls(
  route: string,
  onCall: (call: SearchCall) => void,
): () => void {
  installSocketObserver();
  return searchCalls.subscribe(route, onCall);
}

/** Persist an out-of-band search as session metadata, not LLM context. */
export function persistSearchCall(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  call: SearchCall,
): void {
  const record: SearchCallRecord = {
    id: call.id,
    query: call.query,
    state: call.phase === "start" ? "running" : call.ok ? "ok" : "error",
  };
  sessionManager.appendCustomEntry(WEB_SEARCH_CUSTOM_TYPE, record);
}

/**
 * pi drops `web_search_call` items. Observe WebSocket frames without changing
 * the cached WebSocket transport. Each socket captures its current session route.
 */
function installSocketObserver(): void {
  if (socketObserverInstalled) return;
  const Original = globalThis.WebSocket;
  if (!Original || (Original as { __pumPatched?: boolean }).__pumPatched) return;
  socketObserverInstalled = true;

  const Patched = new Proxy(Original, {
    construct(target, args: any[]) {
      const route = searchRoute.getStore();
      const socket = new (target as any)(...args);
      const tracker = new SearchCallTracker();
      socket.addEventListener?.("message", (ev: any) => {
        try {
          const raw = ev?.data;
          if (!route || typeof raw !== "string" || !raw.includes("web_search_call")) return;
          const event = JSON.parse(raw);
          const call = tracker.accept(event);
          if (call) searchCalls.emit(route, call);
        } catch {
          // Search observation must never break an agent turn.
        }
      });
      return socket;
    },
  });
  (Patched as unknown as { __pumPatched: boolean }).__pumPatched = true;
  globalThis.WebSocket = Patched as typeof WebSocket;
}

/** Returns the provider ids that now carry the hosted search tool. */
export function installWebSearch(runtime: ModelRuntime): string[] {
  const installed: string[] = [];
  for (const id of HOSTED_SEARCH_PROVIDERS) {
    const base = runtime.getProvider(id);
    if (!base) continue;
    runtime.registerNativeProvider(wrapProvider(base));
    installed.push(id);
  }
  return installed;
}

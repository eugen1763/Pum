import type { Provider } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import { beginRequestDiagnostic, clearRequestDiagnostics, requestDiagnosticsEnabled, resetRequestDiagnostics } from "./request-diagnostics";
import { OperationalContextProjection } from "./operational-context";
import { CONTEXT_WINDOW_CUSTOM_TYPE } from "./context-window";

/**
 * Web search through the Codex subscription.
 *
 * OpenAI's `web_search` is a hosted tool. The model calls it, OpenAI runs it,
 * and the answer comes back already informed by the results.
 */
const HOSTED_SEARCH_PROVIDERS = ["openai-codex"];

/** Session entry type used for searches, which pi does not represent as tools. */
export const WEB_SEARCH_CUSTOM_TYPE = "pum.web_search";

/** A disable invalidates already prepared requests, even if subsequently re-enabled. */
let searchEnabled = false;
let searchDisableEpoch = 0;
// Only exact bound requests that emitted a search-bearing payload enter this set.
// Revocation aborts SDK handshake waits, retry sleeps, and SSE fetches as well.
const pendingSearchRequests = new Set<AbortController>();
export const webSearch = {
  get enabled(): boolean { return searchEnabled; },
  set enabled(value: boolean) {
    if (searchEnabled && !value) {
      searchDisableEpoch++;
      searchEnabled = false;
      for (const controller of pendingSearchRequests) controller.abort();
      pendingSearchRequests.clear();
    }
    searchEnabled = value;
  },
};
export const SEARCH_STATE_CUSTOM_TYPE = "pum.search_state";

const searchRoute = new AsyncLocalStorage<string>();
let socketObserverInstalled = false;

/** The provider payload hook shape (pi's `ProviderRequestOptions.onPayload`). */
type PayloadHook = (
  payload: unknown,
  model: unknown,
) => unknown | undefined | Promise<unknown | undefined>;

export type SearchSessionRole = "main" | "worker" | "readonly" | "judge" | "afk";
type SearchSnapshot = Readonly<{ enabled: boolean; disableEpoch: number }>;
type SearchAuthority = Readonly<{
  sessionId: string; role: SearchSessionRole | undefined; search: SearchSnapshot; isLive: () => boolean;
  transport: { signal: AbortSignal; arm: () => void; finished: () => boolean };
}>;

// A hook's presence, sessionId option, or ambient observation route grants nothing.
// Only the session stream boundary can create a request-bound capability.
const requestAuthorities = new WeakMap<PayloadHook, SearchAuthority>();
const diagnosticObservers = new WeakMap<PayloadHook, (payload: unknown) => void>();
const finalPayloadHooks = new WeakSet<PayloadHook>();

/** Bind once during trusted session setup, including resumed/replaced sessions. */
export function bindSearchSession(
  session: Pick<AgentSession, "sessionId" | "agent"> & Partial<Pick<AgentSession, "sessionManager">>,
  role: SearchSessionRole | undefined,
): void {
  const sessionId = session.sessionId;
  const allowedRole = role === "main" || role === "worker";
  let live = true;
  const activeRequests = new Set<AbortController>();
  const isLive = () => live;
  const projection = new OperationalContextProjection(SEARCH_STATE_CUSTOM_TYPE);
  // Binding alone is not a request boundary. Direct stream calls without a
  // successful context transform stay denied, including custom integrations.
  let search: SearchSnapshot = Object.freeze({ enabled: false, disableEpoch: searchDisableEpoch });
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    search = Object.freeze({ enabled: false, disableEpoch: searchDisableEpoch });
    const transformed = transform ? await transform.call(session.agent, messages, signal) : messages;
    // Capture after the entire inner async context chain, before conversion,
    // authentication, diagnostics and payload hooks can yield again.
    const prepared = Object.freeze({ enabled: live && allowedRole && webSearch.enabled && !signal?.aborted,
      disableEpoch: searchDisableEpoch });
    const manager = session.sessionManager;
    const boundary = manager?.getBranch().findLast((entry) =>
      entry.type === "custom" && entry.customType === CONTEXT_WINDOW_CUSTOM_TYPE);
    const scope = JSON.stringify([sessionId, manager?.getCwd() ?? "", boundary?.id ?? null]);
    const observation = !allowedRole
      ? "Hosted web search is unavailable for this runtime role."
      : prepared.enabled
        ? "Hosted web search is enabled for this request where supported by the selected provider."
        : "Hosted web search is disabled for this request. Do not use hosted web search.";
    const projected = projection.project(transformed, observation, scope);
    // A malformed/incomplete tool block can defer the notice. Never grant a
    // relaxation unless the matching observation was actually projected.
    const observed = projected.findLast((message) => message.role === "custom"
      && message.customType === SEARCH_STATE_CUSTOM_TYPE);
    search = Object.freeze({ ...prepared, enabled: prepared.enabled
      && observed?.role === "custom" && typeof observed.content === "string"
      && observed.content.endsWith(observation) });
    return projected;
  };
  resetRequestDiagnostics(sessionId);
  const disposable = session as typeof session & Partial<Pick<AgentSession, "dispose">>;
  const dispose = disposable.dispose;
  if (dispose) disposable.dispose = function () {
    live = false;
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
    try { return dispose.call(session); }
    finally {
      search = Object.freeze({ enabled: false, disableEpoch: searchDisableEpoch });
      projection.reset();
      clearRequestDiagnostics(sessionId);
    }
  };
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    // Freeze this request's context-bound decision before diagnostics can await.
    const controller = new AbortController();
    let finished = false;
    activeRequests.add(controller);
    const parentSignal = options?.signal;
    const abort = () => controller.abort();
    const cleanup = () => {
      pendingSearchRequests.delete(controller);
      activeRequests.delete(controller);
      parentSignal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cleanup);
    };
    controller.signal.addEventListener("abort", cleanup, { once: true });
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted || !live) controller.abort();
    const authority: SearchAuthority = Object.freeze({ sessionId, role, search, isLive,
      transport: { signal: controller.signal, finished: () => finished, arm: () => {
        if (!controller.signal.aborted && activeRequests.has(controller)) pendingSearchRequests.add(controller);
      } },
    });
    const run = (diagnostic?: Awaited<ReturnType<typeof beginRequestDiagnostic>>) => {
      const base = options?.onPayload;
      const hook: PayloadHook = async (payload, model) => {
        const result = await base?.(payload, model as any);
        // Wrapped providers observe after search policy, never before it. Other
        // providers observe the extension's effective serialized payload here.
        if (diagnostic && !finalPayloadHooks.has(hook)) diagnostic.payload(result === undefined ? payload : result);
        return result;
      };
      requestAuthorities.set(hook, authority);
      if (diagnostic) diagnosticObservers.set(hook, diagnostic.payload);
      const observe = (result: Awaited<ReturnType<typeof stream>>) => {
        // The SDK stream's result promise settles on done/error/abort, whether
        // or not a consumer drains its events. Keep retries under one controller.
        if (typeof result?.result === "function") void result.result().then((message) => {
          finished = true; cleanup(); diagnostic?.finish(message);
        }, () => { finished = true; cleanup(); diagnostic?.finish(); });
        return result;
      };
      try {
        const result = withSearchRoute(authority.sessionId, () => stream(model, context, {
          ...options, signal: controller.signal, onPayload: hook,
        }));
        return result instanceof Promise ? result.then(observe, (error) => { finished = true; cleanup(); diagnostic?.finish(); throw error; }) : observe(result);
      } catch (error) { finished = true; cleanup(); diagnostic?.finish(); throw error; }
    };
    return requestDiagnosticsEnabled()
      ? beginRequestDiagnostic(authority.sessionId, role, options?.transport, model.api).then(run, (error) => { cleanup(); throw error; })
      : run();
  };
}

function searchAuthorized(base: PayloadHook | undefined, sessionId: unknown): SearchAuthority | undefined {
  const authority = base && requestAuthorities.get(base);
  return authority && authority.sessionId && authority.sessionId === sessionId
    && (authority.role === "main" || authority.role === "worker") ? authority : undefined;
}

function addSearchTool(payload: unknown, authority: SearchAuthority | undefined): unknown | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as { tools?: unknown[] };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const isSearch = (tool: unknown) => (tool as { type?: string })?.type === "web_search";
  if (!authority?.isLive() || authority.transport.finished() || authority.transport.signal.aborted || !authority.search.enabled || !webSearch.enabled
    || authority.search.disableEpoch !== searchDisableEpoch) {
    // An extension transform cannot reintroduce a denied hosted tool.
    return tools.some(isSearch) ? { ...body, tools: tools.filter((tool) => !isSearch(tool)) } : undefined;
  }
  authority.transport.arm();
  const guardedTools = tools.some(isSearch) ? [...tools] : [...tools, { type: "web_search" }];
  const originalToJSON = (body as { toJSON?: unknown }).toJSON;
  // pi 0.85 removes the handshake abort listener on open, then awaits socket
  // acquisition before send without checking the signal again. Its cached path
  // has the same gap. An enumerable, request-owned method survives SDK shallow
  // body copies, but JSON omits the function. Only the actual response.create
  // envelope triggers the fence, inside the SDK socket-release try/finally.
  // Throwing from tools.toJSON instead would also hit cached-body comparisons
  // *before* that try/finally and could strand a busy cached socket.
  // SSE serializes earlier but checks/uses the composed signal on every fetch.
  // No socket observer or ambient route grants transport authority.
  let normalizing = false;
  const assertLive = () => {
    if (authority.transport.finished() || authority.transport.signal.aborted
      || !authority.isLive() || !webSearch.enabled || authority.search.disableEpoch !== searchDisableEpoch) {
      throw new Error("Request was aborted");
    }
  };
  return { ...body, tools: guardedTools, toJSON(this: { type?: unknown }, key: string) {
    const envelope = !normalizing && this.type === "response.create";
    if (envelope) assertLive();
    const value = typeof originalToJSON === "function" ? originalToJSON.call(this, key) : this;
    if (!envelope) return value;
    // Finish *all* user serialization before the final revocation check. A
    // holder's toJSON returns the already-converted root: stringify traverses
    // it without invoking that root's toJSON a second time (even if the original
    // returned this, a replacement object, or a primitive). Nested serializers
    // and getters still run with native keys/order/cycle handling. Re-encounters
    // of this wrapper during traversal delegate ordinarily, not recursively
    // normalize. Parsing yields only inert JSON data, so the SDK's remaining
    // stringify traversal cannot run an extension after the final check.
    normalizing = true;
    let normalized: unknown;
    try {
      const json = JSON.stringify({ toJSON: () => value });
      // Bun supports source-aware JSON parsing/rawJSON; the installed TS lib
      // predates their types. Keep this local, without changing global methods.
      const rawJSON = (JSON as typeof JSON & { rawJSON(source: string): unknown }).rawJSON;
      normalized = json === undefined ? undefined : JSON.parse(json,
        (_key: string, value: unknown, context?: { source?: string }) =>
          // Preserve raw primitive spellings, including integers beyond Number
          // precision. These JSON records have no executable callbacks.
          context?.source === undefined ? value : rawJSON(context.source));
    } finally { normalizing = false; }
    assertLive();
    return normalized;
  } };
}

/** Chain the extension transform, then enforce the request-bound authorization. */
export function chainSearchTool(base: PayloadHook | undefined, sessionId?: unknown): PayloadHook {
  const authorized = searchAuthorized(base, sessionId);
  if (base) finalPayloadHooks.add(base);
  const observe = base && diagnosticObservers.get(base);
  return async (payload, model) => {
    const baseResult = await base?.(payload, model);
    // `undefined` from a hook means "leave the payload unchanged".
    const effective = baseResult === undefined ? payload : baseResult;
    const withTool = addSearchTool(effective, authorized);
    observe?.(withTool === undefined ? effective : withTool);
    return withTool === undefined ? baseResult : withTool;
  };
}

/** Delegates through the prototype so the provider's other members survive. */
export function wrapProvider(base: Provider): Provider {
  const wrapped: Provider = Object.create(base);
  wrapped.stream = ((model: any, context: any, options: any) =>
    base.stream(model, context, {
      ...options,
      onPayload: chainSearchTool(options?.onPayload, options?.sessionId),
    })) as Provider["stream"];
  wrapped.streamSimple = ((model: any, context: any, options: any) =>
    base.streamSimple(model, context, {
      ...options,
      onPayload: chainSearchTool(options?.onPayload, options?.sessionId),
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

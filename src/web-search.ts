import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Web search through the Codex subscription.
 *
 * OpenAI's `web_search` is a hosted tool: the model calls it, OpenAI runs it
 * server-side, and the answer comes back already informed by the results. The
 * client only has to name the tool in the request.
 *
 * pi has no notion of provider-native tools, so this wraps the provider and
 * uses the documented `onPayload` hook to append the tool to the outgoing body.
 * Two consequences worth knowing:
 *
 *  - pi ignores the `web_search_call` items that come back, so the transcript
 *    shows no search step — only a better-informed answer.
 *  - It only applies to Codex models. Switch provider and it does nothing.
 */
const HOSTED_SEARCH_PROVIDERS = ["openai-codex"];

/** Mutable so the Ctrl+P toggle takes effect without rebuilding the provider. */
export const webSearch = { enabled: false };

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

/**
 * pi drops the `web_search_call` items OpenAI sends back, so the only way to
 * show the search in the transcript is to watch the wire.
 *
 * Codex talks over a WebSocket by default and only consults a custom `fetch`
 * on its HTTP path, so there is nothing to intercept at the fetch layer.
 * Forcing `transport: "sse"` would work but costs the `previous_response_id`
 * continuation, which is what keeps whole-conversation resends off every turn.
 * So instead we wrap the global WebSocket constructor and read frames as they
 * arrive. Purely observational — the adapter's own listener is untouched.
 */
export function observeSearchCalls(onCall: (call: SearchCall) => void): void {
  const Original = globalThis.WebSocket;
  if (!Original || (Original as { __pumPatched?: boolean }).__pumPatched) return;

  const seen = new Map<string, string>();

  const handle = (raw: unknown) => {
    // Every streamed token is a frame; skip the parse unless it could match.
    if (typeof raw !== "string" || !raw.includes("web_search_call")) return;
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const item = event?.item;
    if (item?.type !== "web_search_call") return;
    const id = String(item.id ?? "");
    const query = String(item.action?.query ?? seen.get(id) ?? "");
    if (query) seen.set(id, query);

    if (event.type === "response.output_item.added") {
      onCall({ phase: "start", id, query });
    } else if (event.type === "response.output_item.done") {
      onCall({ phase: "end", id, query, ok: item.status !== "failed" });
      seen.delete(id);
    }
  };

  const Patched = new Proxy(Original, {
    construct(target, args: any[]) {
      const socket = new (target as any)(...args);
      socket.addEventListener?.("message", (ev: any) => {
        try {
          handle(ev?.data);
        } catch {
          // never let logging break a turn
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

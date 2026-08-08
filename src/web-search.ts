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

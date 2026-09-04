import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const ASTRA_ID = "gpt-6-astra";

/** Temporary catalog fallback until pi includes Astra. Never replace upstream metadata. */
export function withAstraModel(base: Provider): Provider {
  if (base.id !== "openai" && base.id !== "openai-codex") return base;
  if (base.getModels().some((model) => model.id === ASTRA_ID)) return base;
  const codex = base.id === "openai-codex";
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  const astra: Model<any> = {
    id: ASTRA_ID,
    name: "GPT-6 Astra",
    provider: base.id,
    api: codex ? "openai-codex-responses" : "openai-responses",
    baseUrl: base.baseUrl ?? (codex ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1"),
    reasoning: true,
    input: ["text", "image"],
    // Keep pi's conservative Codex context budget until that transport publishes one.
    contextWindow: codex ? 272000 : 1050000,
    maxTokens: 128000,
    cost: {
      input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    },
    thinkingLevelMap: {
      off: null, minimal: null, low: "low", medium: "medium",
      high: "high", xhigh: "xhigh", max: "max",
    },
  };
  const wrapped: Provider = Object.create(base);
  wrapped.getModels = () => {
    const models = base.getModels();
    return models.some((model) => model.id === ASTRA_ID) ? models : [...models, astra];
  };
  return wrapped;
}

export function installModelCatalogFallbacks(runtime: ModelRuntime): void {
  for (const id of ["openai", "openai-codex"]) {
    const base = runtime.getProvider(id);
    if (!base) continue;
    const provider = withAstraModel(base);
    if (provider !== base) runtime.registerNativeProvider(provider);
  }
}

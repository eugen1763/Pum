import type { AuthType, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MODELS_PATH } from "./config";

export type LoginMethod = {
  providerId: string;
  providerName: string;
  authType: AuthType;
  methodName: string;
  loginLabel?: string;
  canLogin: boolean;
};

export function providerLoginMethods(providers: readonly Provider[]): LoginMethod[] {
  return providers.flatMap((provider) => {
    const methods: LoginMethod[] = [];
    if (provider.auth.oauth) {
      methods.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: "oauth",
        methodName: provider.auth.oauth.name,
        loginLabel: provider.auth.oauth.loginLabel,
        canLogin: true,
      });
    }
    if (provider.auth.apiKey) {
      methods.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: "api_key",
        methodName: provider.auth.apiKey.name,
        canLogin: typeof provider.auth.apiKey.login === "function",
      });
    }
    return methods;
  }).sort((a, b) =>
    a.providerName.localeCompare(b.providerName) || a.authType.localeCompare(b.authType),
  );
}

export function safeError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  message = message.replace(/\b(?:sk|key|token)-[A-Za-z0-9_.-]{8,}\b/gi, "[redacted]");
  return message;
}

export function normalizeOpenAIEndpoint(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Enter an endpoint URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a complete http:// or https:// endpoint URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The endpoint must use http:// or https://.");
  }
  if (url.username || url.password) throw new Error("Remove credentials from the endpoint URL.");
  if (url.search || url.hash) throw new Error("Remove the query string and fragment from the endpoint URL.");
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(?:models|chat\/completions|responses)$/i, "");
  if (!/\/v\d+(?:beta)?$/i.test(pathname)) pathname += "/v1";
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

export type DiscoveredModel = { id: string; name?: string };

export async function discoverOpenAIModels(
  endpoint: string,
  apiKey: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ baseUrl: string; models: DiscoveredModel[] }> {
  const baseUrl = normalizeOpenAIEndpoint(endpoint);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Model discovery failed with HTTP ${response.status}. Check the endpoint and API key.`);
  }
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error("The endpoint did not return an OpenAI-compatible model list at /models.");
  }
  const models = body.data.flatMap((entry): DiscoveredModel[] => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) return [];
    const name = (entry as { name?: unknown }).name;
    return [{ id: id.trim(), ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) }];
  });
  if (models.length === 0) throw new Error("The OpenAI-compatible model list was empty.");
  return { baseUrl, models };
}

export function customProviderId(baseUrl: string): string {
  const host = new URL(baseUrl).host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `custom-${host || "provider"}`;
}

type ModelsFile = { providers?: Record<string, unknown>; [key: string]: unknown };

export async function persistCustomProvider(
  providerId: string,
  baseUrl: string,
  models: readonly DiscoveredModel[],
  path = MODELS_PATH,
): Promise<void> {
  let current: ModelsFile = {};
  try {
    current = JSON.parse(await readFile(path, "utf8")) as ModelsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existingProvider = (current.providers ?? {})[providerId] as
    | { models?: Array<Record<string, unknown>> }
    | undefined;
  const existingById = new Map(
    (existingProvider?.models ?? []).map((model) => [String(model.id), model]),
  );
  const resolvedModels = models.map((model) => {
    const existing = existingById.get(model.id.trim());
    if (existing) {
      // Keep hand-tuned per-model settings (reasoning, compat, thinkingLevelMap,
      // contextWindow, maxTokens) when re-logging into the same provider.
      return {
        ...existing,
        id: model.id,
        name: model.name ?? (typeof existing.name === "string" ? existing.name : model.id),
      };
    }
    return {
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
    };
  });
  const next: ModelsFile = {
    ...current,
    providers: {
      ...(current.providers ?? {}),
      [providerId]: {
        name: `Custom (${new URL(baseUrl).host})`,
        baseUrl,
        api: "openai-completions",
        authHeader: true,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: resolvedModels,
      },
    },
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function refreshAndSelectModel(
  runtime: ModelRuntime,
  providerId: string,
  setModel: (model: Model<any>) => Promise<void>,
  signal?: AbortSignal,
  currentModel?: Model<any>,
): Promise<Model<any> | undefined> {
  await runtime.refresh({ providers: [providerId], allowNetwork: true, signal });
  const available = runtime.getAvailableSnapshot();
  const current = currentModel && available.find((candidate) =>
    candidate.provider === currentModel.provider && candidate.id === currentModel.id,
  );
  if (current) return current;
  const model = available.find((candidate) => candidate.provider === providerId) ?? available[0];
  if (model) await setModel(model);
  return model;
}

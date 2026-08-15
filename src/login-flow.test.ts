import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOpenAIModels,
  normalizeOpenAIEndpoint,
  persistCustomProvider,
  providerLoginMethods,
  safeError,
} from "./login-flow";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pum-models-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("provider registry coverage", () => {
  test("includes every auth method exposed by providers", () => {
    const providers = [
      { id: "both", name: "Both", auth: {
        oauth: { name: "Account", loginLabel: "Browser", login() {}, refresh() {}, toAuth() {} },
        apiKey: { name: "API key", login() {}, resolve() {} },
      } },
      { id: "ambient", name: "Ambient", auth: { apiKey: { name: "AWS profile", resolve() {} } } },
    ] as any;
    const methods = providerLoginMethods(providers);
    expect(methods.map((method) => `${method.providerId}:${method.authType}`)).toEqual([
      "ambient:api_key", "both:api_key", "both:oauth",
    ]);
    expect(methods.find((method) => method.providerId === "ambient")?.canLogin).toBe(false);
  });
});

describe("custom OpenAI-compatible provider", () => {
  test("normalizes documented endpoint variants", () => {
    expect(normalizeOpenAIEndpoint("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeOpenAIEndpoint("https://host.test/v1/models")).toBe("https://host.test/v1");
    expect(() => normalizeOpenAIEndpoint("file:///tmp/models")).toThrow("http:// or https://");
    expect(() => normalizeOpenAIEndpoint("https://key@host.test/v1")).toThrow("Remove credentials");
  });

  test("discovers models without returning or exposing the submitted key", async () => {
    let request: Request | undefined;
    const result = await discoverOpenAIModels("https://host.test", "top-secret", {
      fetch: (async (input, init) => {
        request = new Request(input, init);
        return Response.json({ data: [{ id: "model-a", name: "Model A" }, { nope: true }] });
      }) as typeof fetch,
    });
    expect(result).toEqual({ baseUrl: "https://host.test/v1", models: [{ id: "model-a", name: "Model A" }] });
    expect(request?.headers.get("authorization")).toBe("Bearer top-secret");
    expect(JSON.stringify(result)).not.toContain("top-secret");
  });

  test("preserves other providers and writes no key", async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, "models.json");
    await Bun.write(path, JSON.stringify({ providers: { existing: { baseUrl: "https://old.test" } } }));
    await persistCustomProvider("custom-host", "https://host.test/v1", [{ id: "model-a" }], path);
    const text = await readFile(path, "utf8");
    const data = JSON.parse(text);
    expect(data.providers.existing.baseUrl).toBe("https://old.test");
    expect(data.providers["custom-host"].api).toBe("openai-completions");
    expect(text).not.toContain("top-secret");
  });

  test("preserves hand-tuned model settings on re-login", async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, "models.json");
    await Bun.write(path, JSON.stringify({
      providers: {
        "custom-host": {
          baseUrl: "https://host.test/v1",
          models: [{
            id: "ds4-ops",
            name: "ds4-ops",
            reasoning: true,
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              thinkingFormat: "chat-template",
              chatTemplateKwargs: {
                thinking: { $var: "thinking.enabled" },
                reasoning_effort: { $var: "thinking.effort" },
              },
            },
            thinkingLevelMap: { low: null, max: "max" },
            contextWindow: 128000,
            maxTokens: 16384,
          }],
        },
      },
    }));
    await persistCustomProvider("custom-host", "https://host.test/v1", [
      { id: "ds4-ops" },
      { id: "new-model" },
    ], path);
    const data = JSON.parse(await readFile(path, "utf8"));
    const kept = data.providers["custom-host"].models.find((m: any) => m.id === "ds4-ops");
    expect(kept.reasoning).toBe(true);
    expect(kept.compat.thinkingFormat).toBe("chat-template");
    expect(kept.compat.chatTemplateKwargs.reasoning_effort).toEqual({ $var: "thinking.effort" });
    expect(kept.thinkingLevelMap.max).toBe("max");
    expect(kept.contextWindow).toBe(128000);
    expect(kept.maxTokens).toBe(16384);
    const fresh = data.providers["custom-host"].models.find((m: any) => m.id === "new-model");
    expect(fresh.reasoning).toBe(false);
  });
});

test("secret redaction removes exact and token-shaped values", () => {
  expect(safeError(new Error("bad top-secret sk-token-123456789"), ["top-secret"]))
    .toBe("bad [redacted] [redacted]");
});

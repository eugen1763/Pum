import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOpenAIModels,
  normalizeOpenAIEndpoint,
  persistCustomProvider,
  providerLoginMethods,
  safeError,
} from "./login-flow";

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
    const dir = await mkdtemp(join(tmpdir(), "pum-models-"));
    const path = join(dir, "models.json");
    await Bun.write(path, JSON.stringify({ providers: { existing: { baseUrl: "https://old.test" } } }));
    await persistCustomProvider("custom-host", "https://host.test/v1", [{ id: "model-a" }], path);
    const text = await readFile(path, "utf8");
    const data = JSON.parse(text);
    expect(data.providers.existing.baseUrl).toBe("https://old.test");
    expect(data.providers["custom-host"].api).toBe("openai-completions");
    expect(text).not.toContain("top-secret");
  });
});

test("secret redaction removes exact and token-shaped values", () => {
  expect(safeError(new Error("bad top-secret sk-token-123456789"), ["top-secret"]))
    .toBe("bad [redacted] [redacted]");
});

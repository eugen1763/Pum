import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProvider,
  modelAfterRemoval,
  providerEntries,
  readCustomProviderIds,
  removeCustomProvider,
} from "../src/providers-flow";
import type { ProviderEntry } from "../src/providers-command";

const directories: string[] = [];

async function modelsFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pum-providers-"));
  directories.push(directory);
  const path = join(directory, "models.json");
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

const twoProviders = {
  defaultModel: "openai/gpt-5",
  providers: {
    "custom-a": { name: "Custom (a)", baseUrl: "https://a/v1", models: [{ id: "one" }] },
    "custom-b": { name: "Custom (b)", baseUrl: "https://b/v1", models: [{ id: "two" }] },
  },
};

describe("removeCustomProvider", () => {
  test("removes the named provider and keeps the others", async () => {
    const path = await modelsFile(twoProviders);

    const removed = await removeCustomProvider("custom-a", path);

    expect(removed).toBe(true);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(written.providers)).toEqual(["custom-b"]);
  });

  test("keeps unrelated top-level settings", async () => {
    const path = await modelsFile(twoProviders);

    await removeCustomProvider("custom-a", path);

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.defaultModel).toBe("openai/gpt-5");
  });

  test("changes nothing when the provider is absent", async () => {
    const path = await modelsFile(twoProviders);
    const before = await readFile(path, "utf8");

    const removed = await removeCustomProvider("custom-missing", path);

    expect(removed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("does not create a file that is not there", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pum-providers-"));
    directories.push(directory);
    const path = join(directory, "models.json");

    const removed = await removeCustomProvider("custom-a", path);

    expect(removed).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  // Windows has no POSIX permission bits, so the mode a write asks for is not
  // the mode the file comes back with. The guarantee only exists on POSIX.
  test.skipIf(process.platform === "win32")("keeps the file readable by its owner only", async () => {
    const path = await modelsFile(twoProviders);

    await removeCustomProvider("custom-a", path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("leaves no temporary file behind", async () => {
    const path = await modelsFile(twoProviders);

    await removeCustomProvider("custom-a", path);

    const directory = join(path, "..");
    expect(await readdir(directory)).toEqual(["models.json"]);
  });
});

describe("readCustomProviderIds", () => {
  test("lists the providers defined in models.json", async () => {
    const path = await modelsFile(twoProviders);

    expect([...await readCustomProviderIds(path)].sort()).toEqual(["custom-a", "custom-b"]);
  });

  test("returns nothing when the file is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pum-providers-"));
    directories.push(directory);

    expect([...await readCustomProviderIds(join(directory, "models.json"))]).toEqual([]);
  });
});

describe("providerEntries", () => {
  const providers = [
    { id: "openai", name: "OpenAI" },
    { id: "anthropic", name: "Anthropic" },
    { id: "custom-a", name: "Custom (a)" },
  ];

  test("sorts providers by name", () => {
    const entries = providerEntries(providers, {
      configured: () => false,
      custom: new Set<string>(),
    });

    expect(entries.map((entry) => entry.id)).toEqual(["anthropic", "custom-a", "openai"]);
  });

  test("marks a provider defined in models.json as custom", () => {
    const entries = providerEntries(providers, {
      configured: () => false,
      custom: new Set(["custom-a"]),
    });

    expect(entries.find((entry) => entry.id === "custom-a")?.kind).toBe("custom");
    expect(entries.find((entry) => entry.id === "openai")?.kind).toBe("builtin");
  });

  test("reports which providers hold a credential", () => {
    const entries = providerEntries(providers, {
      configured: (id) => id === "openai",
      custom: new Set<string>(),
    });

    expect(entries.find((entry) => entry.id === "openai")?.configured).toBe(true);
    expect(entries.find((entry) => entry.id === "anthropic")?.configured).toBe(false);
  });
});

/** A stand-in runtime that keeps its credentials and registrations in memory. */
function fakeRuntime(configured: string[]) {
  const credentials = new Set(configured);
  const registered = new Set(configured);
  return {
    credentials,
    registered,
    async logout(providerId: string) {
      credentials.delete(providerId);
    },
    unregisterProvider(providerId: string) {
      registered.delete(providerId);
    },
  };
}

describe("deleteProvider", () => {
  const builtin: ProviderEntry = {
    id: "openai",
    name: "OpenAI",
    kind: "builtin",
    configured: true,
  };
  const custom: ProviderEntry = {
    id: "custom-a",
    name: "Custom (a)",
    kind: "custom",
    configured: true,
  };

  test("drops the credential of a built-in provider", async () => {
    const runtime = fakeRuntime(["openai"]);
    const path = await modelsFile(twoProviders);

    await deleteProvider(runtime, builtin, path);

    expect(runtime.credentials.has("openai")).toBe(false);
  });

  test("keeps a built-in provider registered so it can be added again", async () => {
    const runtime = fakeRuntime(["openai"]);
    const path = await modelsFile(twoProviders);

    await deleteProvider(runtime, builtin, path);

    expect(runtime.registered.has("openai")).toBe(true);
  });

  test("leaves models.json alone for a built-in provider", async () => {
    const runtime = fakeRuntime(["openai"]);
    const path = await modelsFile(twoProviders);
    const before = await readFile(path, "utf8");

    await deleteProvider(runtime, builtin, path);

    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("removes a custom provider from models.json as well", async () => {
    const runtime = fakeRuntime(["custom-a"]);
    const path = await modelsFile(twoProviders);

    await deleteProvider(runtime, custom, path);

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(written.providers)).toEqual(["custom-b"]);
  });

  test("unregisters a custom provider from the runtime", async () => {
    const runtime = fakeRuntime(["custom-a"]);
    const path = await modelsFile(twoProviders);

    await deleteProvider(runtime, custom, path);

    expect(runtime.registered.has("custom-a")).toBe(false);
    expect(runtime.credentials.has("custom-a")).toBe(false);
  });
});

describe("modelAfterRemoval", () => {
  const models = [
    { id: "gpt-5", provider: "openai" },
    { id: "sonnet", provider: "anthropic" },
  ];

  test("keeps the active model when another provider was removed", () => {
    expect(modelAfterRemoval(models[0]!, models, "anthropic")).toBeUndefined();
  });

  test("moves to another provider when the active one was removed", () => {
    expect(modelAfterRemoval(models[0]!, models, "openai")).toEqual(models[1]!);
  });

  test("gives up when nothing else is available", () => {
    expect(modelAfterRemoval(models[0]!, [models[0]!], "openai")).toBeUndefined();
  });

  test("does nothing when no model is active", () => {
    expect(modelAfterRemoval(undefined, models, "openai")).toBeUndefined();
  });
});

import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installModelCatalogFallbacks, withAstraModel } from "../src/model-catalog";
import { filterModels } from "../src/settings-popup";
import { installWebSearch } from "../src/web-search";

test("Astra survives refresh and web-search wrapping and is searchable in the picker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pum-astra-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"), modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false,
    });
    const original = runtime.getProvider("openai-codex")!;
    const wrapped = withAstraModel(original);
    expect(wrapped.auth).toBe(original.auth);
    expect(wrapped.streamSimple).toBe(original.streamSimple);
    installModelCatalogFallbacks(runtime);
    installModelCatalogFallbacks(runtime);
    installWebSearch(runtime);
    await runtime.refresh({ allowNetwork: false });
    for (const provider of ["openai", "openai-codex"]) {
      const models = filterModels(runtime.getModels(provider), "gpt-6");
      expect(models).toHaveLength(1);
      expect(models[0]!.id).toBe("gpt-6-astra");
      expect(models[0]!.thinkingLevelMap?.max).toBe("max");
      expect(withAstraModel(runtime.getProvider(provider)!)).toBe(runtime.getProvider(provider)!);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

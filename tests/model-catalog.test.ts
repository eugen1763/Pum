import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterModels } from "../src/settings-popup";
import { installWebSearch } from "../src/web-search";

test("installed pi lists GPT-6 models for OpenAI and Codex through web-search wrapping and the picker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pum-gpt-6-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"), modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false,
    });
    installWebSearch(runtime);
    await runtime.refresh({ allowNetwork: false });
    for (const provider of ["openai", "openai-codex"]) {
      const ids = filterModels(runtime.getModels(provider), "gpt-6").map((model) => model.id);
      expect(ids).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

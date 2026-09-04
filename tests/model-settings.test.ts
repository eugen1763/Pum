import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { saveMainModelDefaults } from "../src/model-settings";

test("promotion reports pi settings write failures", async () => {
  let failWrites = false;
  const settingsManager = SettingsManager.fromStorage({
    withLock(_scope, update) {
      if (failWrites) throw new Error("settings storage unavailable");
      update(undefined);
    },
  });
  failWrites = true;
  await expect(saveMainModelDefaults({
    agent: { state: { model: { provider: "mock", id: "chosen" }, thinkingLevel: "low" } },
    settingsManager,
  } as any)).rejects.toThrow("settings storage unavailable");
});

test("real pi defaults survive fresh startup, while automatic and child selections remain session-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "pum-model-defaults-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test",
    models: ["old", "chosen", "fallback"].map((id) => ({ id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "old", defaultThinkingLevel: "high" }));
  const sessions: any[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const open = async () => {
      const services = await createAgentSessionServices({ cwd: root, agentDir, modelRuntime: runtime });
      const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(root, join(root, "sessions")), tools: [] });
      sessions.push(session);
      return session;
    };
    const main = await open();
    expect(main.model?.id).toBe("old");
    await main.setModel(runtime.getModel("mock", "chosen")!, { persist: true });
    main.setThinkingLevel("low", { persist: true });
    await main.settingsManager.flush();
    const next = await open();
    expect(next.model?.id).toBe("chosen");
    expect(next.thinkingLevel).toBe("low");
    // Child setup and login/provider fallback must not replace the main defaults.
    await next.setModel(runtime.getModel("mock", "fallback")!);
    next.setThinkingLevel("high");
    await next.settingsManager.flush();
    const unchanged = await open();
    expect(unchanged.model?.id).toBe("chosen");
    expect(unchanged.thinkingLevel).toBe("low");
    // /s also promotes values restored from a session, without a model switch.
    await saveMainModelDefaults(next);
    expect(next.model?.id).toBe("fallback");
    expect(next.thinkingLevel).toBe("high");
    const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    expect(saved).toMatchObject({ defaultProvider: "mock", defaultModel: "fallback", defaultThinkingLevel: "high" });
    const promoted = await open();
    expect(promoted.model?.id).toBe("fallback");
    expect(promoted.thinkingLevel).toBe("high");
  } finally {
    for (const session of sessions) session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

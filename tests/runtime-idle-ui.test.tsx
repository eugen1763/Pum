import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { App } from "../src/app";
import { bindRuntimeSettingsActivity, isRuntimeIdle, RuntimeSettingsCoordinator } from "../src/runtime-settings";
import { McpController } from "../src/mcp";
import { LspController } from "../src/lsp";
import { readMcpProposal } from "../src/mcp-config";
import { readLspProposal } from "../src/lsp-files";
import { ProjectValidationController, readValidationProposal } from "../src/project-validation";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce(); await setup.flush();
  await new Promise(resolve => setTimeout(resolve, 25));
  await setup.renderOnce(); await setup.flush();
}
async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text); await settle(setup);
  setup.mockInput.pressEnter(); await settle(setup);
}

test("rendered App refuses real controller grants after installed SDK old settlement clears busy during newer work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pum-idle-ui-"));
  const entered = deferred(); const unwind = deferred(); const finish = deferred(); const started = deferred();
  const setup = await createTestRenderer({ width: 120, height: 38, kittyKeyboard: true, exitOnCtrlC: false });
  const model: Model<"openai-completions"> = { id: "idle-ui", name: "Idle UI", provider: "pum-idle-ui", api: "openai-completions", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(cwd, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.hasConfiguredAuth = provider => provider === model.provider;
  const services = await createAgentSessionServices({ cwd, agentDir: cwd, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: "idle-ui-preflight", factory(pi) { pi.on("before_agent_start", async event => {
        if (event.prompt === "old") { entered.resolve(); await unwind.promise; }
      }); } }] } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), model, thinkingLevel: "off", tools: [] });
  const coordinator = new RuntimeSettingsCoordinator();
  bindRuntimeSettingsActivity(session, coordinator);
  await session.bindExtensions({ onError: error => { throw error; } });
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Done" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    void finish.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  mkdirSync(join(cwd, ".pum"));
  writeFileSync(join(cwd, ".pum", "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "audit", executable: "/fake/server", args: [] }] }));
  writeFileSync(join(cwd, ".pum", "lsp.json"), JSON.stringify({ version: 1, executable: "/fake/server", args: [] }));
  writeFileSync(join(cwd, ".pum", "validation.json"), JSON.stringify({ version: 1, commands: [{ kind: "test", command: "echo test", timeoutSeconds: 1 }] }));
  let spawns = 0;
  const options = { cwd, isIdle: () => isRuntimeIdle(session), spawn: async () => { spawns++; throw new Error("sentinel spawn"); } };
  const mcp = new McpController(options); mcp.bind(session);
  const lsp = new LspController(options); lsp.bind(session);
  const validation = new ProjectValidationController({ cwd }); validation.bind(session);
  const calls: string[] = [];
  const mcpCommand = mcp.command.bind(mcp); mcp.command = async text => { calls.push(text); return mcpCommand(text); };
  const lspCommand = lsp.command.bind(lsp); lsp.command = async text => { calls.push(text); return lspCommand(text); };
  const enable = validation.enable.bind(validation); validation.enable = digest => { calls.push("enable"); enable(digest); };
  const digest = readValidationProposal(cwd).digest;
  const mcpConnect = `/mcp connect audit ${readMcpProposal(cwd).digest}`;
  const lspConnect = `/lsp connect ${readLspProposal(cwd).digest}`;
  const manager = { getAgents: () => [], subscribe: () => () => {}, bindMainSession: async () => {}, resendUndeliveredMainSettlements: async () => {}, getAgent: () => undefined } as any;
  const settings = { showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off", webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off", sandboxMode: "off", checkModel: "mock/plain", maxActiveSubagents: 10 } as any;
  let fresh: Promise<void> | undefined;
  let old: Promise<unknown> | undefined;
  try {
    createRoot(setup.renderer).render(<App session={session}
      modelRuntime={{ getAvailableSnapshot: () => [model], getProviders: () => [] } as any}
      onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
      settings={settings} searchProviders={[]} subagentManager={manager}
      mcpForSession={target => target === session ? mcp : undefined}
      lspForSession={target => target === session ? lsp : undefined}
      promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
      promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }}
    />);
    await settle(setup);
    // Legitimate idle direct consent works before the stale predecessor scenario.
    await submit(setup, `/validation enable ${digest}`);
    expect(validation.status()).toContain("enabled");
    await submit(setup, "/mcp preview"); await submit(setup, "/lsp preview");
    calls.length = 0;
    old = session.prompt("old").catch(error => error);
    await entered.promise; await session.abort();
    session.subscribe(event => { if (event.type === "agent_start") started.resolve(); });
    fresh = session.sendCustomMessage({ customType: "fixture", content: "new", display: false }, { triggerTurn: true });
    await started.promise;
    await settle(setup); // App observes new agent_start and becomes busy.
    expect(setup.captureCharFrame()).toContain("working");
    unwind.resolve(); expect(await old).toBeInstanceOf(Error);
    await settle(setup); // Real old agent_settled mirrors busy=false in App.
    expect(setup.captureCharFrame()).not.toContain("working");
    expect(session.isStreaming).toBe(false);
    expect(session.agent.state.isStreaming).toBe(true);
    expect(isRuntimeIdle(session)).toBe(false);
    for (const command of [mcpConnect, `/mcp approve audit ${"a".repeat(64)}`, lspConnect, "/lsp check test.py", `/validation enable ${digest}`]) {
      await submit(setup, command);
      expect(setup.captureCharFrame()).toContain("Wait for the");
      expect(calls).toEqual([]); // App blocks before real controller, not just downstream refusal.
    }
    expect(spawns).toBe(0);
    // Actual newer work is active: direct revoke/stop/disable must still dispatch.
    await submit(setup, "/mcp revoke audit"); await submit(setup, "/lsp stop");
    await submit(setup, "/validation disable");
    expect(calls).toEqual(["/mcp revoke audit", "/lsp stop"]);
    expect(validation.status()).toContain("disabled");
    finish.resolve(); await fresh; await settle(setup);
    expect(isRuntimeIdle(session)).toBe(true);
    await submit(setup, `/validation enable ${digest}`);
    expect(validation.status()).toContain("enabled");
    await submit(setup, "/mcp preview"); await submit(setup, "/lsp preview");
    await submit(setup, mcpConnect); await submit(setup, lspConnect);
    expect(spawns).toBe(2); // Valid idle input reaches both real process admissions.
  } finally {
    unwind.resolve(); finish.resolve();
    await Promise.allSettled([old, fresh].filter(Boolean) as Promise<unknown>[]);
    setup.renderer.destroy();
    await session.abort(); session.dispose(); mcp.dispose(); lsp.dispose(); validation.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { bindRuntimeSettingsActivity, isRuntimeIdle, RuntimeSettingsCoordinator, type RuntimeSecuritySettings } from "../src/runtime-settings";
import { McpController } from "../src/mcp";
import { LspController } from "../src/lsp";
import { readMcpProposal } from "../src/mcp-config";
import { readLspProposal } from "../src/lsp-files";
import { ProjectValidationController, readValidationProposal } from "../src/project-validation";

const model: Model<"openai-completions"> = { id: "settings-fixture", name: "settings-fixture", provider: "pum-settings-fixture", api: "openai-completions", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const strict: RuntimeSecuritySettings = { checkMode: "on", checkModel: "mock/check", sandboxMode: "require", checkPaths: [], webSearch: false };
const relaxed: RuntimeSecuritySettings = { ...strict, checkMode: "off", sandboxMode: "off", webSearch: true };
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { await session.abort(); session.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }
async function fixture(extensions: InlineExtension[] = [], retry = false,
  beforeBind?: (session: AgentSession, coordinator: RuntimeSettingsCoordinator) => void) {
  const root = mkdtempSync(join(tmpdir(), "pum-settings-sdk-")); roots.push(root);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.hasConfiguredAuth = (provider) => provider === model.provider;
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: extensions } });
  const manager = SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, thinkingLevel: "off", tools: [] });
  sessions.push(session);
  const coordinator = new RuntimeSettingsCoordinator();
  coordinator.configure(strict, () => {});
  beforeBind?.(session, coordinator);
  bindRuntimeSettingsActivity(session, coordinator);
  await session.bindExtensions({ onError: (error) => { throw error; } });
  let calls = 0;
  let failures = retry ? 1 : 0;
  let deliveryGate: Promise<void> | undefined;
  session.agent.streamFunction = () => {
    calls++;
    const error = failures-- > 0;
    const message: AssistantMessage = { role: "assistant", content: error ? [] : [{ type: "text", text: "Done" }], api: model.api, provider: model.provider, model: model.id, stopReason: error ? "error" : "stop", timestamp: Date.now(), ...(error ? { errorMessage: "503 service unavailable" } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    const deliver = () => {
      if (error) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
    };
    if (deliveryGate) void deliveryGate.then(deliver); else deliver();
    return stream;
  };
  return { root, session, coordinator, calls: () => calls, holdDelivery: (gate: Promise<void>) => { deliveryGate = gate; } };
}

test("SDK async before_agent_start holds security; true settled commits before a later listener admits work", async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture([{ name: "settings-preflight-gate", factory(pi) { pi.on("before_agent_start", async () => { entered.resolve(); await release.promise; }); } }]);
  const work = f.session.prompt("first");
  await entered.promise;
  f.coordinator.request(relaxed);
  expect(f.coordinator.snapshot()?.pending).toBe(true);
  let effectiveAtSettlement: RuntimeSecuritySettings | undefined;
  f.session.subscribe((event) => { if (event.type === "agent_settled") { effectiveAtSettlement = f.coordinator.snapshot()?.effective; } });
  release.resolve(); await work;
  expect(effectiveAtSettlement).toEqual(relaxed);
  expect(f.coordinator.snapshot()?.active).toBe(0);
});

test("SDK retries retain effective policy through every agent_end", async () => {
  const f = await fixture([], true);
  let ends = 0;
  f.session.subscribe((event) => {
    if (event.type === "agent_end") {
      ends++;
      f.coordinator.request(relaxed);
      expect(f.coordinator.snapshot()?.effective).toEqual(strict);
    }
  });
  await f.session.prompt("retry");
  expect(ends).toBe(2);
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
});

for (const operation of ["abort", "dispose"] as const) test(`SDK ${operation} during async preflight releases and prevents delayed model dispatch`, async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture([{ name: "settings-cancel-gate", factory(pi) { pi.on("before_agent_start", async () => { entered.resolve(); await release.promise; }); } }]);
  const work = f.session.prompt("never dispatch").catch((error) => error);
  await entered.promise;
  f.coordinator.request(relaxed);
  await f.session[operation]();
  expect(f.coordinator.snapshot()?.active).toBe(0);
  release.resolve();
  expect(await work).toBeInstanceOf(Error);
  expect(f.calls()).toBe(0);
  expect(f.coordinator.snapshot()?.active).toBe(0);
});

test("cancelled SDK preflight settling later cannot release a newer running prompt", async () => {
  const entered = deferred(); const release = deferred(); const finish = deferred();
  const f = await fixture([{ name: "settings-stale-settlement", factory(pi) { pi.on("before_agent_start", async (event) => { if (event.prompt === "old") { entered.resolve(); await release.promise; } }); } }]);
  const old = f.session.prompt("old").catch((error) => error);
  await entered.promise;
  await f.session.abort();
  f.holdDelivery(finish.promise);
  const started = deferred();
  f.session.subscribe((event) => { if (event.type === "agent_start") started.resolve(); });
  const fresh = f.session.sendCustomMessage({ customType: "fixture", content: "new", display: false }, { triggerTurn: true });
  await started.promise;
  f.coordinator.request(relaxed);
  release.resolve();
  expect(await old).toBeInstanceOf(Error);
  expect(f.coordinator.snapshot()?.pending).toBe(true);
  finish.resolve(); await fresh;
  expect(f.coordinator.snapshot()?.pending).toBe(false);
});

for (const source of ["extension", "predecessor-subscriber", "later-subscriber"] as const) {
  for (const method of ["custom", "user", "prompt"] as const) test(`SDK ${source} settled reentry via ${method} cannot lose the newer lease`, async () => {
    let f!: Awaited<ReturnType<typeof fixture>>;
    let follow!: Promise<void>;
    const finish = deferred();
    let settlements = 0;
    let policyAtAdmission: RuntimeSecuritySettings | undefined;
    const reenter = () => {
      if (++settlements !== 1) return;
      policyAtAdmission = f.coordinator.snapshot()?.effective;
      f.holdDelivery(finish.promise);
      follow = method === "custom"
        ? f.session.sendCustomMessage({ customType: "follow", content: "next", display: false }, { triggerTurn: true })
        : method === "user" ? f.session.sendUserMessage("next") : f.session.prompt("next");
    };
    f = await fixture(source === "extension" ? [{ name: "reentrant-settle", factory(pi) {
      pi.on("agent_settled", reenter);
    } }] : [], false, source === "predecessor-subscriber" ? (session) => {
      session.subscribe((event) => { if (event.type === "agent_settled") reenter(); });
    } : undefined);
    if (source === "later-subscriber") f.session.subscribe((event) => { if (event.type === "agent_settled") reenter(); });
    f.session.subscribe((event) => { if (event.type === "agent_end") f.coordinator.request(relaxed); });
    await f.session.prompt("first");
    try {
      expect(f.session.isStreaming).toBe(true);
      expect(f.coordinator.snapshot()!.active).toBeGreaterThan(0);
      // A predecessor admits while the old lease still exists. A later listener
      // sees the committed idle transition; admission must not roll it back.
      expect(policyAtAdmission).toEqual(source === "later-subscriber" ? relaxed : strict);
      expect(f.coordinator.snapshot()?.pending).toBe(source !== "later-subscriber");
      if (source !== "later-subscriber") expect(f.coordinator.snapshot()?.effective).toEqual(strict);
    } finally { finish.resolve(); await follow; }
    expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
  });
}

for (const method of ["prompt", "continue"] as const) test(`SDK direct agent.${method} settled-hook reentry owns its dispatch independently`, async () => {
  let f!: Awaited<ReturnType<typeof fixture>>; let follow!: Promise<void>;
  const finish = deferred(); let settlements = 0;
  f = await fixture([{ name: "direct-reentry", factory(pi) {
    pi.on("agent_settled", () => {
      if (++settlements !== 1) return;
      f.holdDelivery(finish.promise);
      if (method === "continue") {
        // Public append-only custom delivery runs synchronously before continue.
        void f.session.sendCustomMessage({ customType: "direct", content: "next", display: false }, { triggerTurn: false });
      }
      follow = method === "prompt" ? f.session.agent.prompt("next") : f.session.agent.continue();
    });
  } }]);
  f.session.subscribe((event) => { if (event.type === "agent_end") f.coordinator.request(relaxed); });
  await f.session.prompt("first");
  try {
    expect(f.session.agent.state.isStreaming).toBe(true);
    expect(f.coordinator.snapshot()).toMatchObject({ active: 1, pending: true, effective: strict });
  } finally { finish.resolve(); await follow; }
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
});

test("SDK agent_end queued custom continuation retains its original owner through true settlement", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  let ends = 0;
  const finish = deferred(); const continued = deferred();
  f = await fixture([{ name: "queued-continuation", factory(pi) {
    pi.on("agent_end", () => {
      if (++ends !== 1) return;
      f.coordinator.request(relaxed);
      f.holdDelivery(finish.promise);
      // Queue after the SDK loop drained; _handlePostAgentRun dispatches continue.
      f.session.agent.followUp({ role: "custom", customType: "queued", content: "next", display: false, timestamp: Date.now() });
    });
    pi.on("agent_start", () => { if (ends === 1) continued.resolve(); });
  } }]);
  const work = f.session.prompt("first");
  await continued.promise;
  try {
    expect(f.coordinator.snapshot()).toMatchObject({ active: 2, pending: true, effective: strict });
  } finally { finish.resolve(); await work; }
  expect(ends).toBe(2);
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
});

test("SDK older async predecessor wrapper rejection cannot release an independent custom run", async () => {
  const entered = deferred(); const reject = deferred(); const finish = deferred(); const started = deferred();
  const f = await fixture([], false, (session) => {
    const original = session.prompt.bind(session);
    session.prompt = async (...args) => {
      if (args[0] !== "reject") return original(...args);
      entered.resolve(); await reject.promise; throw new Error("predecessor rejection");
    };
  });
  const old = f.session.prompt("reject").catch((error) => error);
  await entered.promise;
  f.holdDelivery(finish.promise);
  f.session.subscribe((event) => { if (event.type === "agent_start") started.resolve(); });
  const fresh = f.session.sendCustomMessage({ customType: "fresh", content: "fresh", display: false }, { triggerTurn: true });
  await started.promise;
  f.coordinator.request(relaxed);
  reject.resolve();
  expect(await old).toBeInstanceOf(Error);
  try { expect(f.coordinator.snapshot()).toMatchObject({ active: 2, pending: true, effective: strict }); }
  finally { finish.resolve(); await fresh; }
  expect(f.coordinator.snapshot()?.active).toBe(0);
});

for (const rejects of [false, true]) test(`SDK delayed predecessor abort ${rejects ? "rejection" : "return"} releases only captured admissions`, async () => {
  const preflight = deferred(); const unwind = deferred(); const aborted = deferred(); const returnAbort = deferred();
  const finish = deferred(); const started = deferred();
  let delayAbort = true;
  const f = await fixture([{ name: "abort-overlap", factory(pi) {
    pi.on("before_agent_start", async (event) => { if (event.prompt === "old") { preflight.resolve(); await unwind.promise; } });
  } }], false, (session) => {
    const original = session.abort.bind(session);
    session.abort = async () => {
      await original();
      if (!delayAbort) return;
      delayAbort = false;
      aborted.resolve(); await returnAbort.promise;
      if (rejects) throw new Error("abort predecessor rejected");
    };
  });
  const old = f.session.prompt("old").catch((error) => error);
  await preflight.promise;
  const abort = f.session.abort().catch((error) => error);
  await aborted.promise;
  f.holdDelivery(finish.promise);
  f.session.subscribe((event) => { if (event.type === "agent_start") started.resolve(); });
  const fresh = f.session.sendCustomMessage({ customType: "fresh", content: "fresh", display: false }, { triggerTurn: true });
  await started.promise;
  f.coordinator.request(relaxed);
  returnAbort.resolve(); await abort;
  unwind.resolve(); expect(await old).toBeInstanceOf(Error);
  try {
    // The SDK's stale session finally resets its shared isStreaming boolean;
    // the underlying agent is still running. Ownership must not trust that flag.
    expect(f.session.agent.state.isStreaming).toBe(true);
    expect(f.coordinator.snapshot()).toMatchObject({ active: 2, pending: true, effective: strict });
  } finally { finish.resolve(); await fresh; }
  expect(f.coordinator.snapshot()?.active).toBe(0);
});

test("SDK stale preflight idle flag cannot turn early abort return into execution settlement", async () => {
  const entered = deferred(); const unwind = deferred(); const finish = deferred(); const started = deferred();
  const f = await fixture([{ name: "stale-idle-abort", factory(pi) {
    pi.on("before_agent_start", async (event) => { if (event.prompt === "old") { entered.resolve(); await unwind.promise; } });
  } }]);
  const old = f.session.prompt("old").catch((error) => error);
  await entered.promise; await f.session.abort();
  f.holdDelivery(finish.promise);
  f.session.subscribe((event) => { if (event.type === "agent_start") started.resolve(); });
  const fresh = f.session.sendCustomMessage({ customType: "fresh", content: "fresh", display: false }, { triggerTurn: true });
  await started.promise;
  unwind.resolve(); expect(await old).toBeInstanceOf(Error);
  expect(f.session.isStreaming).toBe(false); // Installed SDK stale-finally quirk.
  expect(f.session.agent.state.isStreaming).toBe(true);
  f.coordinator.request(relaxed);
  await f.session.abort(); // SDK waitForIdle trusts that stale flag and returns.
  try {
    expect(f.session.agent.state.isStreaming).toBe(true);
    expect(f.coordinator.snapshot()).toMatchObject({ active: 2, pending: true, effective: strict });
  } finally { finish.resolve(); await fresh; }
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
});

test("SDK rejecting abort retains already-started owners until their actual settlement", async () => {
  let rejectAbort = true;
  const f = await fixture([], false, (session) => {
    const original = session.abort.bind(session);
    session.abort = async () => {
      if (rejectAbort) { rejectAbort = false; throw new Error("abort failed before cancellation"); }
      await original();
    };
  });
  const finish = deferred(); const started = deferred();
  f.holdDelivery(finish.promise);
  f.session.subscribe((event) => { if (event.type === "agent_start") started.resolve(); });
  const work = f.session.prompt("held"); await started.promise;
  f.coordinator.request(relaxed);
  try {
    await expect(f.session.abort()).rejects.toThrow("abort failed");
    expect(f.session.agent.state.isStreaming).toBe(true);
    expect(f.coordinator.snapshot()).toMatchObject({ active: 2, pending: true, effective: strict });
  } finally { finish.resolve(); await work; }
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
});

test("SDK failed concurrent direct dispatch cannot release the running public admission", async () => {
  const f = await fixture(); const finish = deferred(); const started = deferred();
  f.holdDelivery(finish.promise);
  f.session.subscribe((event) => { if (event.type === "agent_start") started.resolve(); });
  const work = f.session.prompt("held"); await started.promise;
  f.coordinator.request(relaxed);
  try {
    await expect(f.session.agent.continue()).rejects.toThrow();
    await expect(f.session.agent.prompt("overlap")).rejects.toThrow();
    expect(f.coordinator.snapshot()).toMatchObject({ active: 2, pending: true, effective: strict });
  } finally { finish.resolve(); await work; }
  expect(f.coordinator.snapshot()?.active).toBe(0);
});

test("SDK disposal rejects predecessor reentry and late preflight without leaking leases", async () => {
  const entered = deferred(); const release = deferred();
  let reentry!: Promise<unknown>;
  const f = await fixture([{ name: "dispose-overlap", factory(pi) {
    pi.on("before_agent_start", async () => { entered.resolve(); await release.promise; });
  } }], false, (session) => {
    const original = session.dispose.bind(session);
    session.dispose = () => {
      reentry = session.sendCustomMessage({ customType: "dispose", content: "no", display: false }, { triggerTurn: true }).catch((error) => error);
      original();
    };
  });
  const work = f.session.prompt("old").catch((error) => error);
  await entered.promise; f.coordinator.request(relaxed); f.session.dispose();
  expect(await reentry).toBeInstanceOf(Error);
  release.resolve(); expect(await work).toBeInstanceOf(Error);
  expect(f.calls()).toBe(0);
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false, effective: relaxed });
});

test("SDK stale cancelled preflight cannot admit real MCP/LSP/validation while newer core work runs", async () => {
  const entered = deferred(); const unwind = deferred(); const finish = deferred();
  const f = await fixture([{ name: "idle-consent-stale-preflight", factory(pi) {
    pi.on("before_agent_start", async (event) => { if (event.prompt === "old") { entered.resolve(); await unwind.promise; } });
  } }]);
  const unrelated = await fixture();
  mkdirSync(join(f.root, ".pum"));
  writeFileSync(join(f.root, ".pum", "mcp.json"), JSON.stringify({ version: 1, servers: [{ name: "audit", executable: "/fake/server", args: [] }] }));
  writeFileSync(join(f.root, ".pum", "lsp.json"), JSON.stringify({ version: 1, executable: "/fake/server", args: [] }));
  writeFileSync(join(f.root, ".pum", "validation.json"), JSON.stringify({ version: 1, commands: [{ kind: "test", command: "echo test", timeoutSeconds: 1 }] }));
  let spawns = 0;
  const options = { cwd: f.root, isIdle: () => isRuntimeIdle(f.session), spawn: async () => { spawns++; throw new Error("sentinel spawn"); } };
  const mcp = new McpController(options); mcp.bind(f.session);
  const lsp = new LspController(options); lsp.bind(f.session);
  const validation = new ProjectValidationController({ cwd: f.root }); validation.bind(f.session);
  const mcpConnect = `connect audit ${readMcpProposal(f.root).digest}`;
  const lspConnect = `connect ${readLspProposal(f.root).digest}`;
  const digest = readValidationProposal(f.root).digest;
  const refuse = async () => {
    await expect(mcp.command(mcpConnect)).rejects.toThrow("idle");
    await expect(lsp.command(lspConnect)).rejects.toThrow("idle");
    expect(() => validation.enable(digest)).toThrow("idle");
    expect(spawns).toBe(0);
  };
  try {
    expect(isRuntimeIdle(f.session)).toBe(true);
    validation.enable(digest);
    await mcp.command("preview"); await lsp.command("preview");
    const old = f.session.prompt("old").catch(error => error);
    await entered.promise;
    expect(isRuntimeIdle(f.session)).toBe(false); // Admission before core dispatch.
    await refuse();
    await f.session.abort();
    f.holdDelivery(finish.promise);
    const started = deferred();
    f.session.subscribe(event => { if (event.type === "agent_start") started.resolve(); });
    const fresh = f.session.sendCustomMessage({ customType: "fixture", content: "new", display: false }, { triggerTurn: true });
    await started.promise;
    unwind.resolve(); expect(await old).toBeInstanceOf(Error);
    expect(f.session.isStreaming).toBe(false); // Actual installed SDK stale finally.
    expect(f.session.agent.state.isStreaming).toBe(true);
    expect(f.coordinator.snapshot()?.active).toBe(2);
    expect(isRuntimeIdle(f.session)).toBe(false);
    expect(isRuntimeIdle(unrelated.session)).toBe(true);
    await refuse();
    // Direct revocation is intentionally not gated on idle.
    await mcp.command("revoke audit"); await lsp.command("stop"); validation.disable();
    expect(validation.status()).toContain("disabled");
    finish.resolve(); await fresh;
    expect(isRuntimeIdle(f.session)).toBe(true);
    validation.enable(digest);
    await mcp.command("preview"); await lsp.command("preview");
    await expect(mcp.command(mcpConnect)).rejects.toThrow();
    await expect(lsp.command(lspConnect)).rejects.toThrow();
    expect(spawns).toBe(2); // Legitimate idle reaches real controller process admission.
    f.session.dispose();
    expect(isRuntimeIdle(f.session)).toBe(false);
    expect(() => validation.enable(digest)).toThrow();
  } finally { unwind.resolve(); finish.resolve(); mcp.dispose(); lsp.dispose(); validation.dispose(); }
});

test("SDK direct invalid continue releases a no-start dispatch instead of retaining a phantom run", async () => {
  const f = await fixture();
  await expect(f.session.agent.continue()).rejects.toThrow();
  expect(f.coordinator.snapshot()?.active).toBe(0);
  f.coordinator.request(relaxed);
  expect(f.coordinator.snapshot()?.pending).toBe(false);
});

test("SDK overlapping pending preflight is not released by a different run settling", async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture([{ name: "settings-overlap-gate", factory(pi) { pi.on("before_agent_start", async (event) => { if (event.prompt === "held") { entered.resolve(); await release.promise; } }); } }]);
  const held = f.session.prompt("held");
  await entered.promise;
  await f.session.sendCustomMessage({ customType: "fixture", content: "other", display: false }, { triggerTurn: true });
  f.coordinator.request(relaxed);
  expect(f.coordinator.snapshot()?.pending).toBe(true);
  release.resolve(); await held;
  expect(f.coordinator.snapshot()).toMatchObject({ active: 0, pending: false });
});

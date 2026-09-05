import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createLockedAgentSessionRuntime, type LockedRuntimeFactory, type LockedAgentSessionRuntime } from "../src/session-lock-runtime";
import { SessionLockOwner, SessionLockedError } from "../src/session-lock";
import { bindRuntimeSettingsActivity, isRuntimeIdle } from "../src/runtime-settings";
import { bindConversationBranchSession, conversationBranchState, CONVERSATION_BRANCH_CUSTOM_TYPE, listConversationBranchPoints } from "../src/conversation-branch";
import { ContextWindowController } from "../src/context-window";
import { companionFileFor } from "../src/session-companion";
import { createGoal, loadGoal, saveGoal, stopGoal } from "../src/goal";
import { createTodoTask, loadTodoTasks, saveTodoTasks } from "../src/todo";
import { loadSessionSettings, saveSessionSettings } from "../src/session-settings";
import { loadNewsItems, saveNewsItems } from "../src/news";
import { loadToolGroups, saveToolGroups } from "../src/tool-groups";

const MODEL: Model<"openai-completions"> = {
  id: "branch-script", name: "Branch script", provider: "pum-branch-fixture", api: "openai-completions", baseUrl: "https://unused.invalid",
  reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ALTERNATIVE: typeof MODEL = { ...MODEL, id: "current-model", name: "Current model" };
const roots: string[] = [];
const runtimes: LockedAgentSessionRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { await runtime.dispose(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const answer = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1, stopReason: "stop", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { startupNextTurn?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pum-branch-sdk-")); roots.push(root);
  const cwd = join(root, "project"); const agentDir = join(root, "agent"); const store = join(root, "sessions");
  mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(store);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.hasConfiguredAuth = (provider) => provider === MODEL.provider;
  modelRuntime.checkAuth = async (provider) => provider === MODEL.provider ? { type: "api_key" } : undefined;
  modelRuntime.getModel = (provider, id) => provider === MODEL.provider ? [MODEL, ALTERNATIVE].find((model) => model.id === id) : undefined;
  const manager = SessionManager.create(cwd, store);
  const first = manager.appendMessage({ role: "user", content: "original prompt", timestamp: 1 });
  const firstAnswer = manager.appendMessage(answer("original answer"));
  const second = manager.appendMessage({ role: "user", content: "second prompt", timestamp: 2 });
  manager.appendMessage(answer("second answer"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" });
  const sessions: AgentSession[] = [];
  const controllers: ContextWindowController[] = [];
  const requests: unknown[][] = [];
  const hooks: { beforeBuild?: (count: number) => Promise<void>; afterBuild?: (session: AgentSession, count: number) => void; defaultThinking?: AgentSession["thinkingLevel"]; shutdown?: (count: number) => Promise<void> } = {};
  const retiredCapabilities: number[] = [];
  const shutdownEvents: { count: number; reason: string; targetSessionFile?: string }[] = [];
  const navigationHooks: string[] = [];
  let count = 0;
  const factory: LockedRuntimeFactory = async ({ cwd, sessionManager, conversationState }) => {
    const buildCount = ++count;
    await hooks.beforeBuild?.(buildCount);
    const controller = new ContextWindowController(); controllers.push(controller);
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: settings, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "BRANCH_FIXTURE", extensionFactories: [controller.extension(), {
        name: "branch-startup-fixture", factory(pi) {
          pi.on("session_start", () => {
            if (options.startupNextTurn) pi.sendMessage({ customType: "startup-next-turn", content: "startup pending input", display: false }, { deliverAs: "nextTurn" });
          });
          pi.on("session_shutdown", async (event) => {
            shutdownEvents.push({ count: buildCount, reason: event.reason, targetSessionFile: event.targetSessionFile });
            await hooks.shutdown?.(buildCount);
          });
          pi.on("session_before_tree", () => { navigationHooks.push("tree"); return { cancel: true }; });
          pi.on("session_before_fork", () => { navigationHooks.push("fork"); return { cancel: true }; });
        },
      }],
    } });
    const restoredState = conversationState ?? conversationBranchState(sessionManager, services.modelRuntime);
    const result = await createAgentSessionFromServices({ services, sessionManager, model: restoredState?.model ?? MODEL, thinkingLevel: restoredState?.thinkingLevel ?? hooks.defaultThinking ?? "high", tools: [] });
    const session = result.session; sessions.push(session);
    bindConversationBranchSession(session);
    bindRuntimeSettingsActivity(session);
    controller.bind(session);
    await session.bindExtensions({});
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const message = answer("fresh reply");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    try { hooks.afterBuild?.(session, buildCount); }
    catch (error) { session.dispose(); throw error; }
    return { ...result, services, diagnostics: [], retireConversation: () => { retiredCapabilities.push(buildCount); } };
  };
  const runtime = await createLockedAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: manager }, new SessionLockOwner()); runtimes.push(runtime);
  const selection = (id: string) => listConversationBranchPoints(runtime.session).points.find((point) => point.entryId === id)!.selection;
  return { root, cwd, agentDir, store, runtime, manager, first, firstAnswer, second, sessions, settings, hooks, requests, selection, factory, retiredCapabilities, shutdownEvents, navigationHooks };
}

describe("installed SDK same-session conversation branch", () => {
  test("re-edits before root in one append-only file/UUID, retains companions and current model/effort, resumes immediately", async () => {
    const f = await fixture();
    const path = f.runtime.session.sessionFile!;
    const old = f.runtime.session;
    await old.setModel(ALTERNATIVE);
    old.setThinkingLevel("high");
    const before = readFileSync(path);
    const id = old.sessionId;
    const goal = stopGoal(createGoal("current stopped goal", 5));
    const todos = [createTodoTask("current task", "blocked")];
    const news = [{ id: "current-answer", text: "second answer", at: 1, read: true, answered: false }];
    saveGoal(path, goal);
    saveTodoTasks(path, todos);
    saveNewsItems(path, news);
    saveSessionSettings(path, { animations: false, showThinking: false });
    saveToolGroups(path, ["Todo"]);
    const companions = ["goal", "todo", "news", "settings", "tool-groups"].map((name) => companionFileFor(path, `${name}.json`));
    const companionBytes = companions.map((path) => readFileSync(path));
    const result = await f.runtime.branchConversation(f.selection(f.first));
    expect(result.editorText).toBe("original prompt");
    expect(result.session).not.toBe(old);
    expect(result.session).toBe(f.runtime.session);
    expect(isRuntimeIdle(old)).toBe(false);
    expect(isRuntimeIdle(result.session)).toBe(true);
    expect(result.session.sessionId).toBe(id);
    expect(result.session.sessionFile).toBe(path);
    expect(result.session.messages).toEqual([]);
    expect(result.session.model?.id).toBe(ALTERNATIVE.id);
    expect(result.session.thinkingLevel).toBe("high");
    expect(f.settings.getDefaultThinkingLevel()).toBe("off");
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
    expect(readdirSync(f.store).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
    for (const [index, path] of companions.entries()) expect(readFileSync(path).equals(companionBytes[index]!)).toBe(true);
    expect(loadGoal(result.session.sessionFile)).toEqual(goal);
    expect(loadTodoTasks(result.session.sessionFile)).toEqual(todos);
    expect(loadNewsItems(result.session.sessionFile)).toEqual(news);
    expect(loadSessionSettings(result.session.sessionFile)).toEqual({ animations: false, showThinking: false });
    expect(loadToolGroups(result.session.sessionFile)).toEqual(["Todo"]);
    const branchEntries = result.session.sessionManager.getEntries();
    const anchor = branchEntries.find((entry) => entry.type === "custom" && entry.customType === CONVERSATION_BRANCH_CUSTOM_TYPE)!;
    expect(anchor.parentId).toBeNull();
    expect(JSON.stringify(anchor)).not.toContain("prompt");
    const reopened = SessionManager.open(path, f.store, f.cwd);
    expect(reopened.getSessionId()).toBe(id);
    expect(reopened.buildSessionContext().messages).toEqual([]);
    expect(reopened.buildSessionContext().model).toEqual({ provider: ALTERNATIVE.provider, modelId: ALTERNATIVE.id });
    expect(reopened.buildSessionContext().thinkingLevel).toBe("high");
    expect(reopened.getEntries().slice(0, f.manager.getEntries().length)).toEqual(f.manager.getEntries());
    await f.runtime.dispose();
    const owner = new SessionLockOwner(); const reservation = owner.acquire(path);
    f.hooks.defaultThinking = "off";
    const restarted = await createLockedAgentSessionRuntime(f.factory, { cwd: f.cwd, agentDir: f.agentDir,
      sessionManager: SessionManager.open(path, f.store, f.cwd) }, owner).finally(reservation);
    runtimes.push(restarted);
    expect(restarted.session.messages).toEqual([]);
    expect(restarted.session.model?.id).toBe(ALTERNATIVE.id);
    expect(restarted.session.thinkingLevel).toBe("high");
    await restarted.session.prompt("new branch prompt");
    expect(JSON.stringify(f.requests.at(-1))).toContain("new branch prompt");
    expect(JSON.stringify(f.requests.at(-1))).not.toContain("original answer");
    expect(restarted.session.sessionManager.getEntries().some((entry) => entry.id === f.second)).toBe(true);
  });

  test("assistant endpoint is AFTER, lock remains contended during async rebuild, transitions serialize", async () => {
    const f = await fixture();
    const gate = deferred(); const entered = deferred();
    const path = f.runtime.session.sessionFile!;
    f.hooks.beforeBuild = async (count) => { if (count === 2) { entered.resolve(); await gate.promise; } };
    const pending = f.runtime.branchConversation(f.selection(f.firstAnswer));
    await entered.promise;
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    expect(isRuntimeIdle(f.sessions[0])).toBe(false);
    await expect(f.runtime.newSession()).rejects.toThrow("already in progress");
    gate.resolve();
    const result = await pending;
    expect(result.editorText).toBeUndefined();
    expect(JSON.stringify(result.session.messages)).toContain("original answer");
    expect(JSON.stringify(result.session.messages)).not.toContain("second prompt");
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    await f.runtime.dispose();
    new SessionLockOwner().acquire(path)();
  });

  test("normal asynchronous SDK shutdown runs before anchor under a frozen, revoked, continuously owned source", async () => {
    const f = await fixture(); const old = f.runtime.session; const path = old.sessionFile!;
    const before = readFileSync(path); const entered = deferred(); const gate = deferred();
    f.hooks.shutdown = async (count) => {
      if (count !== 1) return;
      expect(f.retiredCapabilities).toEqual([1]);
      expect(isRuntimeIdle(old)).toBe(false);
      await expect(old.prompt("shutdown reentry")).rejects.toThrow();
      await expect(old.agent.prompt("shutdown core reentry")).rejects.toThrow();
      await expect(old.sendCustomMessage({ customType: "shutdown", content: "queued reentry", display: false }, { deliverAs: "nextTurn" })).rejects.toThrow();
      await expect(old.executeBash("echo unsafe reentry")).rejects.toThrow();
      await expect(old.compact("forbidden shutdown summary")).rejects.toThrow("retiring");
      await expect(old.navigateTree(f.first, { summarize: true })).rejects.toThrow("retiring");
      const leaf = old.sessionManager.getLeafId();
      const file = old.sessionManager.getSessionFile();
      for (const mutation of [
        () => old.sessionManager.newSession(), () => old.sessionManager.setSessionFile(join(f.store, "unwanted.jsonl")),
        () => old.sessionManager.branch(f.first), () => old.sessionManager.resetLeaf(),
        () => old.sessionManager.branchWithSummary(f.first, "forbidden"),
        () => old.sessionManager.createBranchedSession(f.first),
      ]) expect(mutation).toThrow("retiring");
      expect(old.sessionManager.getLeafId()).toBe(leaf);
      expect(old.sessionManager.getSessionFile()).toBe(file);
      await expect(f.runtime.newSession()).rejects.toThrow("already in progress");
      await expect(f.runtime.fork(f.first)).rejects.toThrow("already in progress");
      await expect(f.runtime.switchSession(path)).rejects.toThrow("already in progress");
      expect(() => old.agent.followUp({ role: "user", content: "queue reentry", timestamp: 1 })).toThrow();
      entered.resolve(); await gate.promise;
    };
    const pending = f.runtime.branchConversation(f.selection(f.first));
    await entered.promise;
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(f.sessions).toHaveLength(1);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    gate.resolve();
    const result = await pending;
    expect(result.editorText).toBe("original prompt");
    expect(f.shutdownEvents).toEqual([{ count: 1, reason: "resume", targetSessionFile: path }]);
    expect(f.navigationHooks).toEqual([]);
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
    expect(f.sessions).toHaveLength(2);
  });

  test("SDK-swallowed shutdown handler failure is detected and cannot publish a navigation anchor or replacement", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!; const before = readFileSync(path);
    let cleanupCalls = 0;
    f.hooks.shutdown = async (count) => { if (count === 1) { cleanupCalls++; throw new Error("PRIVATE cleanup failure"); } };
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("recovery required");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(f.sessions).toHaveLength(1);
    expect(f.retiredCapabilities).toEqual([1]);
    expect(isRuntimeIdle(f.runtime.session)).toBe(false);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    await f.runtime.dispose();
    expect(cleanupCalls).toBe(1);
    new SessionLockOwner().acquire(path)();
  });

  test("timed-out shutdown stays frozen and locked until actual cleanup settlement, without anchor or repeated cleanup", async () => {
    const f = await fixture(); const old = f.runtime.session; const path = old.sessionFile!; const before = readFileSync(path);
    const gate = deferred(); const disposed = deferred(); let calls = 0;
    const dispose = old.dispose.bind(old);
    old.dispose = () => { dispose(); disposed.resolve(); };
    f.hooks.shutdown = async (count) => { if (count === 1) { calls++; await gate.promise; } };
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("recovery required");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(f.sessions).toHaveLength(1);
    expect(isRuntimeIdle(old)).toBe(false);
    await expect(old.prompt("late reentry")).rejects.toThrow();
    await expect(f.runtime.dispose()).rejects.toThrow("still pending");
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    gate.resolve();
    await disposed.promise;
    // The native disposal's finally records settlement in its next microtask.
    await Promise.resolve();
    await f.runtime.dispose();
    expect(calls).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
    new SessionLockOwner().acquire(path)();
  }, 15_000);

  test("branching a same-file relocated runtime retains canonical file, UUID, effective cwd and header bytes", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!;
    const id = f.runtime.session.sessionId;
    const moved = join(f.root, "relocated"); mkdirSync(moved);
    await f.runtime.switchSession(path, { cwdOverride: moved });
    const before = readFileSync(path);
    const result = await f.runtime.branchConversation(f.selection(f.firstAnswer));
    expect(result.session.sessionId).toBe(id);
    expect(result.session.sessionFile).toBe(path);
    expect(f.runtime.cwd).toBe(moved);
    expect(result.session.sessionManager.getCwd()).toBe(moved);
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
    expect(result.session.sessionManager.getHeader()?.cwd).toBe(f.cwd);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
  });

  test("factory failure appends rollback ancestry and builds a fresh original runtime under continuous ownership", async () => {
    const f = await fixture();
    const old = f.runtime.session;
    const path = old.sessionFile!; const before = readFileSync(path);
    f.hooks.beforeBuild = async (count) => {
      expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
      if (count === 2) throw new Error("fixture build failure");
    };
    const result = await f.runtime.branchConversation(f.selection(f.first));
    expect(result.recovered).toBe(true);
    expect(result.editorText).toBeUndefined();
    expect(result.session).not.toBe(old);
    expect(JSON.stringify(result.session.messages)).toContain("second answer");
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
    const anchors = result.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === CONVERSATION_BRANCH_CUSTOM_TYPE);
    expect(anchors).toHaveLength(2);
    expect((anchors[1] as any).data.rollback).toBe(true);
    expect(JSON.stringify(SessionManager.open(path, f.store, f.cwd).buildSessionContext().messages)).toContain("second answer");
  });

  test("failed recovery holds ownership and blocks all further admission until explicit disposal", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!;
    f.hooks.beforeBuild = async () => { throw new Error("all replacement creation failed"); };
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("recovery required");
    expect(isRuntimeIdle(f.runtime.session)).toBe(false);
    await expect(f.runtime.session.prompt("cannot run")).rejects.toThrow();
    await expect(f.runtime.session.agent.prompt("cannot run core")).rejects.toThrow();
    await expect(f.runtime.session.sendCustomMessage({ customType: "denied", content: "cannot queue", display: false }, { deliverAs: "nextTurn" })).rejects.toThrow("disposed");
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
    await expect(f.runtime.newSession()).rejects.toThrow("recovery required");
    await f.runtime.dispose();
    new SessionLockOwner().acquire(path)();
  });

  test("factory binding failure disposes its partially built session before fresh original recovery", async () => {
    const f = await fixture();
    f.hooks.afterBuild = (_session, count) => { if (count === 2) throw new Error("binding failed"); };
    const result = await f.runtime.branchConversation(f.selection(f.first));
    expect(result.recovered).toBe(true);
    expect(f.sessions).toHaveLength(3);
    expect(isRuntimeIdle(f.sessions[0])).toBe(false);
    expect(isRuntimeIdle(f.sessions[1])).toBe(false);
    await expect(f.sessions[1]!.prompt("no leaked failed runtime")).rejects.toThrow();
    expect(isRuntimeIdle(result.session)).toBe(true);
    expect(JSON.stringify(result.session.messages)).toContain("second answer");
  });

  test("append failure fails closed without pretending in-memory navigation persisted", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!; const before = readFileSync(path);
    const open = SessionManager.open.bind(SessionManager);
    const fault = spyOn(SessionManager, "open").mockImplementation((...args) => {
      const manager = open(...args);
      manager.appendCustomEntry = () => { throw new Error("append failed"); };
      return manager;
    });
    try { await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("recovery required"); }
    finally { fault.mockRestore(); }
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(isRuntimeIdle(f.runtime.session)).toBe(false);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
  });

  test("stale, App revalidation, pending queue/Bash and active core refuse before mutation", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!;
    const oldSelection = f.selection(f.first);
    f.runtime.session.sessionManager.appendCustomEntry("other", {});
    await expect(f.runtime.branchConversation(oldSelection)).rejects.toThrow("stale");
    const before = readFileSync(path);
    const selection = f.selection(f.first);
    await expect(f.runtime.branchConversation(selection, { validate: () => { throw new Error("new manager delivery"); } })).rejects.toThrow("new manager delivery");
    for (const [name, value] of [["pendingMessageCount", 1], ["isBashRunning", true], ["hasPendingBashMessages", true], ["isCompacting", true], ["isRetrying", true]] as const) {
      Object.defineProperty(f.runtime.session, name, { configurable: true, value });
      await expect(f.runtime.branchConversation(selection)).rejects.toThrow("idle");
      delete (f.runtime.session as any)[name];
    }
    (f.runtime.session.agent.state as { isStreaming: boolean }).isStreaming = true;
    await expect(f.runtime.branchConversation(selection)).rejects.toThrow("idle");
    (f.runtime.session.agent.state as { isStreaming: boolean }).isStreaming = false;
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(isRuntimeIdle(f.runtime.session)).toBe(true);
  });

  test("core-only pending messages and nextTurn (including consumed or same-text) never disappear through branching", async () => {
    const f = await fixture(); const session = f.runtime.session;
    const path = session.sessionFile!;
    const selection = f.selection(f.first);
    const before = readFileSync(path);
    session.agent.followUp({ role: "user", content: "core pending", timestamp: 1 });
    expect(session.pendingMessageCount).toBe(0);
    expect(isRuntimeIdle(session)).toBe(true);
    await expect(f.runtime.branchConversation(selection)).rejects.toThrow("idle");
    expect(readFileSync(path).equals(before)).toBe(true);
    session.agent.clearAllQueues();
    const message = { customType: "next-turn", content: "must not be lost", display: false };
    await session.sendCustomMessage(message, { deliverAs: "nextTurn" });
    expect(session.pendingMessageCount).toBe(0);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await expect(f.runtime.branchConversation(selection)).rejects.toThrow("idle");
    // Same-text immediate delivery is not proof that the queued occurrence ran.
    await session.sendCustomMessage(message, { triggerTurn: false });
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("idle");
    await session.prompt("consume the actual nextTurn message");
    expect(JSON.stringify(f.requests.at(-1))).toContain("must not be lost");
    expect(isRuntimeIdle(session)).toBe(true);
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("idle");
  });

  test("nextTurn enqueued by SDK session_start is tracked before the initial runtime is exposed", async () => {
    const f = await fixture({ startupNextTurn: true });
    const path = f.runtime.session.sessionFile!; const before = readFileSync(path);
    expect(isRuntimeIdle(f.runtime.session)).toBe(true);
    expect(f.runtime.session.pendingMessageCount).toBe(0);
    expect(f.runtime.session.agent.hasQueuedMessages()).toBe(false);
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("idle");
    expect(readFileSync(path).equals(before)).toBe(true);
    await f.runtime.session.prompt("deliver startup input normally");
    expect(JSON.stringify(f.requests.at(-1))).toContain("startup pending input");
  });

  test("invalid or legacy bytes introduced by failed setup are refused before SDK recovery open can rewrite them", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!;
    let damaged = "";
    f.hooks.beforeBuild = async (count) => {
      if (count === 2) {
        // Simulate an out-of-contract writer during a failed setup. SDK open
        // would migrate this header; recovery must inspect bytes first.
        damaged = readFileSync(path, "utf8").replace('"version":3', '"version":1');
        writeFileSync(path, damaged);
        throw new Error("failed after external modification");
      }
    };
    await expect(f.runtime.branchConversation(f.selection(f.first))).rejects.toThrow("recovery required");
    expect(readFileSync(path, "utf8")).toBe(damaged);
    expect(() => new SessionLockOwner().acquire(path)).toThrow(SessionLockedError);
  });

  test("before-invalidation callback cannot introduce non-runtime manager work past App revalidation", async () => {
    const f = await fixture(); const path = f.runtime.session.sessionFile!;
    const before = readFileSync(path); let managerBusy = false;
    f.runtime.setBeforeSessionInvalidate(() => { managerBusy = true; });
    const validate = () => { if (managerBusy) throw new Error("manager started delivery"); };
    await expect(f.runtime.branchConversation(f.selection(f.first), { validate, validateRetired: validate })).rejects.toThrow("recovery required");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(isRuntimeIdle(f.runtime.session)).toBe(false);
  });

  test("rollover selection restores only boundaries on chosen ancestry, retains full tree", async () => {
    const f = await fixture();
    f.runtime.session.sessionManager.appendCustomEntry("pum.context_window", { version: 1, handoff: "PRIVATE_HANDOFF" });
    const late = f.runtime.session.sessionManager.appendMessage({ role: "user", content: "fresh window prompt", timestamp: 3 });
    f.runtime.session.sessionManager.appendMessage(answer("fresh window answer"));
    const early = await f.runtime.branchConversation(f.selection(f.firstAnswer));
    expect(JSON.stringify(early.session.messages)).toContain("original answer");
    expect(JSON.stringify(early.session.messages)).not.toContain("PRIVATE_HANDOFF");
    expect(listConversationBranchPoints(early.session).points.find((point) => point.entryId === f.firstAnswer)?.archived).toBe(true);
    const lateResult = await f.runtime.branchConversation(f.selection(late));
    expect(lateResult.editorText).toBe("fresh window prompt");
    expect(JSON.stringify(lateResult.session.messages)).toContain("PRIVATE_HANDOFF");
    expect(JSON.stringify(lateResult.session.messages)).not.toContain("original answer");
    expect(lateResult.session.sessionManager.getEntry(f.second)).toBeDefined();
  });
});

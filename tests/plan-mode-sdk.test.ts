import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createLockedAgentSessionRuntime, type LockedAgentSessionRuntime, type LockedRuntimeFactory } from "../src/session-lock-runtime";
import { SessionLockOwner } from "../src/session-lock";
import { bindRuntimeSettingsActivity } from "../src/runtime-settings";
import { bindConversationBranchSession } from "../src/conversation-branch";
import { isPlanModeActive, loadPlanRecord, PLAN_MODE_CUSTOM_TYPE, savePlanRecord } from "../src/plan-mode";

const MODEL: Model<"openai-completions"> = {
  id: "plan-script", name: "Plan script", provider: "pum-plan-fixture", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const roots: string[] = [];
const runtimes: LockedAgentSessionRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { try { await runtime.dispose(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const answer = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
  timestamp: 1, stopReason: "stop",
  usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pum-plan-sdk-")); roots.push(root);
  const cwd = join(root, "project"); const agentDir = join(root, "agent"); const store = join(root, "sessions");
  mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(store);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.hasConfiguredAuth = (provider) => provider === MODEL.provider;
  modelRuntime.checkAuth = async (provider) => provider === MODEL.provider ? { type: "api_key" } : undefined;
  modelRuntime.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : undefined;
  const manager = SessionManager.create(cwd, store);
  manager.appendMessage({ role: "user", content: "how should we do this", timestamp: 1 });
  manager.appendMessage(answer("here is a plan"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" });
  const builds: { planMode: boolean | undefined; session: AgentSession }[] = [];
  const retired: number[] = [];
  const hooks: { beforeBuild?: (count: number) => Promise<void> } = {};
  let count = 0;
  const factory: LockedRuntimeFactory = async ({ cwd, sessionManager, conversationState, planMode }) => {
    const buildCount = ++count;
    await hooks.beforeBuild?.(buildCount);
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: settings,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "PLAN_FIXTURE" } });
    const result = await createAgentSessionFromServices({ services, sessionManager,
      model: conversationState?.model ?? MODEL, thinkingLevel: conversationState?.thinkingLevel ?? "off", tools: [] });
    const session = result.session;
    builds.push({ planMode, session });
    bindConversationBranchSession(session);
    bindRuntimeSettingsActivity(session);
    await session.bindExtensions({});
    session.agent.streamFunction = () => {
      const message = answer("reply");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    return { ...result, services, diagnostics: [], retireConversation: () => { retired.push(buildCount); } };
  };
  const runtime = await createLockedAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: manager }, new SessionLockOwner());
  runtimes.push(runtime);
  return { root, cwd, agentDir, manager, runtime, factory, builds, retired, hooks };
}

describe("installed SDK plan mode transitions", () => {
  test("entering and leaving keeps one file and id, and records both durable answers", async () => {
    const f = await fixture();
    const path = f.runtime.session.sessionFile!;
    const id = f.runtime.session.sessionId;
    const before = readFileSync(path);

    const entered = await f.runtime.transitionPlanMode("plan");
    expect(entered.mode).toBe("plan");
    expect(entered.recovered).toBe(false);
    expect(entered.session.sessionFile).toBe(path);
    expect(entered.session.sessionId).toBe(id);
    expect(f.builds.at(-1)!.planMode).toBe(true);
    expect(f.retired).toEqual([1]);
    // Append-only: every original byte is still the file's prefix.
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
    expect(loadPlanRecord(path)?.mode).toBe("plan");
    expect(isPlanModeActive(path, entered.session.sessionManager)).toBe(true);

    const left = await f.runtime.transitionPlanMode("implement");
    expect(left.mode).toBe("implement");
    expect(f.builds.at(-1)!.planMode).toBe(false);
    expect(loadPlanRecord(path)?.mode).toBe("implement");
    expect(isPlanModeActive(path, left.session.sessionManager)).toBe(false);
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true);
  });

  test("a recorded plan survives both transitions", async () => {
    const f = await fixture();
    const path = f.runtime.session.sessionFile!;
    savePlanRecord(path, { version: 1, mode: "implement", text: "step one", at: 1 });
    await f.runtime.transitionPlanMode("plan");
    expect(loadPlanRecord(path)).toMatchObject({ mode: "plan", text: "step one" });
    await f.runtime.transitionPlanMode("implement");
    expect(loadPlanRecord(path)).toMatchObject({ mode: "implement", text: "step one" });
  });

  test("a restart resumes plan mode from the file alone", async () => {
    const f = await fixture();
    const path = f.runtime.session.sessionFile!;
    await f.runtime.transitionPlanMode("plan");
    await f.runtime.dispose();
    runtimes.length = 0;
    const reopened = SessionManager.open(path, join(f.root, "sessions"), f.cwd);
    expect(isPlanModeActive(path, reopened)).toBe(true);
    // Even with the companion gone, the transcript still holds the session.
    savePlanRecord(path, null);
    expect(isPlanModeActive(path, reopened)).toBe(true);
  });

  test("a failed upgrade lands in plan mode instead of a half-upgraded runtime", async () => {
    const f = await fixture();
    const path = f.runtime.session.sessionFile!;
    await f.runtime.transitionPlanMode("plan");
    const buildsBefore = f.builds.length;
    f.hooks.beforeBuild = async (count) => {
      if (count === buildsBefore + 1) throw new Error("replacement runtime failed");
    };
    const result = await f.runtime.transitionPlanMode("implement");
    expect(result.recovered).toBe(true);
    expect(result.mode).toBe("plan");
    expect(f.builds.at(-1)!.planMode).toBe(true);
    expect(loadPlanRecord(path)?.mode).toBe("plan");
    expect(isPlanModeActive(path, result.session.sessionManager)).toBe(true);
    // The abandoned `implement` record is still in the file, and the later
    // `plan` record on the same ancestry is what governs.
    const entries = result.session.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === PLAN_MODE_CUSTOM_TYPE);
    expect(entries.length).toBe(3);
  });

  test("recovery that also fails keeps ownership and reports recovery required", async () => {
    const f = await fixture();
    f.hooks.beforeBuild = async (count) => { if (count > 1) throw new Error("no runtime available"); };
    await expect(f.runtime.transitionPlanMode("plan")).rejects.toThrow("recovery required");
    // Fail closed: no further session work is admitted on this runtime.
    await expect(f.runtime.transitionPlanMode("plan")).rejects.toThrow("recovery required");
  });

  test("a busy runtime refuses the transition without cancelling its work", async () => {
    const f = await fixture();
    const running = f.runtime.session.prompt("keep working");
    await expect(f.runtime.transitionPlanMode("plan")).rejects.toThrow("idle");
    await running;
    const entered = await f.runtime.transitionPlanMode("plan");
    expect(entered.mode).toBe("plan");
  });
});

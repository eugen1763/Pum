import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { QuestionnaireManager } from "../../src/questionnaire";
import { SubagentManager } from "../../src/subagents/manager";
import { createWorktree, listWorktrees } from "../../src/worktree";
import type { SubagentStatus } from "../../src/subagents/types";
import { SandboxController } from "../../src/sandbox";
import { replayEntries } from "../../src/replay";
import { ContextWindowController, CONTEXT_TOOL_NAMES } from "../../src/context-window";

const root = mkdtempSync(join(tmpdir(), "pum-subagent-test-"));
const repo = join(root, "repo");
const agentDir = join(root, "agent");
mkdirSync(repo);
mkdirSync(agentDir);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-b", "main");
git("config", "user.email", "pum@example.test");
git("config", "user.name", "PUM Test");
writeFileSync(join(repo, "README.md"), "test\n");
git("add", "README.md");
git("commit", "-m", "initial");

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!request.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        send({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "Task complete." }, finish_reason: null }],
        });
        send({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    mock: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      api: "openai-completions",
      apiKey: "test",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{
        id: "mock-model",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_000,
        maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
}));
writeFileSync(join(agentDir, "auth.json"), "{}");

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function finishAgent(manager: SubagentManager, id: string, summary: string): Promise<void> {
  const tools = new Map<string, any>();
  (manager as any).childExtension(id).factory({
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
  });
  await tools.get("finish_subagent").execute("finish-test", { summary });
}

function retainAgent(
  manager: SubagentManager,
  id: string,
  worktree: Awaited<ReturnType<typeof createWorktree>>,
  status: SubagentStatus,
  parentAgentId: string | null = null,
): void {
  (manager as any).records.set(id, {
    snapshot: {
      id,
      name: worktree.name,
      task: "integration fixture",
      status,
      worktree,
      parentAgentId,
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      transcript: { lines: [], stream: null, pending: [] },
      startedAt: Date.now(),
      updatedAt: Date.now(),
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
    },
    activityGeneration: 0,
    idleNotifiedGeneration: 0,
  });
  if (status === "completed") {
    (manager as any).settlements.set(`${id}:0:completed`, {
      id: `${id}:0:completed`,
      messageId: `settlement-${id}:0:completed`,
      agentId: id,
      parentAgentId,
      status: "completed",
      activityGeneration: 0,
      content: `Subagent ${worktree.name} completed.`,
      createdAt: Date.now(),
      acknowledgedAt: Date.now(),
    });
  }
}

async function waitUntil(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for subagent state");
}

function createMainBridge(manager: SubagentManager, sessionManager: SessionManager) {
  const deliveries: any[] = [];
  const userMessages: string[] = [];
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const api = {
    on(name: string, handler: (event: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    appendEntry(customType: string, data: unknown) {
      sessionManager.appendCustomEntry(customType, data);
    },
    sendMessage(message: any) {
      deliveries.push(message);
    },
    sendUserMessage(content: string) {
      userMessages.push(content);
    },
  };
  (manager.mainExtension() as { factory: (pi: any) => void }).factory(api);

  return {
    api,
    deliveries,
    userMessages,
    async insert(message: any): Promise<void> {
      sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      for (const handler of handlers.get("message_start") ?? []) {
        await handler({ message: { role: "custom", ...message } });
      }
    },
  };
}

describe("background subagents", () => {
  test("runs questionnaire tools through main and child pi sessions", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const model = runtime.getModel("mock", "mock-model");
    expect(model).toBeDefined();
    const questionnaireManager = new QuestionnaireManager();
    const unsubscribeUi = questionnaireManager.subscribe(() => {});
    const services = await createAgentSessionServices({
      cwd: repo,
      agentDir,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        extensionFactories: [questionnaireManager.extension({ id: "main", name: "main" })],
      },
    });
    const main = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(repo),
      model,
      tools: ["questionnaire"],
    });
    const mainTool = main.session.agent.state.tools.find((tool) => tool.name === "questionnaire")!;
    const mainExecution = mainTool.execute("main-questionnaire", { questions: [{
      id: "scope",
      prompt: "Choose scope",
      options: [{ value: "small", label: "Small" }],
    }] });
    expect(questionnaireManager.current()?.requester).toEqual({ id: "main", name: "main" });
    questionnaireManager.select();
    questionnaireManager.select();
    const mainResult = await mainExecution;
    expect(JSON.parse((mainResult.content[0] as any).text)).toEqual({
      cancelled: false,
      answers: [{ questionId: "scope", value: "small", label: "Small", custom: false }],
    });
    main.session.dispose();

    const manager = new SubagentManager({
      modelRuntime: runtime,
      agentDir,
      questionnaireManager,
    });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    const worktreesBeforeSpawn = await listWorktrees(repo);
    const child = await manager.spawn({
      task: "Wait for questionnaire availability inspection.",
      name: "questionnaire-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    expect(child.usesWorktree).toBe(false);
    expect(child.worktree.path).toBe(repo);
    expect(await listWorktrees(repo)).toEqual(worktreesBeforeSpawn);
    const childSession = (manager as any).records.get(child.id).session;
    const childTool = childSession.agent.state.tools.find((tool: any) => tool.name === "questionnaire");
    expect(childTool).toBeDefined();
    const childTools = childSession.agent.state.tools.map((tool: any) => tool.name);
    expect(childTools).not.toContain("apply_patch");
    for (const name of CONTEXT_TOOL_NAMES) expect(childTools).toContain(name);
    const childExecution = childTool.execute("child-questionnaire", { questions: [{
      id: "format",
      prompt: "Choose format",
      options: [{ value: "json", label: "JSON" }],
    }] });
    expect(questionnaireManager.current()?.requester).toEqual({ id: child.id, name: "questionnaire-child" });
    questionnaireManager.cancel();
    expect(JSON.parse(((await childExecution).content[0] as any).text)).toEqual({
      cancelled: true,
      answers: [],
    });
    await manager.detachMain();
    unsubscribeUi();
  });

  test("internal judge and AFK runtimes omit own-session context schemas", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({
      modelRuntime: runtime,
      agentDir,
      sandboxModeSource: () => "off",
    });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    try {
      const judge = await manager.spawnGoalJudge({
        task: "Wait for judge schema inspection.",
        modelId: "mock/mock-model",
        thinkingLevel: "off",
        onVerdict() {},
      });
      const judgeSession = (manager as any).records.get(judge.id).session;
      expect(judgeSession.agent.state.tools.map((tool: any) => tool.name).sort())
        .toEqual(["bash", "goal_verdict", "read"]);
      await manager.removeGoalJudge(judge.id);

      const afk = await manager.spawnAfkDelegate({
        task: "Wait for AFK schema inspection.",
        modelId: "mock/mock-model",
        thinkingLevel: "off",
        onAnswer() {},
      });
      const afkSession = (manager as any).records.get(afk.id).session;
      expect(afkSession.agent.state.tools.map((tool: any) => tool.name)).toEqual(["afk_answer"]);
      await manager.removeAfkDelegate(afk.id);
    } finally {
      await manager.detachMain();
    }
  });

  test("overrides Bash in main and managed child sessions", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const model = runtime.getModel("mock", "mock-model");
    expect(model).toBeDefined();
    const sandboxExtension = new SandboxController({
      mode: "auto",
      backend: {
        id: process.platform === "win32" ? "mxc" : "bubblewrap",
        probe: async () => ({ state: "unavailable", backend: process.platform === "win32" ? "mxc" : "bubblewrap" }),
        spawn() { throw new Error("not used"); },
      },
    }).extension();
    const services = await createAgentSessionServices({
      cwd: repo,
      agentDir,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [sandboxExtension] },
    });
    const main = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(repo),
      model,
      tools: ["bash"],
    });
    expect(main.session.agent.state.tools.find((tool) => tool.name === "bash")?.description)
      .toContain("native OS sandboxing");
    main.session.dispose();

    const manager = new SubagentManager({
      modelRuntime: runtime,
      agentDir,
      childExtensionFactories: [sandboxExtension],
    });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    const child = await manager.spawn({
      task: "Wait for Bash override inspection.",
      name: "sandbox-bash-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    const childSession = (manager as any).records.get(child.id).session;
    expect(childSession.agent.state.tools.find((tool: any) => tool.name === "bash")?.description)
      .toContain("native OS sandboxing");
    await manager.detachMain();
  });

  test("finish_subagent routes a main-spawned child completion to main", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const sessionManager = SessionManager.inMemory(repo);
    const notices: string[] = [];
    const mainApi = {
      appendEntry(customType: string, data: unknown) {
        sessionManager.appendCustomEntry(customType, data);
      },
      sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }) {
        notices.push(message.content);
        sessionManager.appendCustomMessageEntry(
          message.customType,
          message.content,
          message.display,
          message.details,
        );
      },
    };
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain(mainApi as any, sessionManager, repo);

    const child = await manager.spawn({
      task: "Complete the direct child task.",
      name: "direct-completion-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    await finishAgent(manager, child.id, "Direct child integration summary.");
    await waitUntil(() => manager.getAgent(child.id)?.status === "completed");

    expect(notices.filter((notice) => notice.includes("Subagent direct-completion-child completed."))).toHaveLength(1);
    expect(notices.find((notice) => notice.includes("Subagent direct-completion-child completed."))).toContain(
      "summary: Direct child integration summary.",
    );
    await manager.detachMain();
  });

  test("finish_subagent routes a nested child completion only to its parent", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const sessionManager = SessionManager.inMemory(repo);
    const notices: string[] = [];
    const mainApi = {
      appendEntry(customType: string, data: unknown) {
        sessionManager.appendCustomEntry(customType, data);
      },
      sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }) {
        notices.push(message.content);
        sessionManager.appendCustomMessageEntry(
          message.customType,
          message.content,
          message.display,
          message.details,
        );
      },
    };
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain(mainApi as any, sessionManager, repo);

    const parent = await manager.spawn({
      task: "Wait for a nested child completion.",
      name: "nested-completion-parent",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    await waitUntil(() => manager.getAgent(parent.id)?.status === "idle");
    notices.length = 0;

    const child = await manager.spawn({
      task: "Complete the nested child task.",
      name: "nested-completion-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      parentAgentId: parent.id,
    });
    await finishAgent(manager, child.id, "Nested child integration summary.");
    await waitUntil(() => manager.getAgent(child.id)?.status === "completed");
    await waitUntil(() => manager.getAgent(parent.id)?.transcript.lines.some(
      (line) => line.kind === "agent-message"
        && line.sender === "nested-completion-child"
        && line.text.includes("Subagent nested-completion-child completed."),
    ) === true);

    expect(manager.getAgent(child.id)?.parentAgentId).toBe(parent.id);
    expect(manager.getAgent(parent.id)?.transcript.lines.some(
      (line) => line.kind === "agent-message"
        && line.text.includes("summary: Nested child integration summary."),
    )).toBe(true);
    expect(notices.some((notice) => notice.includes("Subagent nested-completion-child"))).toBe(false);
    await manager.detachMain();
  });

  test("spawn returns before completion and notifies the main bridge", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    const parent = SessionManager.inMemory(repo);
    const mainBridge = createMainBridge(manager, parent);
    await manager.attachMain(mainBridge.api as any, parent, repo);

    const started = Date.now();
    const spawned = await manager.spawn({
      task: "Return a short completion message.",
      name: "integration-agent",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      createWorktree: true,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(["starting", "running", "idle"]).toContain(spawned.status);
    expect(spawned.forkOrigin).toBeUndefined();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && mainBridge.deliveries.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mainBridge.deliveries[0].content).toContain("Subagent integration-agent idle.");
    expect(manager.getAgent(spawned.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.role === "assistant" && line.text.includes("Task complete"),
    )).toBe(true);
    expect(manager.getAgent(spawned.id)?.usage).toMatchObject({
      outgoing: 10,
      incoming: 3,
      cacheRead: 0,
      contextPct: 0,
    });

    const peer = await manager.spawn({
      task: "Wait for messages.",
      name: "integration-peer",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    const peerDeadline = Date.now() + 5_000;
    while (Date.now() < peerDeadline && manager.getAgent(peer.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const peerAnswersBefore = manager.getAgent(peer.id)?.transcript.lines.filter(
      (line) => line.kind === "text" && line.role === "assistant",
    ).length ?? 0;
    await manager.routeMessage(spawned.id, peer.id, "Review the completed task.");
    expect(manager.getAgent(peer.id)?.transcript.pending.some(
      (pending) => pending.line.kind === "agent-message" && pending.line.sender === "integration-agent",
    )).toBe(true);
    const messageDeadline = Date.now() + 5_000;
    while (Date.now() < messageDeadline && manager.getAgent(peer.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(manager.getAgent(peer.id)?.transcript.lines.filter(
      (line) => line.kind === "text" && line.role === "assistant",
    ).length).toBe(peerAnswersBefore + 1);
    expect(manager.getAgent(peer.id)?.transcript.pending).toEqual([]);
    expect(manager.getAgent(spawned.id)?.transcript.lines.some(
      (line) => line.kind === "agent-message" && line.recipient === "integration-peer",
    )).toBe(true);
    expect(manager.getAgent(peer.id)?.transcript.lines.some(
      (line) => line.kind === "agent-message" && line.sender === "integration-agent",
    )).toBe(true);

    await manager.routeMessage(spawned.id, "main", "The peer review has started.");
    expect(mainBridge.deliveries.some((message) => message.content.includes("Message from integration-agent"))).toBe(true);

    expect(mainBridge.userMessages).toEqual([]);

    await manager.sendUserMessage(spawned.id, "Prepare the final completion report.");
    await finishAgent(manager, spawned.id, "Integration agent completed successfully.");
    await waitUntil(() => manager.getAgent(spawned.id)?.status === "completed");
    const completion = mainBridge.deliveries.find(
      (message) => message.details?.kind === "completion" && message.details?.sender === "integration-agent",
    );
    expect(completion?.content).toContain("Subagent integration-agent completed.");
    await expect((manager as any).worktreeAction(repo, "merge", spawned.id))
      .rejects.toThrow("before its completion notice arrives");
    await mainBridge.insert(completion);
    const merged = await (manager as any).worktreeAction(repo, "merge", spawned.id);
    expect(merged.content[0].text).toContain("Closed integration-agent and removed its worktree");
    expect(manager.getAgent(spawned.id)).toBeUndefined();
    expect(existsSync(spawned.worktree.path)).toBe(false);

    const peerUsage = manager.getAgent(peer.id)?.usage;
    await manager.detachMain();

    const restoredManager = new SubagentManager({ modelRuntime: runtime, agentDir });
    const restoredBridge = createMainBridge(restoredManager, parent);
    await restoredManager.attachMain(restoredBridge.api as any, parent, repo);
    expect(restoredManager.getAgent(peer.id)?.usage).toEqual(peerUsage);
    await restoredManager.detachMain();
  });

  test("retries one stable idle settlement after a manager restart", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const parent = SessionManager.inMemory(repo);
    const firstManager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await firstManager.attachMain({
      appendEntry(customType: string, data: unknown) {
        parent.appendCustomEntry(customType, data);
      },
      sendMessage() {
        throw new Error("main queue unavailable");
      },
    } as any, parent, repo);

    const child = await firstManager.spawn({
      task: "Return to idle for restart delivery testing.",
      name: "restart-idle-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      createWorktree: true,
    });
    await waitUntil(() => firstManager.getAgent(child.id)?.status === "idle");
    const settlementBeforeRestart = parent.getEntries()
      .filter((entry: any) => entry.type === "custom" && entry.customType === "pum.subagent")
      .map((entry: any) => entry.data)
      .find((event: any) => event.event === "settlement" && event.settlement?.agentId === child.id);
    expect(settlementBeforeRestart.settlement.acknowledgedAt).toBeUndefined();
    await firstManager.detachMain();

    const deliveries: any[] = [];
    const restored = new SubagentManager({ modelRuntime: runtime, agentDir });
    await restored.attachMain({
      appendEntry(customType: string, data: unknown) {
        parent.appendCustomEntry(customType, data);
      },
      sendMessage(message: any) {
        deliveries.push(message);
      },
    } as any, parent, repo);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].details.id).toBe(settlementBeforeRestart.settlement.messageId);
    await (restored as any).retrySettlementsForParent(null);
    expect(deliveries).toHaveLength(1);

    await expect((restored as any).worktreeAction(repo, "merge", child.id))
      .rejects.toThrow("while its authoritative status is idle");
    await (restored as any).worktreeAction(repo, "remove", child.id);
    await restored.detachMain();
  });

  test("retries one stable completion after restart before delayed insertion", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const parent = SessionManager.inMemory(repo);
    const delayedBeforeRestart: any[] = [];
    const firstManager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await firstManager.attachMain({
      appendEntry(customType: string, data: unknown) {
        parent.appendCustomEntry(customType, data);
      },
      sendMessage(message: any) {
        delayedBeforeRestart.push(message);
      },
    } as any, parent, repo);

    const child = await firstManager.spawn({
      task: "Complete before delayed settlement insertion.",
      name: "restart-completion-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      createWorktree: true,
    });
    await finishAgent(firstManager, child.id, "Crash-window completion summary.");
    await waitUntil(() => firstManager.getAgent(child.id)?.status === "completed");

    const completionBeforeRestart = delayedBeforeRestart.find(
      (message) => message.details?.kind === "completion",
    );
    expect(completionBeforeRestart).toBeDefined();
    const persistedSettlement = parent.getEntries()
      .filter((entry: any) => entry.type === "custom" && entry.customType === "pum.subagent")
      .map((entry: any) => entry.data)
      .find((event: any) =>
        event.event === "settlement"
          && event.settlement?.agentId === child.id
          && event.settlement?.status === "completed",
      );
    expect(persistedSettlement.settlement.messageId).toBe(completionBeforeRestart.details.id);
    expect(persistedSettlement.settlement.acknowledgedAt).toBeUndefined();
    expect(parent.getEntries().some(
      (entry: any) => entry.type === "custom_message" && entry.details?.id === completionBeforeRestart.details.id,
    )).toBe(false);
    await firstManager.detachMain();

    const retries: any[] = [];
    const restored = new SubagentManager({ modelRuntime: runtime, agentDir });
    await restored.attachMain({
      appendEntry(customType: string, data: unknown) {
        parent.appendCustomEntry(customType, data);
      },
      sendMessage(message: any) {
        retries.push(message);
      },
    } as any, parent, repo);
    await (restored as any).retrySettlementsForParent(null);
    await (restored as any).retrySettlementsForParent(null);

    const completionRetries = retries.filter((message) => message.details?.kind === "completion");
    expect(completionRetries).toHaveLength(1);
    expect(completionRetries[0].details.id).toBe(completionBeforeRestart.details.id);

    parent.appendCustomMessageEntry(
      completionRetries[0].customType,
      completionRetries[0].content,
      completionRetries[0].display,
      completionRetries[0].details,
    );
    await (restored as any).retrySettlementsForParent(null);

    expect(retries.filter((message) => message.details?.kind === "completion")).toHaveLength(1);
    const replayedCompletion = replayEntries(parent.buildContextEntries(), repo, true).filter(
      (line) => line.kind === "agent-message" && line.text.includes("Subagent restart-completion-child completed."),
    );
    expect(replayedCompletion).toHaveLength(1);
    const acknowledgedSettlement = parent.getEntries()
      .filter((entry: any) => entry.type === "custom" && entry.customType === "pum.subagent")
      .map((entry: any) => entry.data)
      .filter((event: any) =>
        event.event === "settlement"
          && event.settlement?.messageId === completionRetries[0].details.id,
      )
      .at(-1);
    expect(acknowledgedSettlement.settlement.acknowledgedAt).toBeNumber();

    await (restored as any).worktreeAction(repo, "merge", child.id);
    await restored.detachMain();
  });

  test("closes a retained hierarchy deepest first without unrelated blockers", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    const parentWorktree = await createWorktree(repo, "recursive-parent");
    const childWorktree = await createWorktree(repo, "recursive-child");
    const grandchildWorktree = await createWorktree(repo, "recursive-grandchild");
    const unrelatedWorktree = await createWorktree(repo, "recursive-unrelated");
    retainAgent(manager, "recursive-parent-id", parentWorktree, "completed");
    retainAgent(manager, "recursive-child-id", childWorktree, "completed", "recursive-parent-id");
    retainAgent(manager, "recursive-grandchild-id", grandchildWorktree, "failed", "recursive-child-id");
    retainAgent(manager, "recursive-unrelated-id", unrelatedWorktree, "interrupted");

    await expect((manager as any).worktreeAction(repo, "merge", "recursive-parent-id"))
      .rejects.toThrow("- recursive-grandchild (failed)\n- recursive-child (completed)");

    const parentTools = new Map<string, any>();
    (manager as any).childExtension("recursive-child-id").factory({
      on() {},
      registerTool(tool: any) { parentTools.set(tool.name, tool); },
    });
    await expect(parentTools.get("worktree").execute("nested-merge", {
      action: "merge",
      target: "recursive-grandchild-id",
    })).rejects.toThrow("while its authoritative status is failed");
    await parentTools.get("worktree").execute("nested-remove", {
      action: "remove",
      target: "recursive-grandchild-id",
    });
    expect(manager.getAgent("recursive-grandchild-id")).toBeUndefined();

    await (manager as any).worktreeAction(repo, "merge", "recursive-child-id");
    await (manager as any).worktreeAction(repo, "merge", "recursive-parent-id");
    expect(manager.getAgent("recursive-child-id")).toBeUndefined();
    expect(manager.getAgent("recursive-parent-id")).toBeUndefined();
    expect(manager.getAgent("recursive-unrelated-id")).toBeDefined();

    await expect((manager as any).worktreeAction(repo, "merge", "recursive-unrelated-id"))
      .rejects.toThrow("while its authoritative status is interrupted");
    await (manager as any).worktreeAction(repo, "remove", "recursive-unrelated-id");
    await manager.detachMain();
  }, 20_000);

  test("serializes concurrent spawns against a custom active limit", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir, maxActiveSubagents: 1 });
    const parent = SessionManager.inMemory(repo);
    const mainBridge = createMainBridge(manager, parent);
    await manager.attachMain(mainBridge.api as any, parent, repo);
    const attempts = await Promise.allSettled([
      manager.spawn({ task: "First race task.", name: "capacity-race-first", modelId: "mock/mock-model", thinkingLevel: "off", createWorktree: true }),
      manager.spawn({ task: "Second race task.", name: "capacity-race-second", modelId: "mock/mock-model", thinkingLevel: "off", createWorktree: true }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(String((attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult).reason))
      .toContain("All 1 subagent slots are active");
    const retained = manager.getAgents()[0]!;
    await waitUntil(() => !["starting", "running"].includes(manager.getAgent(retained.id)?.status ?? ""));
    await manager.sendUserMessage(retained.id, "Prepare the final completion report.");
    await finishAgent(manager, retained.id, "Capacity race winner completed.");
    await waitUntil(() => manager.getAgent(retained.id)?.status === "completed");
    const completion = mainBridge.deliveries.find(
      (message) => message.details?.kind === "completion" && message.details?.sender === retained.name,
    );
    expect(completion).toBeDefined();
    await expect((manager as any).worktreeAction(repo, "merge", retained.id))
      .rejects.toThrow("before its completion notice arrives");
    await mainBridge.insert(completion);
    await (manager as any).worktreeAction(repo, "merge", retained.id);
    await manager.detachMain();
  });

  test("forks main and nested conversations while keeping child transcripts local", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const source = SessionManager.inMemory(repo);
    source.appendMessage({ role: "user", content: "Earlier main request", timestamp: 1 } as any);
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Earlier main response" }],
      api: "mock",
      provider: "mock",
      model: "mock-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      stopReason: "stop",
      timestamp: 2,
    } as any);
    const cutoff = source.appendMessage({ role: "user", content: "Current main request", timestamp: 3 } as any);
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    const mainBridge = createMainBridge(manager, source);
    await manager.attachMain(mainBridge.api as any, source, repo);

    const parent = await manager.spawn({
      task: "Parent fork task",
      name: "fork-main-parent",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      context: "fork",
    });
    await waitUntil(() => manager.getAgent(parent.id)?.status === "idle");
    const parentRecord = (manager as any).records.get(parent.id);
    const parentText = replayEntries(parentRecord.session.sessionManager.getBranch(), repo, true)
      .filter((line) => line.kind === "text")
      .map((line: any) => line.text);
    expect(parentText).toEqual([
      "Earlier main request",
      "Earlier main response",
      "Current main request",
      "Parent fork task",
      "Task complete.",
    ]);
    expect(manager.getAgent(parent.id)?.forkOrigin).toEqual({
      sourceSessionId: source.getSessionId(),
      cutoffEntryId: cutoff,
      sourceAgentId: null,
    });
    expect(manager.getAgent(parent.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.text === "Earlier main request",
    )).toBe(false);

    const child = await manager.spawn({
      task: "Nested fork task",
      name: "fork-nested-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      parentAgentId: parent.id,
      context: "fork",
    });
    await waitUntil(() => manager.getAgent(child.id)?.status === "idle");
    const childRecord = (manager as any).records.get(child.id);
    const childText = replayEntries(childRecord.session.sessionManager.getBranch(), repo, true)
      .filter((line) => line.kind === "text")
      .map((line: any) => line.text);
    expect(childText).toEqual([...parentText, "Nested fork task", "Task complete."]);
    expect(manager.getAgent(child.id)?.forkOrigin?.sourceSessionId).toBe(parentRecord.session.sessionId);
    expect(manager.getAgent(child.id)?.forkOrigin?.sourceAgentId).toBe(parent.id);
    expect(manager.getAgent(child.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.text === "Parent fork task",
    )).toBe(false);
    await manager.detachMain();

    const resumed = new SubagentManager({ modelRuntime: runtime, agentDir });
    await resumed.attachMain({
      appendEntry(customType: string, data: unknown) {
        source.appendCustomEntry(customType, data);
      },
      sendMessage() {},
    } as any, source, repo);
    expect(resumed.getAgent(parent.id)?.forkOrigin?.cutoffEntryId).toBe(cutoff);
    expect(resumed.getAgent(parent.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.text === "Earlier main request",
    )).toBe(false);
    expect(resumed.getAgent(parent.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.text === "Parent fork task",
    )).toBe(true);
    expect(resumed.getAgent(child.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.text === "Parent fork task",
    )).toBe(false);
    expect(resumed.getAgent(child.id)?.transcript.lines.some(
      (line) => line.kind === "text" && line.text === "Nested fork task",
    )).toBe(true);
    await resumed.detachMain();
  });

  test("removes the new worktree and registry record when exact fork creation fails", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir });
    const source = SessionManager.inMemory(repo);
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, source, repo);
    const before = await listWorktrees(repo);
    await expect(manager.spawn({
      task: "This fork must fail",
      name: "invalid-fork-cleanup",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      context: "fork",
      createWorktree: true,
      forkSource: {
        origin: { sourceSessionId: "source", cutoffEntryId: "missing", sourceAgentId: null },
        entries: [],
      },
    })).rejects.toThrow("captured active branch does not match");
    expect(manager.getAgents()).toEqual([]);
    expect((await listWorktrees(repo)).map((record) => record.name))
      .toEqual(before.map((record) => record.name));
    await manager.detachMain();
  });

  test("rejects a descendant spawn queued behind successful parent closure", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    const parentWorktree = await createWorktree(repo, "closure-race-parent");
    retainAgent(manager, "closure-race-parent-id", parentWorktree, "completed");

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const held = (manager as any).withWorktreeLock(async () => {
      entered();
      await gate;
    });
    await lockEntered;
    const merge = (manager as any).worktreeAction(repo, "merge", "closure-race-parent-id");
    const spawn = manager.spawn({
      task: "A descendant that must not become orphaned.",
      name: "closure-race-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      parentAgentId: "closure-race-parent-id",
    });
    release();
    await held;
    await merge;
    await expect(spawn).rejects.toThrow("Spawner subagent no longer exists");
    expect(manager.getAgents()).toEqual([]);
    expect(existsSync(join(repo, ".pum", "worktrees", "closure-race-child"))).toBe(false);
    await manager.detachMain();
  });
  test("keeps completed status and merge authorization after a failed removal", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    const worktree = await createWorktree(repo, "failed-remove-agent");
    const inWorktree = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree.path, encoding: "utf8" });
    inWorktree("config", "user.email", "pum@example.test");
    inWorktree("config", "user.name", "PUM Test");
    writeFileSync(join(worktree.path, "failed-remove.txt"), "work\n");
    inWorktree("add", "failed-remove.txt");
    inWorktree("commit", "-m", "unmerged work");
    retainAgent(manager, "failed-remove-id", worktree, "completed");

    await expect((manager as any).worktreeAction(repo, "remove", "failed-remove-id"))
      .rejects.toThrow(`Branch ${worktree.branch} is not merged`);
    expect(manager.getAgent("failed-remove-id")?.status).toBe("completed");

    const merged = await (manager as any).worktreeAction(repo, "merge", "failed-remove-id");
    expect(merged.content[0].text).toContain("Closed failed-remove-agent");
    expect(manager.getAgent("failed-remove-id")).toBeUndefined();
    expect(existsSync(worktree.path)).toBe(false);
    await manager.detachMain();
  });

  test("retains a spawn that fails runtime setup across a resume", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const parent = SessionManager.inMemory(repo);
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({
      appendEntry(customType: string, data: unknown) { parent.appendCustomEntry(customType, data); },
      sendMessage() {},
    } as any, parent, repo);

    await expect(manager.spawn({
      task: "Fail during runtime setup.",
      name: "failed-setup-agent",
      modelId: "mock/missing-model",
      thinkingLevel: "off",
    })).rejects.toThrow("Model is unavailable");
    const failed = manager.getAgents().find((agent) => agent.name === "failed-setup-agent");
    expect(failed?.status).toBe("failed");
    const events = parent.getEntries()
      .filter((entry: any) => entry.type === "custom" && entry.customType === "pum.subagent")
      .map((entry: any) => entry.data)
      .filter((event: any) => event.id === failed!.id);
    expect(events.map((event: any) => event.event)).toEqual(["spawned", "status"]);
    await manager.detachMain();

    const restored = new SubagentManager({ modelRuntime: runtime, agentDir });
    await restored.attachMain({
      appendEntry(customType: string, data: unknown) { parent.appendCustomEntry(customType, data); },
      sendMessage() {},
    } as any, parent, repo);
    expect(restored.getAgent(failed!.id)?.status).toBe("failed");
    expect(restored.getAgent(failed!.id)?.name).toBe("failed-setup-agent");
    await (restored as any).worktreeAction(repo, "remove", failed!.id);
    expect(restored.getAgent(failed!.id)).toBeUndefined();
    await restored.detachMain();
  });

  test("disposes an unattached session on context binding failure and preserves the original error", async () => {
    const { SessionLockOwner } = await import("../../src/session-lock");
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({ appendEntry() {}, sendMessage() {} } as any, SessionManager.inMemory(repo), repo);
    const bindingError = new Error("Invalid persisted context marker");
    let disposed = 0;
    let sessionFile: string | undefined;
    const binding = spyOn(ContextWindowController.prototype, "bind").mockImplementation((session) => {
      sessionFile = session.sessionFile;
      const dispose = session.dispose.bind(session);
      session.dispose = () => {
        disposed += 1;
        dispose();
        throw new Error("Secondary disposal error");
      };
      throw bindingError;
    });
    try {
      await expect(manager.spawn({
        task: "Fail while binding context.",
        name: "failed-context-binding",
        modelId: "mock/mock-model",
        thinkingLevel: "off",
      })).rejects.toBe(bindingError);
      expect(disposed).toBe(1);
      expect(sessionFile).toBeDefined();
      // The outer setup catch still releases ownership after disposal fails.
      new SessionLockOwner().acquire(sessionFile)();
    } finally {
      binding.mockRestore();
      await manager.detachMain();
    }
  });

  test("discards a goal judge when runtime setup fails", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const parent = SessionManager.inMemory(repo);
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({
      appendEntry(customType: string, data: unknown) { parent.appendCustomEntry(customType, data); },
      sendMessage() {},
    } as any, parent, repo);

    await expect(manager.spawnGoalJudge({
      task: "Review the goal.",
      modelId: "mock/missing-model",
      thinkingLevel: "off",
      onVerdict() {},
    })).rejects.toThrow("Model is unavailable");

    expect(manager.getAgents()).toEqual([]);
    const events = parent.getEntries()
      .filter((entry: any) => entry.type === "custom" && entry.customType === "pum.subagent")
      .map((entry: any) => entry.data.event);
    expect(events).toContain("removed");
    await manager.detachMain();
  });

  test("builds one child runtime for concurrent callers", async () => {
    const { SessionLockOwner, SessionLockedError } = await import("../../src/session-lock");
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const parent = SessionManager.inMemory(repo);
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain({
      appendEntry(customType: string, data: unknown) { parent.appendCustomEntry(customType, data); },
      sendMessage() {},
    } as any, parent, repo);
    const child = await manager.spawn({
      task: "Return to idle before the concurrent restart.",
      name: "single-runtime-child",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    await waitUntil(() => manager.getAgent(child.id)?.status === "idle");
    await manager.stop(child.id, "stopped");
    const record = (manager as any).records.get(child.id);
    expect(record.session).toBeUndefined();
    const release = new SessionLockOwner().acquire(record.snapshot.sessionFile);
    await expect((manager as any).ensureRuntime(record)).rejects.toBeInstanceOf(SessionLockedError);
    expect(record.session).toBeUndefined();
    release();
    const spawnedBefore = parent.getEntries().filter((entry: any) =>
      entry.type === "custom" && entry.customType === "pum.subagent"
        && entry.data?.event === "spawned" && entry.data?.id === child.id).length;

    await Promise.all([
      (manager as any).ensureRuntime(record),
      (manager as any).ensureRuntime(record),
    ]);
    const spawnedAfter = parent.getEntries().filter((entry: any) =>
      entry.type === "custom" && entry.customType === "pum.subagent"
        && entry.data?.event === "spawned" && entry.data?.id === child.id).length;

    expect(record.session).toBeDefined();
    expect(spawnedAfter - spawnedBefore).toBe(1);
    expect(() => new SessionLockOwner().acquire(record.snapshot.sessionFile)).toThrow(SessionLockedError);
    await manager.detachMain();
    new SessionLockOwner().acquire(record.snapshot.sessionFile)();
  });
});

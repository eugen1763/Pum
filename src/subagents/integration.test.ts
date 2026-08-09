import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./manager";

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

describe("background subagents", () => {
  test("spawn returns before completion and notifies the main bridge", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const parent = SessionManager.inMemory(repo);
    const notices: string[] = [];
    const wakeMessages: string[] = [];
    const mainApi = {
      appendEntry(customType: string, data: unknown) {
        parent.appendCustomEntry(customType, data);
      },
      sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }) {
        notices.push(message.content);
        parent.appendCustomMessageEntry(
          message.customType,
          message.content,
          message.display,
          message.details,
        );
      },
      sendUserMessage(content: string) {
        wakeMessages.push(content);
      },
    };
    const manager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await manager.attachMain(mainApi as any, parent, repo);

    const started = Date.now();
    const spawned = await manager.spawn({
      task: "Return a short completion message.",
      name: "integration-agent",
      modelId: "mock/mock-model",
      thinkingLevel: "off",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(["starting", "running", "idle"]).toContain(spawned.status);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && notices.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(notices[0]).toContain("Subagent integration-agent idle.");
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
    expect(notices.some((notice) => notice.includes("Message from integration-agent"))).toBe(true);

    expect(wakeMessages).toEqual([]);

    const merged = await (manager as any).worktreeAction(repo, "merge", spawned.id);
    expect(merged.content[0].text).toContain("Closed integration-agent and removed its worktree");
    expect(manager.getAgent(spawned.id)).toBeUndefined();
    expect(existsSync(spawned.worktree.path)).toBe(false);

    const peerUsage = manager.getAgent(peer.id)?.usage;
    await manager.detachMain();

    const restoredManager = new SubagentManager({ modelRuntime: runtime, agentDir });
    await restoredManager.attachMain(mainApi as any, parent, repo);
    expect(restoredManager.getAgent(peer.id)?.usage).toEqual(peerUsage);
    await restoredManager.detachMain();
  });
});

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { bindFileCheckpointSession, checkpointControllerForSession, createFileCheckpointExtension } from "../src/file-checkpoints";
import { filesystemSandboxExtension } from "../src/filesystem-sandbox";

const root = mkdtempSync(join(tmpdir(), "pum-checkpoint-sdk-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
mkdirSync(cwd); mkdirSync(agentDir);
const sessions: AgentSession[] = [];
afterAll(() => { for (const session of sessions) session.dispose(); rmSync(root, { recursive: true, force: true }); });
const model: Model<"openai-completions"> = {
  id: "checkpoint", name: "checkpoint", provider: "checkpoint", api: "openai-completions", baseUrl: "https://unused.invalid",
  reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
async function fixture(file?: string) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.hasConfiguredAuth = (provider) => provider === model.provider;
  const manager = file ? SessionManager.open(file, join(root, "sessions")) : SessionManager.create(cwd, join(root, "sessions"));
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [filesystemSandboxExtension, createFileCheckpointExtension()] },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: ["write", "edit"] });
  sessions.push(session);
  bindFileCheckpointSession(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const replies: AssistantMessage["content"][] = [];
  session.agent.streamFunction = () => {
    const content = replies.shift();
    if (!content) throw new Error("Unexpected model request");
    const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: stopReason, message: {
      role: "assistant", content, provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
    return stream;
  };
  return { session, manager, replies, errors };
}

test("installed SDK captures parallel native edits, excludes preimages from JSONL and disposes on resume", async () => {
  const path = join(cwd, "sdk.txt");
  const privatePreimage = "PREIMAGE_ONLY_7f31cde9\r\n";
  writeFileSync(path, privatePreimage);
  const first = await fixture();
  const controller = checkpointControllerForSession(first.session.sessionId)!;
  expect(controller).toBeDefined();
  first.replies.push([
    { type: "toolCall", id: "write-a", name: "write", arguments: { path: "sdk.txt", content: "A\r\n" } },
    { type: "toolCall", id: "write-b", name: "write", arguments: { path: "sdk.txt", content: "B\r\n" } },
  ], [{ type: "toolCall", id: "edit-c", name: "edit", arguments: { path: "sdk.txt", oldText: "B", newText: "C" } }],
  [{ type: "text", text: "Done." }]);
  await first.session.prompt("Execute the fixture.");
  expect(first.errors).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("C\r\n");
  expect(controller.list()).toHaveLength(3);
  const copied = await controller.recover(controller.list()[2]!.id);
  expect(readFileSync(copied, "utf8")).toBe("B\r\n");
  expect(readFileSync(path, "utf8")).toBe("C\r\n");
  const file = first.manager.getSessionFile()!;
  expect(readFileSync(file, "utf8")).not.toContain(privatePreimage.trim());
  expect(readFileSync(file, "utf8")).not.toContain(copied);
  const results = first.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
  expect(results).toHaveLength(3);
  expect(JSON.stringify(results[2])).toContain('"patch"');
  first.session.dispose();
  expect(checkpointControllerForSession(first.session.sessionId)).toBeUndefined();
  expect(controller.list()).toEqual([]);
  const resumed = await fixture(file);
  expect(resumed.session.sessionId).toBe(first.session.sessionId);
  expect(checkpointControllerForSession(resumed.session.sessionId)!.list()).toEqual([]);
  expect(resumed.manager.getEntries()).toHaveLength(first.manager.getEntries().length);
});

test("installed sandbox preflight blocks a file tool before checkpoint execution", async () => {
  const run = await fixture();
  run.replies.push([{ type: "toolCall", id: "denied", name: "write", arguments: { path: "../outside.txt", content: "bad" } }],
    [{ type: "text", text: "Stopped." }]);
  await run.session.prompt("Execute denied fixture.");
  expect(checkpointControllerForSession(run.session.sessionId)!.list()).toEqual([]);
  const result = run.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
  expect(result?.type === "message" && result.message.role === "toolResult" && result.message.isError).toBe(true);
});

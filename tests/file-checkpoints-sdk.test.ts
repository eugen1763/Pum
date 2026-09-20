import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ModelRuntime,
  type AgentSession, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { bindFileCheckpointSession, checkpointControllerForSession, createFileCheckpointExtension } from "../src/file-checkpoints";
import { filesystemSandboxExtension } from "../src/filesystem-sandbox";
import { bindCheckModeApprovalSession, getCheckModeConfig, setCheckModeConfig } from "../src/check-mode";
import { bindRuntimeSettingsActivity } from "../src/runtime-settings";

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
async function fixture(file?: string, extensions: InlineExtension[] = [], checkpoints = true) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.hasConfiguredAuth = (provider) => provider === model.provider;
  const manager = file ? SessionManager.open(file, join(root, "sessions")) : SessionManager.create(cwd, join(root, "sessions"));
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [filesystemSandboxExtension, createFileCheckpointExtension({ checkpoints }), ...extensions] },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: ["read", "write", "edit"] });
  sessions.push(session);
  bindFileCheckpointSession(session);
  bindRuntimeSettingsActivity(session);
  bindCheckModeApprovalSession(session);
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

test("installed SDK rejects parallel stale writes, excludes preimages from JSONL and disposes on resume", async () => {
  const path = join(cwd, "sdk.txt");
  const privatePreimage = "PREIMAGE_ONLY_7f31cde9\r\n";
  writeFileSync(path, privatePreimage);
  const first = await fixture();
  const controller = checkpointControllerForSession(first.session.sessionId)!;
  expect(controller).toBeDefined();
  first.replies.push([
    { type: "toolCall", id: "write-a", name: "write", arguments: { path: "sdk.txt", content: "A\r\n" } },
    { type: "toolCall", id: "write-b", name: "write", arguments: { path: "sdk.txt", content: "B\r\n" } },
  ], [{ type: "toolCall", id: "edit-c", name: "edit", arguments: { path: "sdk.txt", oldText: "A", newText: "C" } }],
  [{ type: "text", text: "Done." }]);
  await first.session.prompt("Execute the fixture.");
  expect(first.errors).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("C\r\n");
  expect(controller.list()).toHaveLength(2);
  const copied = await controller.recover(controller.list()[1]!.id);
  expect(readFileSync(copied, "utf8")).toBe("A\r\n");
  expect(readFileSync(path, "utf8")).toBe("C\r\n");
  const file = first.manager.getSessionFile()!;
  expect(readFileSync(file, "utf8")).not.toContain(privatePreimage.trim());
  expect(readFileSync(file, "utf8")).not.toContain(copied);
  const results = first.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
  expect(results).toHaveLength(3);
  expect(JSON.stringify(results[1])).toContain("File mutation conflict");
  expect(JSON.stringify(results[2])).toContain('"patch"');
  first.session.dispose();
  expect(checkpointControllerForSession(first.session.sessionId)).toBeUndefined();
  expect(controller.list()).toEqual([]);
  const resumed = await fixture(file);
  expect(resumed.session.sessionId).toBe(first.session.sessionId);
  expect(checkpointControllerForSession(resumed.session.sessionId)!.list()).toEqual([]);
  expect(resumed.manager.getEntries()).toHaveLength(first.manager.getEntries().length);
});

test("installed main and worker runtimes keep independent read baselines", async () => {
  const path = join(cwd, "shared-sdk.txt");
  writeFileSync(path, "alpha\nbeta\n");
  const main = await fixture(), worker = await fixture();
  for (const runtime of [main, worker]) {
    runtime.replies.push([{ type: "toolCall", id: "read-shared", name: "read", arguments: { path } }], [{ type: "text", text: "Read." }]);
    await runtime.session.prompt("Read the shared file.");
  }
  main.replies.push([{ type: "toolCall", id: "main-edit", name: "edit", arguments: { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] } }], [{ type: "text", text: "Edited." }]);
  await main.session.prompt("Edit alpha.");
  worker.replies.push([{ type: "toolCall", id: "stale-write", name: "write", arguments: { path, content: "old worker replacement" } }],
    [{ type: "toolCall", id: "safe-edit", name: "edit", arguments: { path, edits: [{ oldText: "beta", newText: "BETA" }] } }], [{ type: "text", text: "Done." }]);
  await worker.session.prompt("Try stale write then a disjoint edit.");
  expect(readFileSync(path, "utf8")).toBe("ALPHA\nBETA\n");
  const entries = JSON.stringify(worker.manager.getEntries());
  expect(entries).toContain("File mutation conflict");
  expect(entries).toContain("preserved those other changes");
  expect(checkpointControllerForSession(worker.session.sessionId)!.list()).toHaveLength(1);
  expect(main.errors).toEqual([]); expect(worker.errors).toEqual([]);
});

for (const checkpoints of [true, false]) test(`installed async preflight cannot refresh a stale proposal (checkpoints=${checkpoints})`, async () => {
  const path = join(cwd, `preflight-${checkpoints}.txt`);
  writeFileSync(path, "before");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = await fixture(undefined, [{ name: "delayed-review", factory(pi) {
    pi.on("tool_call", async (event) => { if (event.toolName === "write") { enter(); await gate; } });
  } }], checkpoints);
  run.replies.push([{ type: "toolCall", id: "delayed-write", name: "write", arguments: { path, content: "stale" } }], [{ type: "text", text: "Stopped." }]);
  const prompt = run.session.prompt("Write after review.");
  await entered;
  writeFileSync(path, "external user change during review");
  release(); await prompt;
  expect(readFileSync(path, "utf8")).toBe("external user change during review");
  expect(JSON.stringify(run.manager.getEntries())).toContain("File mutation conflict");
  expect(checkpointControllerForSession(run.session.sessionId)!.list()).toEqual([]);
  expect(run.errors).toEqual([]);
});

test("guarded file definitions retain execution-time security epoch enforcement", async () => {
  const previous = getCheckModeConfig();
  setCheckModeConfig({ profile: "off", model: "unavailable/test" });
  const path = join(cwd, "epoch-guard.txt"); writeFileSync(path, "before");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = await fixture(undefined, [{ name: "epoch-gate", factory(pi) { pi.on("tool_call", async (event) => {
    if (event.toolName === "read") { enter(); await gate; }
  }); } }]);
  run.replies.push([
    { type: "toolCall", id: "earlier-write", name: "write", arguments: { path, content: "must not write" } },
    { type: "toolCall", id: "later-read", name: "read", arguments: { path } },
  ], [{ type: "text", text: "Stopped." }]);
  try {
    const prompt = run.session.prompt("Prepare then tighten policy.");
    await entered;
    setCheckModeConfig({ profile: "on", model: "unavailable/test" });
    release(); await prompt;
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(JSON.stringify(run.manager.getEntries())).toContain("earlier approval is invalid");
    expect(checkpointControllerForSession(run.session.sessionId)!.list()).toEqual([]);
  } finally { release(); setCheckModeConfig(previous); }
});

test("headless-style registration guards mutations without retaining checkpoints", async () => {
  const path = join(cwd, "headless-style.txt"); writeFileSync(path, "before");
  const run = await fixture(undefined, [], false);
  run.replies.push([{ type: "toolCall", id: "write-headless", name: "write", arguments: { path, content: "after" } }], [{ type: "text", text: "Done." }]);
  await run.session.prompt("Write the file.");
  expect(readFileSync(path, "utf8")).toBe("after");
  expect(checkpointControllerForSession(run.session.sessionId)!.list()).toEqual([]);
  expect(JSON.stringify(run.manager.getEntries())).not.toContain("Runtime-only file checkpoint retained");
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

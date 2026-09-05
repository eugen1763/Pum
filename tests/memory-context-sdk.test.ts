import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model, type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONTEXT_TOOL_NAMES, ContextWindowController } from "../src/context-window";
import { createMemoryExtension, ProjectMemoryStore } from "../src/memory";

const MODEL: Model<"openai-completions"> = {
  id: "memory-prefix", name: "memory-prefix", provider: "pum-memory-prefix", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
// The installed SDK has already converted transient custom entries to provider
// user messages at this boundary. Ignore transport-omitted internal timestamps.
function input(context: Context) {
  return context.messages.map(({ timestamp: _timestamp, ...message }) => message);
}
function prefix(previous: Context, next: Context) {
  expect(next.systemPrompt).toBe(previous.systemPrompt);
  expect(next.tools).toEqual(previous.tools);
  expect(input(next).slice(0, previous.messages.length)).toEqual(input(previous));
}
const memoryMessages = (context: Context) => context.messages.filter((message) => message.role === "user"
  && JSON.stringify(message.content).includes("PUM project memory"));

async function fixture(options: { root?: string; resume?: string; audience?: "main" | "subagent"; retry?: boolean } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "pum-memory-sdk-"));
  if (!options.root) roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "isolated-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const store = new ProjectMemoryStore(agentDir, cwd);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === MODEL.provider;
  const controller = new ContextWindowController();
  let externalEdit = () => {};
  const external: InlineExtension = { name: "memory-external-edit", factory(pi) {
    pi.registerTool({
      name: "external_edit", label: "External edit", description: "Test external shared memory changes.",
      parameters: Type.Object({}), executionMode: "sequential",
      async execute() { externalEdit(); return { content: [{ type: "text", text: "External edit completed." }], details: {} }; },
    });
  } };
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false, reserveTokens: 1000 } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Memory prefix test instructions.",
      extensionFactories: [controller.extension(), createMemoryExtension({ agentDir, audience: options.audience ?? "main" }), external],
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const manager = options.resume ? SessionManager.open(options.resume) : SessionManager.create(cwd, join(root, "sessions"));
  const tools = [...CONTEXT_TOOL_NAMES, "memory_read", ...(options.audience === "subagent" ? [] : ["memory_edit"]), "external_edit"];
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: MODEL, thinkingLevel: "off", tools });
  sessions.push(session);
  controller.bind(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  const requests: Context[] = [];
  type Reply = AssistantMessage["content"] | "error" | "aborted";
  const replies: Reply[] = [];
  let onRequest = () => {};
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    onRequest();
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected memory SDK request");
    const failed = reply === "error" || reply === "aborted";
    const content = failed ? reply === "aborted" ? [call("partial-aborted-call", "memory_edit")] : [] : reply;
    const message: AssistantMessage = {
      role: "assistant", content, provider: MODEL.provider, model: MODEL.id, api: MODEL.api, timestamp: Date.now(),
      stopReason: failed ? reply : content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
      ...(reply === "error" ? { errorMessage: "503 Service Unavailable" } : {}),
      usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 5100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    if (failed) stream.push({ type: "error", reason: reply, error: message });
    else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  const change = (content: string) => { const current = store.read(); store.edit(current.revision, current.content, content); };
  const prompt = async (value = "Continue") => { replies.push(text("Answer")); await session.prompt(value); if (!requests.length) throw new Error(JSON.stringify({ errors, messages: session.agent.state.messages })); return requests.at(-1)!; };
  return { root, cwd, agentDir, session, manager, requests, replies, store, errors, change, prompt,
    setExternalEdit: (fn: () => void) => { externalEdit = fn; }, setOnRequest: (fn: () => void) => { onRequest = fn; } };
}

describe("project memory prefixes through the installed SDK", () => {
  for (const audience of ["main", "subagent"] as const) {
    test(`${audience}: external changes, deletion, invalid/unavailable memory and recovery append without rewriting earlier input`, async () => {
      const h = await fixture({ audience });
      let previous = await h.prompt("Initial empty memory");
      expect(memoryMessages(previous)).toHaveLength(1);
      h.change("FIRST_PRIVATE_FACT");
      let next = await h.prompt(); prefix(previous, next); previous = next;
      expect(memoryMessages(next)).toHaveLength(2);
      next = await h.prompt(); prefix(previous, next); previous = next;
      expect(memoryMessages(next)).toHaveLength(2);
      h.change("SECOND_PRIVATE_FACT");
      next = await h.prompt(); prefix(previous, next); previous = next;
      rmSync(h.store.file);
      next = await h.prompt(); prefix(previous, next); previous = next;
      expect(JSON.stringify(next.messages.at(-1))).toContain("No earlier project memory facts remain current");
      writeFileSync(h.store.file, "");
      next = await h.prompt(); prefix(previous, next); previous = next;
      expect(memoryMessages(next)).toHaveLength(4); // deletion and a valid empty file are equivalent
      h.change("RECOVERED_AFTER_DELETE");
      next = await h.prompt(); prefix(previous, next); previous = next;
      writeFileSync(h.store.file, "api_key = sk-1234567890abcdefghijklmnop\n");
      next = await h.prompt(); prefix(previous, next); previous = next;
      expect(JSON.stringify(next)).not.toContain("sk-1234567890abcdefghijklmnop");
      expect(JSON.stringify(next.messages.at(-1))).toContain("Earlier memory is not authoritative");
      const count = memoryMessages(next).length;
      rmSync(h.store.file);
      mkdirSync(h.store.file); // deterministic unavailable/not-a-file read on all platforms
      next = await h.prompt(); prefix(previous, next); previous = next;
      expect(memoryMessages(next)).toHaveLength(count);
      rmSync(h.store.file, { recursive: true });
      writeFileSync(h.store.file, "FINAL_PRIVATE_FACT\n");
      next = await h.prompt(); prefix(previous, next);
      expect(JSON.stringify(next.messages.at(-1))).toContain("FINAL_PRIVATE_FACT");
      const durable = JSON.stringify(h.manager.getEntries());
      expect(durable).not.toContain("PRIVATE_FACT");
      expect(durable).not.toContain("pum.project_memory");
      expect(readFileSync(h.manager.getSessionFile()!, "utf8")).not.toContain("PRIVATE_FACT");
      expect(h.errors).toEqual([]);
    });
  }

  test("real memory_edit loop keeps tool-call/result pairs adjacent and deduplicates unchanged observations", async () => {
    const h = await fixture();
    h.change("LOOP_ORIGINAL");
    const current = h.store.read();
    h.replies.push([call("edit-one", "memory_edit", { revision: current.revision, old_text: current.content, new_text: "LOOP_UPDATED" }),
      call("meter-one", "get_context_remaining")], [call("meter-two", "get_context_remaining")], text("Done"));
    await h.session.prompt("Update project memory");
    expect(h.requests).toHaveLength(3);
    prefix(h.requests[0]!, h.requests[1]!);
    prefix(h.requests[1]!, h.requests[2]!);
    expect(memoryMessages(h.requests[0]!)).toHaveLength(1);
    expect(memoryMessages(h.requests[1]!)).toHaveLength(2);
    expect(memoryMessages(h.requests[2]!)).toHaveLength(2);
    const messages = h.requests[1]!.messages;
    const assistant = messages.findIndex((entry) => entry.role === "assistant");
    expect(messages.slice(assistant, assistant + 4).map((entry) => entry.role)).toEqual(["assistant", "toolResult", "toolResult", "user"]);
    expect(JSON.stringify(messages.at(-1))).toContain("LOOP_UPDATED");
    const result = h.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolCallId === "meter-two");
    // The next provider usage already includes the retained update chain. The
    // controller must not add the same injection twice on top of that usage.
    expect(result?.type === "message" && result.message.role === "toolResult" && (result.message.details as any).estimatedOverheadTokens).toBe(0);
    // Explicit memory_read is a normal durable tool result. Projection privacy
    // must not silently change the documented tool output/transcript contract.
    expect(h.manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "pum.project_memory")).toBe(false);
    expect(h.errors).toEqual([]);
  });

  test("capacity accounting includes the complete retained update chain before new provider usage", async () => {
    const h = await fixture();
    h.change("CAPACITY_ORIGINAL");
    await h.prompt();
    const meter = h.session.agent.state.tools.find((tool) => tool.name === "get_context_remaining")!;
    const readMeter = async () => (await meter.execute("capacity", {}, new AbortController().signal)).details as any;
    const before = await readMeter();
    h.change("CAPACITY_FIRST_UPDATE ".repeat(100));
    // Exercise the real installed transform wrapper before a newer provider
    // usage baseline arrives, as happens while a request is in flight.
    await h.session.agent.transformContext!(h.session.agent.state.messages);
    const first = await readMeter();
    h.change("CAPACITY_SECOND_UPDATE ".repeat(100));
    await h.session.agent.transformContext!(h.session.agent.state.messages);
    const second = await readMeter();
    expect(first.estimatedOverheadTokens).toBeGreaterThan(before.estimatedOverheadTokens + 400);
    expect(second.estimatedOverheadTokens).toBeGreaterThan(first.estimatedOverheadTokens + 400);
    await h.session.agent.transformContext!(h.session.agent.state.messages);
    expect((await readMeter()).estimatedOverheadTokens).toBe(second.estimatedOverheadTokens);
    expect(h.errors).toEqual([]);
  });

  test("external shared edits in tool loops appear after the whole tool block", async () => {
    const h = await fixture();
    h.change("EXTERNAL_ORIGINAL");
    h.setExternalEdit(() => h.change("EXTERNAL_UPDATED"));
    h.replies.push([call("external", "external_edit"), call("meter", "get_context_remaining")], text("Done"));
    await h.session.prompt("Read external changes");
    prefix(h.requests[0]!, h.requests[1]!);
    expect(h.requests[1]!.messages.slice(-3).map((entry) => entry.role)).toEqual(["toolResult", "toolResult", "user"]);
    expect(JSON.stringify(h.requests[1]!.messages.at(-1))).toContain("EXTERNAL_UPDATED");
    expect(h.errors).toEqual([]);
  });

  test("concurrent sessions share current storage but retain independent snapshot chains", async () => {
    const first = await fixture();
    first.change("CONCURRENT_ORIGINAL");
    const firstRequest = await first.prompt();
    first.change("CONCURRENT_UPDATED");
    const second = await fixture({ root: first.root });
    const secondRequest = await second.prompt();
    expect(memoryMessages(secondRequest)).toHaveLength(1);
    expect(JSON.stringify(secondRequest)).not.toContain("CONCURRENT_ORIGINAL");
    const next = await first.prompt();
    prefix(firstRequest, next);
    expect(memoryMessages(next)).toHaveLength(2);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  test("resume/runtime replacement starts a latest snapshot without persisting historical memory", async () => {
    const h = await fixture();
    h.change("RESUME_OLD_PRIVATE");
    await h.prompt("Durable user instruction");
    h.change("RESUME_INTERMEDIATE_PRIVATE");
    await h.prompt();
    const entries = structuredClone(h.manager.getEntries());
    const file = h.manager.getSessionFile()!;
    h.session.dispose();
    sessions.splice(sessions.indexOf(h.session), 1);
    h.change("RESUME_CURRENT_PRIVATE");
    const resumed = await fixture({ root: h.root, resume: file });
    const next = await resumed.prompt("After resume");
    expect(memoryMessages(next)).toHaveLength(1);
    expect(JSON.stringify(next)).toContain("RESUME_CURRENT_PRIVATE");
    expect(JSON.stringify(next)).not.toContain("RESUME_OLD_PRIVATE");
    expect(JSON.stringify(next)).not.toContain("RESUME_INTERMEDIATE_PRIVATE");
    expect(JSON.stringify(next)).toContain("Durable user instruction");
    expect(resumed.manager.getEntries().slice(0, entries.length)).toEqual(entries);
    expect(readFileSync(file, "utf8")).not.toContain("_PRIVATE");
    expect(resumed.errors).toEqual([]);
  });

  test("explicit rollover consolidates memory only in active input and resume keeps the window boundary", async () => {
    const h = await fixture();
    h.change("ROLLOVER_OLD_PRIVATE");
    await h.prompt("Archived instruction");
    h.change("ROLLOVER_CURRENT_PRIVATE");
    await h.prompt();
    const entries = structuredClone(h.manager.getEntries());
    h.replies.push([call("roll", "new_context", { handoff: "LITERAL_HANDOFF" })], text("Fresh answer"));
    await h.session.prompt("Roll over");
    const fresh = h.requests.at(-1)!;
    expect(memoryMessages(fresh)).toHaveLength(1);
    expect(JSON.stringify(fresh)).toContain("ROLLOVER_CURRENT_PRIVATE");
    expect(JSON.stringify(fresh)).not.toContain("ROLLOVER_OLD_PRIVATE");
    expect(JSON.stringify(fresh)).not.toContain("Archived instruction");
    expect(JSON.stringify(fresh)).toContain("LITERAL_HANDOFF");
    expect(h.manager.getEntries().slice(0, entries.length)).toEqual(entries);
    expect(JSON.stringify(h.manager.getEntries())).toContain("Archived instruction");
    expect(JSON.stringify(h.manager.getEntries())).not.toContain("_PRIVATE");
    const file = h.manager.getSessionFile()!;
    h.session.dispose(); sessions.splice(sessions.indexOf(h.session), 1);
    const resumed = await fixture({ root: h.root, resume: file });
    const next = await resumed.prompt();
    expect(memoryMessages(next)).toHaveLength(1);
    expect(JSON.stringify(next)).not.toContain("Archived instruction");
    expect(JSON.stringify(next)).toContain("LITERAL_HANDOFF");
    expect(resumed.errors).toEqual([]);
  });

  test("transport retries do not duplicate memory updates", async () => {
    const h = await fixture({ retry: true });
    h.change("RETRY_ORIGINAL");
    h.setOnRequest(() => { if (h.requests.length === 1) h.change("RETRY_UPDATED"); });
    h.replies.push("error", text("Recovered"));
    await h.session.prompt("Retry this request");
    expect(h.requests).toHaveLength(2);
    prefix(h.requests[0]!, h.requests[1]!);
    expect(memoryMessages(h.requests[1]!)).toHaveLength(2);
    const next = await h.prompt();
    prefix(h.requests[1]!, next);
    expect(memoryMessages(next)).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });

  test("an aborted response followed by continuation retains the same memory chain", async () => {
    const h = await fixture();
    h.change("ABORT_ORIGINAL");
    h.replies.push("aborted");
    await h.session.prompt("Abort this response");
    h.change("ABORT_UPDATED");
    const next = await h.prompt("Continue after abort");
    prefix(h.requests[0]!, next);
    expect(memoryMessages(next)).toHaveLength(2);
    const unchanged = await h.prompt();
    prefix(next, unchanged);
    expect(memoryMessages(unchanged)).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });
});

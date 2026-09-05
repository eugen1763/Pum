import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Type } from "typebox";
import { createMemoryExtension, ProjectMemoryStore } from "../src/memory";
import { clearRequestDiagnostics, requestDiagnosticsReport } from "../src/request-diagnostics";
import { ENABLE_TOOLS, ToolGroupsController, mainAllowedToolNames, childAllowedToolNames } from "../src/tool-groups";
import { bindSearchSession, webSearch, wrapProvider, type SearchSessionRole } from "../src/web-search";

// This exercises the installed Codex serializer, not a hand-built Context or
// payload-hook imitation. SSE is deliberately selected ONLY in the HTTP cases;
// a separate local WebSocket case tests real SDK full/delta and reuse decisions.
// Neither establishes actual server-side cache hits: all usage is synthetic.
const roots: string[] = [];
const sessions: AgentSession[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const originalEnv = process.env.PUM_REQUEST_DIAGNOSTICS;
const originalSearch = webSearch.enabled;
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearRequestDiagnostics();
  if (originalEnv === undefined) delete process.env.PUM_REQUEST_DIAGNOSTICS;
  else process.env.PUM_REQUEST_DIAGNOSTICS = originalEnv;
  webSearch.enabled = originalSearch;
});

type Wire = { instructions: string; tools: { name?: string; type: string }[]; input: unknown[]; [key: string]: unknown };
type Reply = "stop" | "error" | { groups: string[] };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Not a credential: the local mock accepts any text; pi's Codex adapter requires
// this claim before serialization. Never use a configured provider or real token.
const fakeToken = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "local-diagnostics-test" },
})).toString("base64url")}.fixture`;

async function fixture(options: { root?: string; resume?: string; role?: SearchSessionRole; retry?: boolean; enabled?: boolean;
  transport?: "sse" | "websocket-cached" } = {}) {
  process.env.PUM_REQUEST_DIAGNOSTICS = options.enabled === false ? "0" : "1";
  webSearch.enabled = true;
  const root = options.root ?? mkdtempSync(join(tmpdir(), "pum-diagnostics-sdk-"));
  if (!options.root) roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "isolated-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const wire: Wire[] = [];
  const replies: Reply[] = [];
  function responseEvents() {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected fixture request");
    const id = `response-${wire.length}`;
    if (reply === "error") return [{ type: "error", code: "service_unavailable", message: "503 Service Unavailable" }];
    const item = typeof reply === "object"
      ? { type: "function_call", id: `fc-${wire.length}`, call_id: `call-${wire.length}`, name: ENABLE_TOOLS,
        arguments: JSON.stringify(reply), status: "completed" }
      : { type: "message", id: `msg-${wire.length}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Local fixture answer.", annotations: [] }] };
    return [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item], usage: {
        input_tokens: 120, output_tokens: 7, total_tokens: 127, input_tokens_details: { cached_tokens: 40 },
      } } },
    ];
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket" && server.upgrade(request)) return;
    const raw = Buffer.from(await request.arrayBuffer());
    const json = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw).toString() : raw.toString();
    wire.push(JSON.parse(json) as Wire);
    return sse(responseEvents());
  }, websocket: { message(socket, message) {
    wire.push(JSON.parse(message.toString()) as Wire);
    for (const event of responseEvents()) socket.send(JSON.stringify(event));
  } } });
  servers.push(server);
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-5.4", name: "Local Codex serializer fixture", provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: `http://127.0.0.1:${server.port}`, reasoning: true, input: ["text"], contextWindow: 64_000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.hasConfiguredAuth = (provider) => provider === model.provider;
  const role = options.role ?? "main";
  const audience = role === "main" ? "main" : "subagent";
  const groups = new ToolGroupsController(audience, undefined, role === "readonly");
  const manager = options.resume ? SessionManager.open(options.resume) : SessionManager.create(cwd, join(root, "sessions"));
  groups.load(manager.getSessionFile());
  const allowed = audience === "main" ? mainAllowedToolNames() : childAllowedToolNames(role === "readonly");
  const real = new Set(["read", "write", "edit", "bash", "memory_read", "memory_edit", ENABLE_TOOLS]);
  let instructionSuffix = "";
  const extension: InlineExtension = { name: "diagnostic-sdk-fixtures", factory(pi) {
    for (const name of allowed.filter((name) => !real.has(name))) pi.registerTool({
      name, label: name, description: `Inert ${name} fixture.`, parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "Unused fixture." }], details: {} }; },
    });
    pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + instructionSuffix }));
    // The base transform attempts to inject hosted search even for denied roles.
    // Only the final serialized body after chainSearchTool may be measured.
    pi.on("before_provider_request", (event) => {
      const body = event.payload as Wire;
      return { ...body, tools: [...(body.tools ?? []), { type: "web_search" }] };
    });
  } };
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Local serialized request diagnostics test.",
      extensionFactories: [createMemoryExtension({ agentDir, audience }), extension, groups.extension()] },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, thinkingLevel: "off", tools: allowed });
  sessions.push(session);
  session.setActiveToolsByName(groups.activeTools());
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  const provider = wrapProvider(openaiCodexProvider());
  const fixtureTransport = options.transport ?? "sse";
  session.agent.streamFunction = (model, context, options) => provider.streamSimple(model, context, {
    ...options, apiKey: fakeToken, transport: fixtureTransport,
  });
  bindSearchSession(session, role);
  const store = new ProjectMemoryStore(agentDir, cwd);
  const changeMemory = (content: string) => {
    const previous = store.read();
    store.edit(previous.revision, previous.content, content);
  };
  const prompt = async (text = "Continue local diagnostics fixture.", plan: Reply[] = ["stop"]) => {
    replies.push(...plan);
    await session.prompt(text);
    expect(errors).toEqual([]);
    expect(replies).toHaveLength(0);
    return wire.at(-1)!;
  };
  const report = () => requestDiagnosticsReport(session.sessionId).requests;
  return { root, session, manager, wire, prompt, report, store, changeMemory,
    changeInstructions: (suffix: string) => { instructionSuffix = suffix; } };
}

function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function measuredWire(record: ReturnType<typeof requestDiagnosticsReport>["requests"][number], wire: Wire) {
  expect(record.payload).not.toBeNull();
  expect(record.tools).not.toBeNull();
  expect(record.input).not.toBeNull();
  expect(record.payload!.bytes).toBe(bytes(wire));
  expect(record.tools!.bytes).toBe(bytes(wire.tools));
  expect(record.input!.items).toBe(wire.input.length);
  expect(record.payload!.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.sessionHash).toMatch(/^[a-f0-9]{64}$/);
}

describe("request diagnostics through installed SDK serialized Codex onPayload", () => {
  test("opt-in only; enabled capture measures final wire body and provider-reported usage without plaintext", async () => {
    const disabled = await fixture({ enabled: false });
    await disabled.prompt("DISABLED_PRIVATE_PROMPT");
    expect(disabled.report()).toEqual([]);
    expect(requestDiagnosticsReport().enabled).toBe(false);
    const h = await fixture();
    const wire = await h.prompt("SECRET_PROMPT_SENT_ONLY_TO_LOCAL_SERVER");
    expect(wire.tools.some((tool) => tool.type === "web_search")).toBe(true);
    const [record] = h.report();
    measuredWire(record!, wire);
    expect(record!.role).toBe("main");
    expect(record!.input!.prefix).toBe("first");
    expect(record!.reasons).toContain("first-request");
    expect(record!.outcome).toBe("stop");
    expect(record!.usage).toMatchObject({ input: 80, output: 7, cacheRead: 40, cacheWrite: 0, totalTokens: 127 });
    const reportText = JSON.stringify(requestDiagnosticsReport());
    for (const secret of ["SECRET_PROMPT_SENT_ONLY_TO_LOCAL_SERVER", "Local fixture answer.", fakeToken, h.root, h.session.sessionId])
      expect(reportText).not.toContain(secret);
  });

  test("memory revisions append to the serialized input without rewriting old items or instructions", async () => {
    const h = await fixture();
    h.changeMemory("FIRST_PRIVATE_MEMORY_FACT");
    const first = await h.prompt();
    const initial = h.report().at(-1)!;
    expect(initial.memoryRevision).toBe(h.store.read().revision);
    h.changeMemory("SECOND_PRIVATE_MEMORY_FACT");
    const second = await h.prompt();
    const updated = h.report().at(-1)!;
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(updated.input!.prefix).toBe("append-only");
    expect(updated.reasons).toContain("input-appended");
    expect(updated.instructions).toEqual(initial.instructions);
    expect(updated.tools).toEqual(initial.tools);
    expect(updated.memoryRevision).toBe(h.store.read().revision);
    expect(updated.memoryRevision).not.toBe(initial.memoryRevision);
    const third = await h.prompt();
    expect(third.input.slice(0, second.input.length)).toEqual(second.input);
    expect(h.report().at(-1)!.memoryRevision).toBe(updated.memoryRevision);
    expect(JSON.stringify(h.report())).not.toContain("PRIVATE_MEMORY_FACT");
    expect(JSON.stringify(h.manager.getEntries())).not.toContain("provider-payload-before-transport");
    expect(JSON.stringify(h.manager.getEntries())).not.toContain("PRIVATE_MEMORY_FACT");
    h.report().forEach((record, index) => measuredWire(record, h.wire[index]!));
    clearRequestDiagnostics(h.session.sessionId);
    await h.prompt();
    expect(h.report()).toHaveLength(1);
    expect(h.report()[0]!.memoryRevision).toBe(h.store.read().revision);
  });

  test("tool activation order converges on identical serialized tool schemas and persists across resume", async () => {
    const forward = await fixture();
    const reverse = await fixture();
    await forward.prompt("Enable groups", [{ groups: ["Admin", "Worktree", "Todo"] }, "stop"]);
    await reverse.prompt("Enable groups", [{ groups: ["Todo", "Worktree", "Admin"] }, "stop"]);
    const first = await forward.prompt();
    const second = await reverse.prompt();
    expect(first.tools).toEqual(second.tools);
    expect(forward.report().at(-1)!.tools).toEqual(reverse.report().at(-1)!.tools);
    expect(forward.report()[0]!.outcome).toBe("toolUse");
    expect(forward.report()[1]!.reasons).toContain("tools-changed");
    const id = forward.session.sessionId;
    const file = forward.manager.getSessionFile()!;
    forward.session.dispose();
    expect(requestDiagnosticsReport(id).requests).toEqual([]);
    const resumed = await fixture({ root: forward.root, resume: file });
    expect(resumed.session.sessionId).toBe(id);
    const resumedWire = await resumed.prompt();
    expect(resumedWire.tools).toEqual(first.tools);
    expect(resumed.report()).toHaveLength(1);
    expect(resumed.report()[0]!.input!.prefix).toBe("first");
    expect(resumed.report()[0]!.reasons).toContain("first-request");
    measuredWire(resumed.report()[0]!, resumedWire);
  });

  test("instruction and reasoning settings changes are attributed independently of appended input", async () => {
    const h = await fixture();
    await h.prompt();
    h.changeInstructions("\nUse the changed writing-style setting.");
    await h.prompt();
    expect(h.report().at(-1)!.reasons).toContain("instructions-changed");
    expect(h.report().at(-1)!.tools).toEqual(h.report()[0]!.tools);
    h.session.setThinkingLevel("low");
    await h.prompt();
    expect(h.wire.at(-1)!.reasoning).not.toEqual(h.wire.at(-2)!.reasoning);
    expect(h.report().at(-1)!.reasons).toContain("non-input-changed");
    expect(h.report().at(-1)!.instructions).toEqual(h.report().at(-2)!.instructions);
  });

  test("SDK retry records a failed serialized attempt then an unchanged retry with after-error attribution", async () => {
    const h = await fixture({ retry: true });
    await h.prompt("Retry locally", ["error", "stop"]);
    expect(h.wire).toHaveLength(2);
    expect(h.wire[1]).toEqual(h.wire[0]);
    expect(h.report()).toHaveLength(2);
    expect(h.report()[0]!.outcome).toBe("error");
    expect(h.report()[1]!.outcome).toBe("stop");
    expect(h.report()[1]!.reasons).toContain("after-error");
    expect(h.report()[1]!.input!.prefix).toBe("unchanged");
    expect(h.report()[1]!.payload).toEqual(h.report()[0]!.payload);
  });

  test("local WebSocket transport selects full then delta input and reuses its connection independently of cache usage", async () => {
    const h = await fixture({ transport: "websocket-cached" });
    await h.prompt("First WebSocket turn");
    await h.prompt("Append a second WebSocket turn");
    expect(h.wire).toHaveLength(2);
    expect(h.wire[0]!.type).toBe("response.create");
    expect(h.wire[0]!.previous_response_id).toBeUndefined();
    expect(h.wire[1]!.previous_response_id).toBe("response-1");
    const [first, second] = h.report();
    expect(first!.transport!.counters).toMatchObject({ connectionsCreated: 1, fullContextRequests: 1, deltaRequests: 0 });
    expect(second!.transport!.counters).toMatchObject({ connectionsCreated: 0, connectionsReused: 1, fullContextRequests: 0, deltaRequests: 1 });
    // onPayload sees the complete logical request BEFORE the SDK chooses delta
    // transmission. These must not be mislabeled as equal-sized wire payloads.
    expect(second!.input!.items).toBeGreaterThan(h.wire[1]!.input.length);
    expect(second!.input!.prefix).toBe("append-only");
    expect(first!.usage!.cacheRead).toBe(40);
    expect(second!.usage!.cacheRead).toBe(40);
  });

  test("restricted roles measure the search-filtered wire body, never the extension's attempted injection", async () => {
    for (const role of ["readonly", "judge", "afk"] as const) {
      const h = await fixture({ role });
      const wire = await h.prompt();
      expect(wire.tools.some((tool) => tool.type === "web_search")).toBe(false);
      expect(h.report()).toHaveLength(1);
      expect(h.report()[0]!.role).toBe(role);
      measuredWire(h.report()[0]!, wire);
    }
  });

  test("concurrent main and worker sessions keep independent baselines and scoped clear does not reset a peer", async () => {
    const main = await fixture();
    const worker = await fixture({ root: main.root, role: "worker" });
    await Promise.all([main.prompt("MAIN_PRIVATE_TASK"), worker.prompt("WORKER_PRIVATE_TASK")]);
    expect(main.report()).toHaveLength(1);
    expect(worker.report()).toHaveLength(1);
    expect(main.report()[0]!.sessionHash).not.toBe(worker.report()[0]!.sessionHash);
    expect(main.report()[0]!.role).toBe("main");
    expect(worker.report()[0]!.role).toBe("worker");
    expect(worker.wire[0]!.tools.some((tool) => tool.type === "web_search")).toBe(true);
    clearRequestDiagnostics(main.session.sessionId);
    expect(main.report()).toEqual([]);
    expect(worker.report()).toHaveLength(1);
    await Promise.all([main.prompt(), worker.prompt()]);
    expect(main.report()[0]!.input!.prefix).toBe("first");
    expect(worker.report()).toHaveLength(2);
    expect(worker.report()[1]!.input!.prefix).toBe("append-only");
    expect(JSON.stringify(main.report())).not.toContain("WORKER_PRIVATE_TASK");
    expect(JSON.stringify(worker.report())).not.toContain("MAIN_PRIVATE_TASK");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONTEXT_TOOL_NAMES, ContextWindowController } from "../src/context-window";
import { CONTEXT_GUIDANCE } from "../src/context-guidance";

// Only the transport and the fake provider's auth preflight are replaced. The SDK
// owns extension dispatch, tool batches, next-turn refresh, queues, and JSONL IO.
// No HTTP server, provider credentials, home configuration, or live model is used.
const MODEL: Model<"openai-completions"> = {
  id: "context-window-script",
  name: "Context window script",
  provider: "pum-context-sdk-fixture",
  api: "openai-completions",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 32_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const BASE = "SDK_BASE_SYSTEM_SENTINEL";
const STYLE = "SDK_WRITING_STYLE_SENTINEL";
const MEMORY = "SDK_PRIVATE_MEMORY_SENTINEL";
const MARKER = "pum.context_window";

type Request = Pick<Context, "systemPrompt" | "messages"> & { toolNames: string[] };
type Reply = AssistantMessage["content"];
const roots: string[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function text(value: string): Reply {
  return [{ type: "text", text: value }];
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function encoded(request: Request): string {
  return JSON.stringify(request.messages);
}

function boundaries(manager: SessionManager) {
  return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === MARKER);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const injection: InlineExtension = {
  name: "context-sdk-memory-and-style",
  factory(pi) {
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n${STYLE}` }));
    // This is the same transient context shape used by PUM project memory.
    pi.on("context", (event) => ({
      messages: [{
        role: "custom" as const,
        customType: "pum.memory",
        content: MEMORY,
        display: false,
        timestamp: 1,
      }, ...event.messages],
    }));
  },
};

function sibling(execute: () => Promise<void>, reject = false): InlineExtension {
  return {
    name: "context-sdk-sibling",
    factory(pi) {
      if (reject) {
        pi.on("tool_call", (event) => event.toolName === "sdk_sibling"
          ? { block: true, reason: "SDK_SIBLING_REJECTED" }
          : undefined);
      }
      pi.registerTool({
        name: "sdk_sibling",
        label: "SDK sibling",
        description: "A deterministic sibling in a real SDK tool batch.",
        parameters: Type.Object({}),
        async execute() {
          await execute();
          return { content: [{ type: "text", text: "SDK_SIBLING_RESULT" }], details: {} };
        },
      });
    },
  };
}

async function fixture(options: {
  extensions?: InlineExtension[];
  injectionFirst?: boolean;
  usageTokens?: () => number;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pum-context-sdk-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "isolated-agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === MODEL.provider;

  async function open(sessionFile?: string) {
    const controller = new ContextWindowController();
    const settingsManager = SettingsManager.inMemory();
    settingsManager.setCompactionEnabled(false);
    settingsManager.setRetryEnabled(false);
    const extensionFactories = options.injectionFirst
      ? [injection, controller.extension(), ...(options.extensions ?? [])]
      : [controller.extension(), injection, ...(options.extensions ?? [])];
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: runtime,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: BASE,
        extensionFactories,
      },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    const manager = sessionFile
      ? SessionManager.open(sessionFile, sessionDir)
      : SessionManager.create(cwd, sessionDir);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: MODEL,
      thinkingLevel: "off",
      tools: [...CONTEXT_TOOL_NAMES, "sdk_sibling"],
    });
    sessions.push(session);
    controller.bind(session);
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => { extensionErrors.push(error); } });
    const requests: Request[] = [];
    const replies: Reply[] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push({
        systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages),
        toolNames: (context.tools ?? []).map((tool) => tool.name),
      });
      const content = replies.shift();
      if (!content) throw new Error("Unexpected model request: the SDK script is exhausted");
      const totalTokens = options.usageTokens?.() ?? 110;
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: totalTokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    };
    return { controller, session, manager, requests, replies, extensionErrors };
  }
  return { open };
}

function expectInfrastructure(request: Request) {
  expect(request.systemPrompt).toContain(BASE);
  expect(request.systemPrompt).toContain(STYLE);
  expect(request.systemPrompt?.split(CONTEXT_GUIDANCE)).toHaveLength(2);
  expect(encoded(request).split(MEMORY)).toHaveLength(2);
  for (const name of CONTEXT_TOOL_NAMES) expect(request.toolNames).toContain(name);
}

function expectNoOldToolPair(request: Request, ids: string[]) {
  for (const message of request.messages) {
    if (message.role === "toolResult") expect(ids).not.toContain(message.toolCallId);
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") expect(ids).not.toContain(part.id);
      }
    }
  }
}

describe("context windows through the installed pi SDK", () => {
  for (const injectionFirst of [false, true]) {
    test(`rollover reaches the next tool-loop request and later prompts (memory first: ${injectionFirst})`, async () => {
      const { open } = await fixture({ injectionFirst });
      const run = await open();
      run.replies.push(text("ORIGINAL_ANSWER"));
      await run.session.prompt("ORIGINAL_USER_DATA");
      const originalEntries = structuredClone(run.manager.getEntries());
      run.replies.push([call("rollover-one", "new_context", { handoff: "CONTINUE_FROM_HANDOFF" })], text("FRESH_ANSWER"));
      await run.session.prompt("ROLLOVER_REQUEST_DATA");

      expect(run.requests).toHaveLength(3);
      const fresh = run.requests[2]!;
      expect(encoded(fresh)).toContain("CONTINUE_FROM_HANDOFF");
      for (const old of ["ORIGINAL_USER_DATA", "ORIGINAL_ANSWER", "ROLLOVER_REQUEST_DATA"]) {
        expect(encoded(fresh)).not.toContain(old);
      }
      expectNoOldToolPair(fresh, ["rollover-one"]);
      expectInfrastructure(fresh);
      expect(boundaries(run.manager)).toHaveLength(1);
      for (const entry of originalEntries) expect(run.manager.getEntries()).toContainEqual(entry);

      run.replies.push(text("LATER_ANSWER"));
      await run.session.prompt("LATER_PROMPT");
      expect(run.requests).toHaveLength(4);
      expect(encoded(run.requests[3]!)).toContain("LATER_PROMPT");
      expect(encoded(run.requests[3]!)).toContain("FRESH_ANSWER");
      expect(encoded(run.requests[3]!)).not.toContain("ORIGINAL_USER_DATA");
      expectNoOldToolPair(run.requests[3]!, ["rollover-one"]);
      expectInfrastructure(run.requests[3]!);
      expect(run.extensionErrors).toEqual([]);
      expect(run.replies).toEqual([]);
      expect(JSON.stringify(run.manager.getEntries())).not.toContain(MEMORY);
    });
  }

  test("waits for the entire successful tool batch before publishing the boundary", async () => {
    const started = deferred();
    const release = deferred();
    const { open } = await fixture({ extensions: [sibling(async () => {
      started.resolve();
      await release.promise;
    })] });
    const run = await open();
    run.replies.push([
      call("batch-rollover", "new_context", { handoff: "BATCH_HANDOFF" }),
      call("batch-sibling", "sdk_sibling"),
    ], text("BATCH_FRESH_ANSWER"));
    const pending = run.session.prompt("BATCH_OLD_PROMPT");
    try {
      await started.promise;
      expect(boundaries(run.manager)).toHaveLength(0);
      expect(run.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await pending;
    }
    expect(run.requests).toHaveLength(2);
    expect(boundaries(run.manager)).toHaveLength(1);
    expect(encoded(run.requests[1]!)).toContain("BATCH_HANDOFF");
    expect(encoded(run.requests[1]!)).not.toContain("BATCH_OLD_PROMPT");
    expectNoOldToolPair(run.requests[1]!, ["batch-rollover", "batch-sibling"]);
    const entries = run.manager.getEntries();
    const markerIndex = entries.findIndex((entry) => entry.type === "custom" && entry.customType === MARKER);
    for (const id of ["batch-rollover", "batch-sibling"]) {
      const resultIndex = entries.findIndex((entry) => entry.type === "message"
        && entry.message.role === "toolResult" && entry.message.toolCallId === id);
      expect(resultIndex).toBeGreaterThan(-1);
      expect(resultIndex).toBeLessThan(markerIndex);
    }
    expect(run.extensionErrors).toEqual([]);
  });

  for (const rejected of [false, true]) {
    test(`a successful new_context plus a ${rejected ? "rejected" : "throwing"} sibling keeps the old window`, async () => {
      const { open } = await fixture({ extensions: [sibling(async () => {
        throw new Error("SDK_SIBLING_FAILED");
      }, rejected)] });
      const run = await open();
      run.replies.push([
        call("failed-batch-rollover", "new_context", { handoff: "MUST_NOT_APPLY" }),
        call("failed-batch-sibling", "sdk_sibling"),
      ], text("RECOVERY_ANSWER"));
      await run.session.prompt("KEEP_OLD_CONTEXT");
      expect(run.requests).toHaveLength(2);
      expect(boundaries(run.manager)).toHaveLength(0);
      const next = run.requests[1]!;
      expect(encoded(next)).toContain("KEEP_OLD_CONTEXT");
      const results = next.messages.filter((message) => message.role === "toolResult");
      expect(results.find((message) => message.toolCallId === "failed-batch-rollover")?.isError).toBe(false);
      expect(results.find((message) => message.toolCallId === "failed-batch-sibling")?.isError).toBe(true);
      run.replies.push(text("STILL_OLD_ANSWER"));
      await run.session.prompt("AFTER_FAILED_ROLLOVER");
      expect(encoded(run.requests[2]!)).toContain("KEEP_OLD_CONTEXT");
      expect(boundaries(run.manager)).toHaveLength(0);
      expect(run.extensionErrors).toEqual([]);
    });
  }

  test("queued steering survives a rollover without recovering old messages", async () => {
    let session!: AgentSession;
    const { open } = await fixture({ extensions: [sibling(async () => {
      await session.steer("QUEUED_STEERING_SENTINEL");
    })] });
    const run = await open();
    session = run.session;
    run.replies.push([
      call("steer-rollover", "new_context", { handoff: "STEER_HANDOFF" }),
      call("steer-sibling", "sdk_sibling"),
    ], text("STEER_FRESH_ANSWER"));
    await run.session.prompt("STEER_OLD_PROMPT");
    expect(run.requests).toHaveLength(2);
    expect(boundaries(run.manager)).toHaveLength(1);
    expect(encoded(run.requests[1]!)).toContain("STEER_HANDOFF");
    expect(encoded(run.requests[1]!)).toContain("QUEUED_STEERING_SENTINEL");
    expect(encoded(run.requests[1]!)).not.toContain("STEER_OLD_PROMPT");
    expectNoOldToolPair(run.requests[1]!, ["steer-rollover", "steer-sibling"]);
    expectInfrastructure(run.requests[1]!);
    expect(run.session.getSteeringMessages()).toEqual([]);
    run.replies.push(text("STEER_LATER_ANSWER"));
    await run.session.prompt("STEER_LATER_PROMPT");
    expect(encoded(run.requests[2]!)).toContain("QUEUED_STEERING_SENTINEL");
    expect(encoded(run.requests[2]!)).not.toContain("STEER_OLD_PROMPT");
    expect(run.extensionErrors).toEqual([]);
  });

  test("duplicate new_context calls in one real tool batch do not publish a boundary", async () => {
    const { open } = await fixture();
    const run = await open();
    run.replies.push([
      call("duplicate-one", "new_context", { handoff: "DUPLICATE_HANDOFF_ONE" }),
      call("duplicate-two", "new_context", { handoff: "DUPLICATE_HANDOFF_TWO" }),
    ], text("DUPLICATE_RECOVERY"));
    await run.session.prompt("DUPLICATE_OLD_PROMPT");
    expect(run.requests).toHaveLength(2);
    expect(boundaries(run.manager)).toHaveLength(0);
    expect(encoded(run.requests[1]!)).toContain("DUPLICATE_OLD_PROMPT");
    const results = run.requests[1]!.messages.filter((message) => message.role === "toolResult");
    expect(results.map((message) => message.toolCallId).sort()).toEqual(["duplicate-one", "duplicate-two"]);
    expect(run.extensionErrors).toEqual([]);
  });

  test("multiple history calls share the remaining budget through sequential SDK result persistence", async () => {
    let usageTokens = 110;
    const { open } = await fixture({ usageTokens: () => usageTokens });
    const run = await open();
    const archived = "ARCHIVED_BUDGET_EVIDENCE ".repeat(2000);
    const entryId = run.manager.appendMessage({ role: "user", content: archived, timestamp: 1 });
    const available = 3000;
    usageTokens = MODEL.contextWindow - run.session.settingsManager.getCompactionSettings().reserveTokens - available;
    expect(usageTokens).toBeGreaterThan(10);
    run.replies.push([
      call("history-budget-one", "history", { op: "read", entryId, limit: 16_384, imageLimit: 0 }),
      call("history-budget-two", "history", { op: "read", entryId, offset: 16_384, limit: 16_384, imageLimit: 0 }),
    ], text("BUDGET_BATCH_ANSWER"));
    await run.session.prompt("Read two archived pages in one tool batch.");

    expect(run.requests).toHaveLength(2);
    const results = run.requests[1]!.messages.filter((message) => message.role === "toolResult")
      .filter((message) => ["history-budget-one", "history-budget-two"].includes(message.toolCallId));
    expect(results.map((result) => result.toolCallId)).toEqual(["history-budget-one", "history-budget-two"]);
    const first = results[0]!;
    const second = results[1]!;
    type Page = {
      text: string; offset: number; nextOffset: number; budgetLimited: boolean;
      budget: { availableTokens: number };
    };
    const firstPage = first.details as Page;
    const secondPage = second.details as Page;
    expect(firstPage.budget.availableTokens).toBe(available);
    // This requires the actual SDK message_end to update state before call two.
    expect(secondPage.budget.availableTokens).toBe(available - estimateTokens(first));
    expect(secondPage.budget.availableTokens).toBeLessThan(available);
    expect(secondPage.text.length).toBeLessThan(firstPage.text.length);
    for (const result of results) {
      const page = result.details as Page;
      expect(result.isError).toBe(false);
      expect(page.budgetLimited).toBe(true);
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.text.length).toBeLessThan(16_384);
      expect(page.text).toBe(archived.slice(page.offset, page.nextOffset));
      const payload = result.content[0];
      if (payload?.type !== "text") throw new Error("Expected history text payload");
      expect(Math.ceil(Buffer.byteLength(payload.text, "utf8") / 3)).toBeLessThanOrEqual(page.budget.availableTokens);
    }
    // Use the controller's installed SDK estimate for the shared context cost.
    expect(results.reduce((total, result) => total + estimateTokens(result), 0)).toBeLessThanOrEqual(available);
    const persisted = run.manager.getEntries().filter((entry) => entry.type === "message"
      && entry.message.role === "toolResult").map((entry) => entry.type === "message" ? entry.message : undefined);
    expect(persisted).toEqual(results);
    expect(boundaries(run.manager)).toHaveLength(0);
    expect(run.extensionErrors).toEqual([]);
    expect(run.replies).toEqual([]);
  });

  test("two rollovers preserve original JSONL entries and resume the latest window with history access", async () => {
    const { open } = await fixture();
    const run = await open();
    run.replies.push(text("ARCHIVE_ANSWER_ZERO"));
    await run.session.prompt("ARCHIVE_NEEDLE_ZERO");
    const original = structuredClone(run.manager.getEntries());
    const sessionFile = run.session.sessionFile!;
    const sessionId = run.manager.getSessionId();
    expect(sessionFile).toBeDefined();
    run.replies.push([call("archive-rollover-one", "new_context", { handoff: "ARCHIVE_HANDOFF_ONE" })], text("ARCHIVE_ANSWER_ONE"));
    await run.session.prompt("ARCHIVE_ROLLOVER_ONE_REQUEST");
    run.replies.push([call("archive-rollover-two", "new_context", { handoff: "ARCHIVE_HANDOFF_TWO" })], text("ARCHIVE_ANSWER_TWO"));
    await run.session.prompt("ARCHIVE_ROLLOVER_TWO_REQUEST");
    expect(run.requests).toHaveLength(5);
    expect(boundaries(run.manager)).toHaveLength(2);
    const latest = run.requests[4]!;
    expect(encoded(latest)).toContain("ARCHIVE_HANDOFF_TWO");
    for (const old of ["ARCHIVE_NEEDLE_ZERO", "ARCHIVE_ANSWER_ZERO", "ARCHIVE_HANDOFF_ONE", "ARCHIVE_ANSWER_ONE"]) {
      expect(encoded(latest)).not.toContain(old);
    }
    expectNoOldToolPair(latest, ["archive-rollover-one", "archive-rollover-two"]);
    for (const entry of original) expect(run.manager.getEntries()).toContainEqual(entry);
    const persisted = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    for (const entry of original) expect(persisted).toContainEqual(entry);
    run.session.dispose();
    sessions.splice(sessions.indexOf(run.session), 1);

    const resumed = await open(sessionFile);
    expect(resumed.session.sessionFile).toBe(sessionFile);
    expect(resumed.manager.getSessionId()).toBe(sessionId);
    expect(boundaries(resumed.manager)).toHaveLength(2);
    resumed.replies.push(text("RESUMED_ANSWER"));
    await resumed.session.prompt("RESUMED_PROMPT");
    expect(resumed.requests).toHaveLength(1);
    const active = resumed.requests[0]!;
    expect(encoded(active)).toContain("ARCHIVE_HANDOFF_TWO");
    expect(encoded(active)).toContain("ARCHIVE_ANSWER_TWO");
    expect(encoded(active)).not.toContain("ARCHIVE_NEEDLE_ZERO");
    expect(encoded(active)).not.toContain("ARCHIVE_HANDOFF_ONE");
    expectNoOldToolPair(active, ["archive-rollover-one", "archive-rollover-two"]);
    expectInfrastructure(active);

    resumed.replies.push([call("archive-search", "history", { op: "search", query: "ARCHIVE_NEEDLE_ZERO" })], text("HISTORY_FOUND"));
    await resumed.session.prompt("Search the archived original user message.");
    expect(resumed.requests).toHaveLength(3);
    const historyResult = resumed.requests[2]!.messages.find((message) => message.role === "toolResult"
      && message.toolCallId === "archive-search");
    expect(historyResult?.role).toBe("toolResult");
    if (historyResult?.role !== "toolResult") throw new Error("Missing real history tool result");
    expect(historyResult.isError).toBe(false);
    expect(JSON.stringify(historyResult.content)).toContain("ARCHIVE_NEEDLE_ZERO");
    const searchDetails = historyResult.details as {
      results: Array<{ entryId: string; kind: string; windowId: string | null }>;
    };
    const found = searchDetails.results.find((entry) => entry.kind === "user");
    expect(found).toBeDefined();
    expect(found!.windowId).toBeNull();
    expect(original.some((entry) => entry.id === found!.entryId && entry.type === "message"
      && entry.message.role === "user")).toBe(true);

    resumed.replies.push([call("archive-read", "history", { op: "read", entryId: found!.entryId })], text("HISTORY_READ"));
    await resumed.session.prompt("Read that archived entry by its stable ID.");
    expect(resumed.requests).toHaveLength(5);
    const readResult = resumed.requests[4]!.messages.find((message) => message.role === "toolResult"
      && message.toolCallId === "archive-read");
    if (readResult?.role !== "toolResult") throw new Error("Missing real history read result");
    expect(readResult.isError).toBe(false);
    expect(readResult.details).toMatchObject({ entryId: found!.entryId, text: "ARCHIVE_NEEDLE_ZERO", windowId: null });
    expect(JSON.stringify(readResult.content)).toContain("ARCHIVE_NEEDLE_ZERO");
    expectInfrastructure(resumed.requests[4]!);
    for (const entry of original) expect(resumed.manager.getEntries()).toContainEqual(entry);
    expect(resumed.extensionErrors).toEqual([]);
    expect(resumed.replies).toEqual([]);
  });
});

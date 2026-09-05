import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { ToolGroupsController } from "../src/tool-groups";

const MODEL: Model<"openai-completions"> = {
  id: "regression", name: "regression", provider: "pum-context-regression", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1000,
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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pum-context-regression-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "isolated-agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === MODEL.provider;
  const controller = new ContextWindowController();
  const groups = new ToolGroupsController("main");
  const hiddenTool: InlineExtension = { name: "regression-hidden-schema", factory(pi) {
    pi.registerTool({
      name: "worktree", label: "Worktree fixture", description: "A large hidden schema. ".repeat(500),
      parameters: Type.Object({ operation: Type.String() }),
      async execute() { return { content: [{ type: "text", text: "unused" }], details: {} }; },
    });
  } };
  const memory = "injected-context-baseline".repeat(30);
  const injection: InlineExtension = { name: "regression-injection", factory(pi) {
    pi.on("context", (event) => ({ messages: [{ role: "custom", customType: "fixture-memory", content: memory,
      display: false, timestamp: 1 }, ...event.messages] }));
  } };
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Regression system instructions.",
      extensionFactories: [controller.extension(), groups.extension(), hiddenTool, injection],
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: manager, model: MODEL, thinkingLevel: "off", tools: [...CONTEXT_TOOL_NAMES, "enable_tools", "worktree"],
  });
  sessions.push(session);
  // This spy retains and invokes the actual public SDK method. Binding wraps
  // this method per instance; no private hooks or summarizers are replaced.
  const nativeCompact = spyOn(session, "compact");
  controller.bind(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  session.setActiveToolsByName([...CONTEXT_TOOL_NAMES, "enable_tools"]);
  const requests: Context[] = [];
  const replies: AssistantMessage["content"][] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    const content = replies.shift();
    if (!content) throw new Error("Unexpected request or summarizer call");
    const message: AssistantMessage = {
      role: "assistant", content, provider: MODEL.provider, model: MODEL.id, api: MODEL.api, timestamp: Date.now(),
      stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
      usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 5100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  const toolResult = (id: string) => {
    const entry = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
    if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error(`Missing tool result ${id}`);
    return entry.message;
  };
  return { session, manager, runtime, requests, replies, nativeCompact, toolResult, errors };
}

describe("context-window controller regressions through public SDK surfaces", () => {
  test("real enable_tools growth is counted in the same batch and history inherits the smaller budget", async () => {
    const h = await fixture();
    h.replies.push([
      call("before", "get_context_remaining"),
      call("enable", "enable_tools", { groups: ["Worktree"] }),
      call("after", "get_context_remaining"),
      call("history", "history", { op: "search", query: "exact user" }),
    ], [call("next-request", "get_context_remaining")], text("Done"));
    await h.session.prompt("Keep these exact user instructions.");
    expect(h.toolResult("enable").isError).toBe(false);
    expect(h.requests[0]!.tools?.some((tool) => tool.name === "worktree")).toBe(false);
    expect(h.session.agent.state.tools.some((tool) => tool.name === "worktree")).toBe(true);
    const before = h.toolResult("before").details as any;
    const after = h.toolResult("after").details as any;
    const next = h.toolResult("next-request").details as any;
    const history = h.toolResult("history").details as any;
    expect(before.source).toBe("provider_usage");
    expect(before.estimatedOverheadTokens).toBe(0);
    expect(before.usedTokens).toBe(5100);
    expect(after.estimatedOverheadTokens).toBeGreaterThan(2500);
    expect(after.source).toBe("provider_usage_plus_estimate");
    expect(after.remainingTokens).toBeLessThan(before.remainingTokens - 2500);
    expect(history.budget.availableTokens).toBeLessThanOrEqual(after.remainingBeforeReserve);
    expect(h.requests[0]!.tools?.some((tool) => tool.name === "worktree")).toBe(false);
    expect(h.requests[1]!.tools?.some((tool) => tool.name === "worktree")).toBe(true);
    // The next request's usage already includes both injection and new schemas.
    expect(next.usedTokens).toBe(5100);
    expect(next.estimatedOverheadTokens).toBe(0);
    expect(h.errors).toEqual([]);
  });

  test("manual compact after a real rollover never enters native compact, preflight, auth, or summary", async () => {
    const h = await fixture();
    h.replies.push(text("Original answer"));
    await h.session.prompt("Original instruction outside the fresh window");
    h.replies.push([call("roll", "new_context", { handoff: "Literal important handoff" })], text("Fresh answer"));
    await h.session.prompt("Start a fresh window");
    const entries = structuredClone(h.manager.getEntries());
    const messages = structuredClone(h.session.agent.state.messages);
    const leaf = h.manager.getLeafId();
    const requestCount = h.requests.length;
    const abort = spyOn(h.session, "abort");
    const auth = spyOn(h.runtime, "getAuth");
    const append = spyOn(h.manager, "appendCompaction");
    await expect(h.session.compact("Do not summarize earlier windows")).rejects.toThrow("Use new_context instead. The full transcript is retained.");
    expect(h.nativeCompact).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(requestCount);
    expect(h.manager.getEntries()).toEqual(entries);
    expect(h.manager.getLeafId()).toBe(leaf);
    expect(h.session.agent.state.messages).toEqual(messages);
    expect(JSON.stringify(messages)).toContain("Literal important handoff");
    expect(h.errors).toEqual([]);
  });

  test("before rollover public compact delegates unchanged to the real SDK summarizer", async () => {
    const h = await fixture();
    h.replies.push(text("Original answer with enough material to summarize."));
    await h.session.prompt("Original instructions. ".repeat(100));
    const previousRequests = h.requests.length;
    const originalEntries = structuredClone(h.manager.getEntries());
    h.replies.push(text("Actual SDK summary from the fake transport."));
    const result = await h.session.compact("Keep the literal user requirement.");
    expect(h.nativeCompact).toHaveBeenCalledTimes(1);
    expect(h.nativeCompact).toHaveBeenCalledWith("Keep the literal user requirement.");
    expect(h.requests).toHaveLength(previousRequests + 1);
    expect(h.requests.at(-1)?.systemPrompt).toContain("summarization assistant");
    expect(result.summary).toContain("Actual SDK summary from the fake transport.");
    expect(h.manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
    expect(h.manager.getEntries().slice(0, originalEntries.length)).toEqual(originalEntries);
    expect(h.errors).toEqual([]);
  });
});

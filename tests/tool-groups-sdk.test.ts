import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONTEXT_TOOL_NAMES, ContextWindowController } from "../src/context-window";
import { readonlySubagentExtension } from "../src/subagents/readonly";
import {
  ENABLE_TOOLS, READONLY_CHILD_OMITTED_TOOL_NAMES, TOOL_GROUP_NAMES, ToolGroupsController,
  activeToolNames, childAllowedToolNames, mainAllowedToolNames,
  type ToolGroupAudience, type ToolGroupName,
} from "../src/tool-groups";

const root = mkdtempSync(join(tmpdir(), "pum-tool-order-sdk-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
mkdirSync(cwd);
mkdirSync(agentDir);
const sessions: AgentSession[] = [];
afterAll(() => {
  for (const session of sessions) session.dispose();
  rmSync(root, { recursive: true, force: true });
});
const MODEL: Model<"openai-completions"> = {
  id: "tool-order", name: "tool-order", provider: "pum-tool-order", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function fixture(audience: ToolGroupAudience, readonly = false, file?: string) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === MODEL.provider;
  const manager = file ? SessionManager.open(file, sessionDir) : SessionManager.create(cwd, sessionDir);
  const groups = new ToolGroupsController(audience, undefined, readonly);
  groups.load(manager.getSessionFile());
  const contextWindow = new ContextWindowController();
  const allowed = audience === "main" ? mainAllowedToolNames() : childAllowedToolNames(readonly);
  const native = new Set<string>(["read", "write", "edit", "bash", ...CONTEXT_TOOL_NAMES, ENABLE_TOOLS]);
  // Keep the real SDK built-ins, context tools, and enable_tools. Other PUM tool
  // implementations are inert fixtures: this suite tests registration and request
  // construction, not trigger processes, delegation, or memory mutations.
  const otherTools: InlineExtension = { name: "tool-order-fixtures", factory(pi) {
    for (const name of allowed.filter((name) => !native.has(name))) {
      pi.registerTool({
        name, label: name, description: `Fixture for ${name}.`,
        promptSnippet: `Use ${name} for its fixture operation.`,
        promptGuidelines: [`Follow the ${name} fixture guideline.`],
        parameters: Type.Object({ value: Type.Optional(Type.String()) }, { additionalProperties: false }),
        async execute() { return { content: [{ type: "text", text: "unused" }], details: {} }; },
      });
    }
  } };
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [readonlySubagentExtension(readonly), contextWindow.extension(), otherTools, groups.extension()],
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: manager, model: MODEL, thinkingLevel: "off", tools: allowed,
  });
  sessions.push(session);
  contextWindow.bind(session);
  session.setActiveToolsByName(groups.activeTools());
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });
  const requests: Context[] = [];
  const replies: AssistantMessage["content"][] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)));
    const content = replies.shift();
    if (!content) throw new Error("Unexpected SDK request");
    const message: AssistantMessage = {
      role: "assistant", content, provider: MODEL.provider, model: MODEL.id, api: MODEL.api, timestamp: Date.now(),
      stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    return stream;
  };
  const capture = async (order: readonly ToolGroupName[] = []) => {
    for (const group of order) replies.push([{
      type: "toolCall", id: `enable-${group}`, name: ENABLE_TOOLS, arguments: { groups: [group] },
    }]);
    replies.push([{ type: "text", text: "Captured." }]);
    await session.prompt("Capture the active tool contract.");
    expect(errors).toEqual([]);
    const request = requests.at(-1)!;
    // These are the actual SDK stream boundary inputs, not a locally built
    // projection of the controller. Exclude conversation text, which differs.
    return JSON.stringify({ systemPrompt: request.systemPrompt, tools: request.tools });
  };
  return { session, manager, groups, requests, capture };
}

const variants = [
  { audience: "main" as const, readonly: false },
  { audience: "subagent" as const, readonly: false },
  { audience: "subagent" as const, readonly: true },
];

describe("canonical tools through the installed SDK request and prompt construction", () => {
  for (const variant of variants) {
    test(`${variant.audience}, readonly=${variant.readonly}: activation order, resume, and fresh replacement`, async () => {
      const forward = await fixture(variant.audience, variant.readonly);
      const reverse = await fixture(variant.audience, variant.readonly);
      const toolNames = (session: AgentSession) => session.agent.state.tools.map((tool) => tool.name);
      const defaultNames = activeToolNames([], variant.audience, variant.readonly);
      expect(toolNames(forward.session)).toEqual(defaultNames);
      const originalDescription = forward.session.agent.state.tools.find((tool) => tool.name === ENABLE_TOOLS)!.description;
      expect(originalDescription).not.toContain("Currently enabled");
      expect(originalDescription).toContain(variant.audience === "main" ? "memory_edit" : "finish_subagent");
      if (variant.readonly) expect(originalDescription).not.toContain("- Shells:");

      const forwardActivation = await forward.capture(TOOL_GROUP_NAMES);
      expect(await reverse.capture([...TOOL_GROUP_NAMES].reverse())).toBe(forwardActivation);
      // The SDK snapshots the system prompt at turn start. After in-turn tool
      // activation, compare a new turn so both live and resumed prompts reflect
      // the same active set. The activation requests above also match bytewise.
      const forwardRequest = await forward.capture();
      expect(await reverse.capture()).toBe(forwardRequest);
      const allNames = variant.audience === "main" ? mainAllowedToolNames() : childAllowedToolNames(variant.readonly);
      expect(toolNames(forward.session)).toEqual(allNames);
      expect(forward.requests[0]!.tools!.map((tool) => tool.name)).toEqual(defaultNames);
      const finalDescription = forward.requests.at(-1)!.tools!.find((tool) => tool.name === ENABLE_TOOLS)!.description;
      expect(finalDescription).toBe(originalDescription);
      // Every successful call updates state in the tool result, not its schema.
      const results = forward.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
      expect(results).toHaveLength(TOOL_GROUP_NAMES.length);
      const lastResult = results.at(-1)!;
      if (lastResult.type !== "message" || lastResult.message.role !== "toolResult") throw new Error("Missing tool result");
      expect(lastResult.message.isError).toBe(false);
      expect(lastResult.message.content).toEqual([{ type: "text", text: forward.groups.describe() }]);
      expect(lastResult.message.content).not.toEqual([{ type: "text", text: "Enabled tool groups: (none)" }]);

      // prompt() persisted a real assistant turn; open that exact JSONL, not a
      // missing-file fallback. Restore uses sorted persisted group names.
      const file = forward.manager.getSessionFile()!;
      const id = forward.manager.getSessionId();
      forward.session.dispose();
      const resumed = await fixture(variant.audience, variant.readonly, file);
      expect(resumed.manager.getSessionId()).toBe(id);
      expect(toolNames(resumed.session)).toEqual(allNames);
      expect(await resumed.capture()).toBe(forwardRequest);
      // Enabling an already active group does not reorder the next request.
      expect(await resumed.capture(["Worktree", "Admin", "Worktree"])).toBe(forwardRequest);
      if (variant.readonly) {
        for (const name of READONLY_CHILD_OMITTED_TOOL_NAMES) expect(toolNames(resumed.session)).not.toContain(name);
      }
      const replacement = await fixture(variant.audience, variant.readonly);
      expect(replacement.groups.enabledGroups()).toEqual([]);
      expect(toolNames(replacement.session)).toEqual(defaultNames);
      expect(replacement.session.agent.state.tools.find((tool) => tool.name === ENABLE_TOOLS)!.description).toBe(originalDescription);
      // A new controller must not retarget an old runtime's enable_tools closure.
      await replacement.capture(["Todo"]);
      expect(resumed.groups.enabledGroups()).toEqual([...TOOL_GROUP_NAMES].sort());
    });
  }

  test("main and child registration load trusted state before creating services", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf8");
    const factory = main.indexOf("async ({ cwd, sessionManager, sessionStartEvent }) => {");
    const construct = main.indexOf('new ToolGroupsController("main")');
    const load = main.indexOf("mainToolGroups.load(sessionManager.getSessionFile())");
    const services = main.indexOf("await createAgentSessionServices(", factory);
    expect(factory).toBeGreaterThan(-1);
    expect(construct).toBeGreaterThan(factory);
    expect(load).toBeGreaterThan(construct);
    expect(services).toBeGreaterThan(load);
    const child = readFileSync(join(import.meta.dir, "../src/subagents/manager.ts"), "utf8");
    const childConstruct = child.indexOf('new ToolGroupsController("subagent"');
    const childLoad = child.indexOf("record.toolGroups.load(sessionManager.getSessionFile())");
    expect(childConstruct).toBeGreaterThan(-1);
    expect(childLoad).toBeGreaterThan(childConstruct);
    expect(child.indexOf("const services = await createAgentSessionServices("))
      .toBeGreaterThan(childLoad);
  });

  test("equivalent partial sets also follow the role allowlist, with duplicates and unknown groups ignored", () => {
    for (const variant of variants) {
      expect(activeToolNames(["Worktree", "Admin", "Worktree", "unknown"], variant.audience, variant.readonly))
        .toEqual(activeToolNames(["Admin", "Worktree"], variant.audience, variant.readonly));
    }
  });
});

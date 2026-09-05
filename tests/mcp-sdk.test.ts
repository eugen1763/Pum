import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { McpController } from "../src/mcp";
import { MCP_PROTOCOL_VERSION } from "../src/mcp-protocol";
import { readMcpProposal } from "../src/mcp-config";
import { ToolGroupsController, mainAllowedToolNames } from "../src/tool-groups";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const model: Model<"openai-completions"> = {
  id: "mcp-fixture", name: "mcp-fixture", provider: "mcp-fixture", api: "openai-completions",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("installed SDK: inactive MCP cannot execute, reveal grants no consent, exact approval enables calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "pum-mcp-sdk-")); cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const cwd = join(root, "project"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(join(cwd, ".pum"));
  writeFileSync(join(cwd, ".pum", "mcp.json"), JSON.stringify({version: 1, servers: [{name: "echo", executable: "/fake/server", args: []}]}));
  let session: AgentSession | undefined, spawns = 0, serverCalls = 0;
  const controller = new McpController({ cwd, isIdle: () => !!session && !session.isStreaming, spawn: request => {
    spawns++; let finish!: () => void;
    return { completed: new Promise<void>(resolve => { finish = resolve; }), close() {}, kill() { finish(); }, async write(data) {
      const message = JSON.parse(data);
      const reply = (result: unknown) => request.onStdout(JSON.stringify({jsonrpc: "2.0", id: message.id, result}) + "\n");
      if (message.method === "initialize") reply({protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {tools: {}}, serverInfo: {name: "fake", version: "1"}});
      else if (message.method === "tools/list") reply({tools: [{name: "echo", description: "UNTRUSTED_SCHEMA_MARKER", inputSchema: {type: "object", properties: {}, additionalProperties: false}}]});
      else if (message.method === "tools/call") { serverCalls++; reply({content: [{type: "text", text: "SDK_SERVER_RESULT"}]}); }
    }};
  }}); cleanup.push(() => controller.dispose());
  const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false});
  runtime.hasConfiguredAuth = provider => provider === model.provider;
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const groups = new ToolGroupsController("main");
  const services = await createAgentSessionServices({cwd, agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({retry: {enabled: false}, compaction: {enabled: false}}),
    resourceLoaderOptions: {noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [groups.extension(), {name: "mcp-fixture", factory(pi) { for (const tool of controller.tools()) pi.registerTool(tool); }}]},
  });
  ({session} = await createAgentSessionFromServices({services, sessionManager: manager, model, thinkingLevel: "off", tools: mainAllowedToolNames()}));
  cleanup.push(() => session!.dispose()); controller.bind(session); session.setActiveToolsByName(groups.activeTools());
  await session.bindExtensions({onError: error => { throw error; }});
  const replies: AssistantMessage["content"][] = [];
  session.agent.streamFunction = (_model, context) => {
    expect(JSON.stringify(context.tools)).not.toContain("UNTRUSTED_SCHEMA_MARKER");
    const content = replies.shift()!;
    const message: AssistantMessage = {role: "assistant", content, provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
      stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
      usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
    const stream = createAssistantMessageEventStream(); stream.push({type: "done", reason: message.stopReason as "stop" | "toolUse", message}); return stream;
  };
  let index = 0;
  async function invoke(name: string, args: Record<string, unknown>) {
    const id = `mcp-sdk-${index++}`;
    replies.push([{type: "toolCall", id, name, arguments: args}], [{type: "text", text: "done"}]);
    await session!.prompt("Run fixture");
    const entry = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
    if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Missing result");
    return entry.message;
  }
  expect((await invoke("mcp_call", {server: "echo", tool: "echo", arguments: {}})).isError).toBe(true); expect(spawns).toBe(0);
  expect((await invoke("enable_tools", {groups: ["MCP"]})).isError).toBe(false);
  expect(session.agent.state.tools.map(tool => tool.name)).toContain("mcp_call");
  expect((await invoke("mcp_call", {server: "echo", tool: "echo", arguments: {}})).isError).toBe(true); expect(spawns).toBe(0);
  await controller.command("/mcp");
  const discovery = await controller.command("/mcp connect echo " + readMcpProposal(cwd).digest);
  const digest = /Toolset SHA-256: ([a-f0-9]+)/.exec(discovery)![1]!;
  await controller.command("/mcp approve echo " + digest);
  const result = await invoke("mcp_call", {server: "echo", tool: "echo", arguments: {}});
  expect(result.isError).toBe(false); expect(JSON.stringify(result.content)).toContain("SDK_SERVER_RESULT");
  expect(serverCalls).toBe(1); expect(spawns).toBe(1);
});

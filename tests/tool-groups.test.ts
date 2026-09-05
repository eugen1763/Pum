import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ContextWindowController, CONTEXT_TOOL_NAMES } from "../src/context-window";
import {
  ADMIN_GROUP_TOOL_NAMES,
  ALL_GROUP_TOOL_NAMES,
  CHILD_EXTRA_TOOL_NAMES,
  CORE_TOOL_NAMES,
  ENABLE_TOOLS,
  MAIN_EXTRA_TOOL_NAMES,
  MCP_GROUP_TOOL_NAMES,
  LSP_GROUP_TOOL_NAMES,
  SHELLS_GROUP_TOOL_NAMES,
  ToolGroupsController,
  TOOL_GROUP_NAMES,
  activeToolNames,
  afkAllowedToolNames,
  childAllowedToolNames,
  judgeAllowedToolNames,
  loadToolGroups,
  mainAllowedToolNames,
  saveToolGroups,
  toolGroupsFileFor,
  toolNamesInGroup,
} from "../src/tool-groups";

const root = mkdtempSync(join(tmpdir(), "pum-tool-groups-"));
const repo = join(root, "repo");
const agentDir = join(root, "agent");
const sessionDirPath = join(root, "sessions");

mkdirSync(repo);
mkdirSync(agentDir);
mkdirSync(sessionDirPath);
const gitNow = execFileSync("git", ["init", "-b", "main"], { cwd: repo, encoding: "utf8" });
void gitNow;
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    mock: {
      baseUrl: "http://127.0.0.1:9/v1",
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
  rmSync(root, { recursive: true, force: true });
});

/**
 * Registers the hidden group tool names so the focused session test can prove
 * the grouping wire. The real implementations live in the trigger and
 * message-cache extensions; their own tests cover their behaviour.
 */
const groupToolStubExtension = {
  name: "pum-tool-groups-stubs",
  factory: (pi: { registerTool: (tool: any) => void }) => {
    for (const name of ALL_GROUP_TOOL_NAMES) {
      pi.registerTool({
        name,
        label: name,
        description: `Test registration for ${name}`,
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => ({
          content: [{ type: "text" as const, text: "stub" }],
        }),
      });
    }
  },
};

describe("tool group membership", () => {
  test("core tools include own-session context tools, but internal agents do not", () => {
    expect([...CORE_TOOL_NAMES].sort()).toEqual([
      "bash", "edit", "get_context_remaining", "history", "memory_read",
      "new_context", "questionnaire", "read", "write",
    ]);
    expect(activeToolNames([], "main").sort()).toEqual([
      ...CORE_TOOL_NAMES, "enable_tools", "memory_edit",
    ].sort());
    expect(activeToolNames([], "subagent").sort()).toEqual([
      ...CORE_TOOL_NAMES, "enable_tools", "finish_subagent",
    ].sort());
    expect(judgeAllowedToolNames().sort()).toEqual(["bash", "goal_verdict", "read"]);
    expect(afkAllowedToolNames()).toEqual(["afk_answer"]);
  });

  test("main sessions expose only core tools plus enable_tools by default", () => {
    const active = activeToolNames([], "main");
    for (const core of [...CORE_TOOL_NAMES, ...MAIN_EXTRA_TOOL_NAMES, ENABLE_TOOLS]) {
      expect(active).toContain(core);
    }
    for (const group of TOOL_GROUP_NAMES) {
      for (const tool of toolNamesInGroup(group)) {
        expect(active).not.toContain(tool);
      }
    }
  });

  test("child sessions add the child-only core tool", () => {
    const active = activeToolNames([], "subagent");
    for (const core of [...CORE_TOOL_NAMES, ...CHILD_EXTRA_TOOL_NAMES, ENABLE_TOOLS]) {
      expect(active).toContain(core);
    }
    for (const group of TOOL_GROUP_NAMES) {
      for (const tool of toolNamesInGroup(group)) {
        expect(active).not.toContain(tool);
      }
    }
    for (const mainOnly of MAIN_EXTRA_TOOL_NAMES) expect(active).not.toContain(mainOnly);
  });

  test("readonly children omit mutation tools from core, allowlist, and enabled groups", () => {
    const active = activeToolNames(["Admin", "Subagents", "Worktree", "Shells"], "subagent", true);
    for (const tool of [
      "write", "edit", "spawn_subagent", "message_agent", "create_trigger",
      "resume_trigger", "invoke_trigger", "message_cache_add", "message_cache_delete",
      "message_cache_send", ...SHELLS_GROUP_TOOL_NAMES,
    ]) {
      expect(active).not.toContain(tool);
      expect(childAllowedToolNames(true)).not.toContain(tool);
    }
    for (const tool of [
      "read", "bash", "finish_subagent", "list_subagents", "message_cache_list", "message_cache_read", "list_triggers", "inspect_trigger",
      "pause_trigger", "cancel_trigger", "worktree", ...CONTEXT_TOOL_NAMES,
    ]) {
      expect(active).toContain(tool);
      expect(childAllowedToolNames(true)).toContain(tool);
    }
  });

  test("enabling a group adds exactly its tools and leaves other groups hidden", () => {
    const active = activeToolNames(["Admin"], "main");
    for (const tool of ADMIN_GROUP_TOOL_NAMES) {
      expect(active).toContain(tool);
    }
    for (const tool of [...TOOL_GROUP_NAMES.flatMap((name) => toolNamesInGroup(name))]) {
      if (!ADMIN_GROUP_TOOL_NAMES.includes(tool as (typeof ADMIN_GROUP_TOOL_NAMES)[number])) {
        expect(active).not.toContain(tool);
      }
    }
  });

  test("Shells is hidden until enabled and readonly children never expose it", () => {
    const hiddenMain = activeToolNames([], "main");
    const mutableMain = activeToolNames(["Shells"], "main");
    const mutableChild = activeToolNames(["Shells"], "subagent");
    const readonlyChild = activeToolNames(["Shells"], "subagent", true);
    for (const tool of SHELLS_GROUP_TOOL_NAMES) {
      expect(hiddenMain).not.toContain(tool);
      expect(mutableMain).toContain(tool);
      expect(mutableChild).toContain(tool);
      expect(readonlyChild).not.toContain(tool);
    }
  });

  test("core tools and enable_tools are present in every group combination", () => {
    for (const enabled of [[], ["Admin"], ["Subagents", "Worktree"], ["Admin", "Subagents", "Worktree", "Shells"]]) {
      const active = activeToolNames(enabled, "main");
      for (const core of [...CORE_TOOL_NAMES, ...MAIN_EXTRA_TOOL_NAMES, ENABLE_TOOLS]) {
        expect(active).toContain(core);
      }
    }
  });

  test("an unknown group name contributes no tools", () => {
    expect(toolNamesInGroup("News")).toEqual([]);
    expect(activeToolNames(["News"], "main")).toEqual(activeToolNames([], "main"));
    // The News group is dropped entirely because PUM has no news model tool.
    expect(TOOL_GROUP_NAMES).not.toContain("News");
  });

  test("the allowlists cover core, enable_tools, and every group tool", () => {
    for (const tool of [...CORE_TOOL_NAMES, ...MAIN_EXTRA_TOOL_NAMES, ENABLE_TOOLS, ...ALL_GROUP_TOOL_NAMES]) {
      expect(mainAllowedToolNames()).toContain(tool);
    }
    for (const tool of [...CHILD_EXTRA_TOOL_NAMES]) {
      expect(childAllowedToolNames()).toContain(tool);
    }
    for (const tool of [...ALL_GROUP_TOOL_NAMES]) {
      if (([...MCP_GROUP_TOOL_NAMES, ...LSP_GROUP_TOOL_NAMES] as readonly string[]).includes(tool)) expect(childAllowedToolNames()).not.toContain(tool);
      else expect(childAllowedToolNames()).toContain(tool);
    }
  });

  test("MCP has static main-only names and revealing does not expose server schemas", () => {
    expect(toolNamesInGroup("MCP")).toEqual(["mcp_list", "mcp_call"]);
    expect(activeToolNames(["MCP"], "main")).toEqual([...activeToolNames([], "main"), ...MCP_GROUP_TOOL_NAMES]);
    for (const readonly of [false, true]) {
      const child = new ToolGroupsController("subagent", undefined, readonly);
      expect(child.availableGroups()).not.toContain("MCP");
      expect(() => child.enableGroup("MCP")).toThrow(/Unknown tool group/);
      expect(activeToolNames(["MCP"], "subagent", readonly)).toEqual(activeToolNames([], "subagent", readonly));
      for (const name of MCP_GROUP_TOOL_NAMES) {
        expect(childAllowedToolNames(readonly)).not.toContain(name);
        expect(judgeAllowedToolNames()).not.toContain(name);
        expect(afkAllowedToolNames()).not.toContain(name);
      }
    }
  });

  test("LSP is hidden, cached-read-only and excluded from every worker role", () => {
    expect(toolNamesInGroup("LSP")).toEqual(["lsp_diagnostics"]);
    expect(activeToolNames([], "main")).not.toContain("lsp_diagnostics");
    expect(activeToolNames(["LSP"], "main")).toEqual([...activeToolNames([], "main"), ...LSP_GROUP_TOOL_NAMES]);
    const sessionFile = join(sessionDirPath, "lsp-role.jsonl");
    saveToolGroups(sessionFile, ["LSP"]);
    for (const readonly of [false, true]) {
      const child = new ToolGroupsController("subagent", sessionFile, readonly);
      child.load();
      expect(child.availableGroups()).not.toContain("LSP");
      expect(child.enabledGroups()).toEqual([]);
      expect(() => child.enableGroup("LSP")).toThrow(/Unknown tool group/);
      expect(childAllowedToolNames(readonly)).not.toContain("lsp_diagnostics");
      expect(activeToolNames(["LSP"], "subagent", readonly)).toEqual(activeToolNames([], "subagent", readonly));
    }
    expect(judgeAllowedToolNames()).not.toContain("lsp_diagnostics");
    expect(afkAllowedToolNames()).not.toContain("lsp_diagnostics");
  });

  test("restored MCP visibility is filtered for workers", () => {
    const sessionFile = join(sessionDirPath, "mcp-role.jsonl");
    saveToolGroups(sessionFile, ["MCP", "Todo"]);
    const main = new ToolGroupsController("main", sessionFile);
    const child = new ToolGroupsController("subagent", sessionFile);
    main.load(); child.load();
    expect(main.enabledGroups()).toEqual(["MCP", "Todo"]);
    expect(child.enabledGroups()).toEqual(["Todo"]);
    expect(child.describe()).not.toContain("MCP");
  });

  test("allowlists contain no duplicate names", () => {
    expect(new Set(mainAllowedToolNames()).size).toBe(mainAllowedToolNames().length);
    expect(new Set(childAllowedToolNames()).size).toBe(childAllowedToolNames().length);
  });
});

describe("tool group persistence", () => {
  const persistRoot = join(root, "persist");
  const sessionFile = join(persistRoot, "sessions", "session-id.jsonl");

  test("saves and reloads enabled groups next to the session file", () => {
    mkdirSync(dirname(sessionFile), { recursive: true });
    saveToolGroups(sessionFile, ["Admin", "Worktree"]);
    expect(loadToolGroups(sessionFile)).toEqual(["Admin", "Worktree"]);
    expect(JSON.parse(readFileSync(toolGroupsFileFor(sessionFile), "utf8")))
      .toEqual(["Admin", "Worktree"]);
  });

  test("load tolerates unknown groups, duplicates, and corrupt files", () => {
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(
      toolGroupsFileFor(sessionFile),
      JSON.stringify(["Admin", "News", "Admin", "Worktree", 42]),
      "utf8",
    );
    expect(loadToolGroups(sessionFile)).toEqual(["Admin", "Worktree"]);
    writeFileSync(toolGroupsFileFor(sessionFile), "{ not json", "utf8");
    expect(loadToolGroups(sessionFile)).toEqual([]);
    expect(loadToolGroups(undefined)).toEqual([]);
    expect(loadToolGroups(join(sessionFile, "..", "missing.jsonl"))).toEqual([]);
  });

  test("controller load restores persisted state and enables persist it again", () => {
    mkdirSync(dirname(sessionFile), { recursive: true });
    rmSync(toolGroupsFileFor(sessionFile), { force: true });
    const controller = new ToolGroupsController("main");
    controller.load(sessionFile);
    expect(controller.enabledGroups()).toEqual([]);
    controller.enableGroup("Worktree");
    expect(controller.enabledGroups()).toEqual(["Worktree"]);
    expect(loadToolGroups(sessionFile)).toEqual(["Worktree"]);
    expect(controller.activeTools()).toContain("worktree");
    const fresh = new ToolGroupsController("subagent");
    fresh.load(sessionFile);
    expect(fresh.enabledGroups()).toEqual(["Worktree"]);
    expect(fresh.activeTools()).toContain("worktree");
    expect(fresh.activeTools()).toContain("finish_subagent");

    const readonlyChild = new ToolGroupsController("subagent", undefined, true);
    readonlyChild.load(sessionFile);
    expect(readonlyChild.activeTools()).toContain("worktree");
    expect(readonlyChild.activeTools()).not.toContain("write");
  });

  test("enableGroup rejects unknown groups without persisting", () => {
    mkdirSync(dirname(sessionFile), { recursive: true });
    rmSync(toolGroupsFileFor(sessionFile), { force: true });
    const controller = new ToolGroupsController("main");
    controller.load(sessionFile);
    expect(() => controller.enableGroup("News")).toThrow(/Unknown tool group/);
    expect(controller.enabledGroups()).toEqual([]);
  });

  test("describe reports enabled and hidden groups for the model", () => {
    const controller = new ToolGroupsController("main");
    controller.load(undefined);
    expect(controller.describe()).toContain("Enabled tool groups: (none)");
    expect(controller.describe()).toContain("Hidden tool groups: Admin, Subagents, Worktree, Shells");
    controller.enableGroup("Admin");
    expect(controller.describe()).toContain("Enabled tool groups: Admin");
    expect(controller.describe()).toContain("Hidden tool groups: Subagents, Worktree, Shells");
  });
});

describe("tool group wiring in a real session", () => {
  test("hidden schemas are absent until enable_tools, then survive a resume", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const model = runtime.getModel("mock", "mock-model");
    expect(model).toBeDefined();

    const groups = new ToolGroupsController("main");
    const contextWindow = new ContextWindowController();
    const services = await createAgentSessionServices({
      cwd: repo,
      agentDir,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [contextWindow.extension(), groupToolStubExtension, groups.extension()] },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(repo, sessionDirPath),
      model,
      tools: mainAllowedToolNames(),
    });
    contextWindow.bind(result.session);
    const sessionFile = result.session.sessionFile;
    expect(sessionFile).toBeDefined();
    groups.load(sessionFile);
    result.session.setActiveToolsByName(groups.activeTools());

    const toolNames = () => result.session.agent.state.tools.map((tool) => tool.name);

    // Core tools and enable_tools are always present.
    for (const core of ["read", "write", "edit", "bash", ...CONTEXT_TOOL_NAMES, ENABLE_TOOLS]) {
      expect(toolNames()).toContain(core);
    }
    expect(toolNames()).not.toContain("apply_patch");
    // Hidden groups are completely absent from the outgoing tool list.
    for (const tool of ["create_trigger", "message_cache_list", "spawn_subagent", "worktree"]) {
      expect(toolNames()).not.toContain(tool);
    }

    // Invoke the real enable_tools tool.
    const enableTool = result.session.agent.state.tools.find((tool) => tool.name === ENABLE_TOOLS);
    expect(enableTool).toBeDefined();
    await enableTool!.execute("enable-admin", { groups: ["Admin"] });

    // The Admin group's real schemas are now present from the next request onward.
    expect(toolNames()).toContain("create_trigger");
    expect(toolNames()).toContain("message_cache_list");
    // Other groups stay hidden.
    expect(toolNames()).not.toContain("spawn_subagent");
    expect(toolNames()).not.toContain("worktree");
    // The state persists next to the session file.
    expect(loadToolGroups(sessionFile)).toEqual(["Admin"]);
    expect(existsSync(toolGroupsFileFor(sessionFile!))).toBe(true);

    result.session.dispose();

    // Resume: a new session over the same file restores the enabled group.
    const groups2 = new ToolGroupsController("main");
    const contextWindow2 = new ContextWindowController();
    const services2 = await createAgentSessionServices({
      cwd: repo,
      agentDir,
      modelRuntime: runtime,
      resourceLoaderOptions: { extensionFactories: [contextWindow2.extension(), groupToolStubExtension, groups2.extension()] },
    });
    const resumed = await createAgentSessionFromServices({
      services: services2,
      sessionManager: SessionManager.open(sessionFile!, sessionDirPath),
      model,
      tools: mainAllowedToolNames(),
    });
    contextWindow2.bind(resumed.session);
    groups2.load(resumed.session.sessionFile);
    expect(groups2.enabledGroups()).toEqual(["Admin"]);
    resumed.session.setActiveToolsByName(groups2.activeTools());
    const resumedTools = resumed.session.agent.state.tools.map((tool) => tool.name);
    expect(resumedTools).toContain("create_trigger");
    for (const name of CONTEXT_TOOL_NAMES) expect(resumedTools).toContain(name);
    resumed.session.dispose();
  });
});

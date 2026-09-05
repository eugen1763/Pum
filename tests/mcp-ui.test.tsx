import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { readFileSync } from "node:fs";
import { ProjectValidationController } from "../src/project-validation";
import { checkpointControllerForSession, createFileCheckpointExtension } from "../src/file-checkpoints";

let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); destroy = undefined; });
async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce(); await setup.flush();
  await new Promise(resolve => setTimeout(resolve, 25));
  await setup.renderOnce(); await setup.flush();
}
async function fixture(stashedText?: string, sentHistory: string[] = []) {
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true, exitOnCtrlC: false });
  destroy = () => setup.renderer.destroy();
  const calls: string[] = [];
  const commands: string[] = [];
  const listeners = new Set<(event: any) => void>();
  const emit = (event: any) => { for (const listener of listeners) listener(event); };
  const childLines: {line: any; options: any}[] = [];
  const model = { id: "plain", name: "Plain", provider: "mock", reasoning: false, input: ["text"], contextWindow: 32000 };
  const session = {
    agent: { state: { model, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [], appendCustomEntry: () => calls.push("persist") },
    sessionId: "mcp-ui-main", subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => { calls.push("abort"); },
    prompt: async () => { calls.push("main prompt"); }, steer: async () => { calls.push("steer"); },
  } as any;
  const child = {
    id: "child", name: "worker", task: "test", status: "idle", readonly: false, parentAgentId: null,
    worktree: { name: "worker", path: process.cwd(), branch: "main", baseBranch: "main", baseCommit: "abc" },
    modelId: "mock/plain", thinkingLevel: "off", transcript: { lines: [], stream: null, pending: [] },
    startedAt: 1, updatedAt: 1, usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
  };
  const manager = {
    getAgents: () => [child], getAgent: (id: string) => id === "child" ? child : undefined,
    subscribe: () => () => {}, bindMainSession: async () => {}, resendUndeliveredMainSettlements: async () => {},
    sendUserMessage: async () => { calls.push("child prompt"); }, persistToolEvent() {},
    appendAgentLine(_id: string, line: any, options: any) { childLines.push({line, options}); },
  } as any;
  let command = async (text: string) => "MCP preview: " + text;
  const controller = { command: (text: string) => { commands.push(text); return command(text); }, cancel: () => calls.push("cancel") } as any;
  let current: any = controller;
  const authorityCalls: string[] = [];
  session.dispose = () => {};
  session.sessionManager.getCwd = () => process.cwd();
  const validation = new ProjectValidationController({ cwd: process.cwd() });
  validation.bind(session);
  validation.enable = () => { authorityCalls.push("enable"); };
  validation.disable = () => { authorityCalls.push("disable"); };
  validation.preview = () => { authorityCalls.push("preview"); return "validation preview"; };
  validation.status = () => "validation status";
  const handlers = new Map<string, (...args: any[]) => any>();
  const extension = createFileCheckpointExtension();
  if (typeof extension === "function") throw new Error("expected named extension");
  extension.factory({ on: (name: string, fn: any) => handlers.set(name, fn), registerTool() {} } as any);
  handlers.get("session_start")!({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => session.sessionId } });
  const checkpoints = checkpointControllerForSession(session.sessionId)!;
  checkpoints.recover = async () => { authorityCalls.push("recover"); return "/test/recovery-copy"; };
  checkpoints.clear = () => { authorityCalls.push("clear"); };
  checkpoints.list = () => { authorityCalls.push("list"); return []; };
  destroy = () => { setup.renderer.destroy(); validation.dispose(); handlers.get("session_shutdown")!(); };
  const settings = { showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off", webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off", checkModel: "mock/plain", maxActiveSubagents: 10 } as any;
  createRoot(setup.renderer).render(<App session={session}
    modelRuntime={{ getAvailableSnapshot: () => [model], getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
    settings={settings} searchProviders={[]} subagentManager={manager}
    mcpForSession={target => target === session ? current : undefined}
    promptHistoryStore={{ load: () => sentHistory, append: () => { calls.push("history"); return sentHistory; }, remove: () => [] }}
    promptStashStore={{ load: () => stashedText ? [{ text: stashedText, executed: false }] : [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }}
  />);
  await settle(setup);
  return { setup, calls, commands, authorityCalls, childLines, child, session, manager, emit,
    setCommand: (fn: typeof command) => { command = fn; }, retire: () => { current = undefined; } };
}
async function submit(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text.includes(" ") ? text : text + " "); await settle(setup);
  setup.mockInput.pressEnter(); await settle(setup);
}

async function checkout(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  setup.mockInput.pressTab(); await settle(setup);
  setup.mockInput.pressArrow("up"); await settle(setup);
  setup.mockInput.pressTab(); await settle(setup);
}

const protectedCommands = [
  "/mcp connect server " + "a".repeat(64),
  "/mcp approve server " + "b".repeat(64),
  "/validation enable " + "c".repeat(64),
  "/checkpoint recover cp-test",
  "/checkpoint clear",
];

describe("draft provenance across rendered command input", () => {
  for (const text of protectedCommands) {
    for (const route of ["single cached execution", "checkout Enter", "empty-history Down", "history Up Down", "edited checkout", "view switch", "stash deletion"] as const) {
      test(`${text.split(" ").slice(0, 2).join(" ")}: ${route} cannot grant authority`, async () => {
        const f = await fixture(text, route === "history Up Down" ? ["previous user message"] : []);
        if (route === "single cached execution") {
          f.setup.mockInput.pressTab(); await settle(f.setup);
          f.setup.mockInput.pressArrow("up"); await settle(f.setup);
        } else {
          await checkout(f.setup);
          expect(f.setup.captureCharFrame()).toContain(text);
          if (route === "history Up Down") {
            f.setup.mockInput.pressArrow("up"); await settle(f.setup);
            expect(f.setup.captureCharFrame()).toContain("previous user message");
          }
          if (route === "empty-history Down" || route === "history Up Down") {
            f.setup.mockInput.pressArrow("down"); await settle(f.setup);
            expect(f.setup.captureCharFrame()).toContain(text);
          }
          if (route === "edited checkout") { await f.setup.mockInput.typeText(" "); await settle(f.setup); }
          if (route === "view switch" || route === "stash deletion") {
            f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
            if (route === "stash deletion") {
              f.setup.mockInput.pressTab(); await settle(f.setup);
              f.setup.mockInput.pressArrow("up"); await settle(f.setup);
              f.setup.mockInput.pressKey("DELETE"); await settle(f.setup);
              expect(f.setup.captureCharFrame()).not.toContain(text);
            }
            f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
            expect(f.setup.captureCharFrame()).toContain(text);
          }
        }
        f.setup.mockInput.pressEnter(); await settle(f.setup);
        expect(f.commands).toEqual([]);
        expect(f.authorityCalls).toEqual([]);
        expect(f.calls).toEqual([]);
        expect(f.setup.captureCharFrame()).toContain("commands require direct user input");
      });
    }
    test(`fresh direct ${text.split(" ").slice(0, 2).join(" ")} works after explicitly clearing cached draft`, async () => {
      const f = await fixture(text);
      await checkout(f.setup);
      f.setup.mockInput.pressCtrlC(); await settle(f.setup);
      expect(f.setup.captureCharFrame()).not.toContain(text);
      await submit(f.setup, text);
      expect(f.commands.length + f.authorityCalls.length).toBe(1);
      expect(f.calls).toEqual([]);
    });
  }
  for (const text of ["/mcp", "/mcp revoke server", "/mcp disconnect server", "/validation", "/validation status", "/validation disable", "/checkpoint", "/checkpoint list"]) {
    test(`conservative preview/revocation policy: recalled ${text} stays inert`, async () => {
      const f = await fixture(text);
      await checkout(f.setup);
      // Tab and Enter completion must preserve a restored draft's origin too.
      if (!text.includes(" ")) { f.setup.mockInput.pressTab(); await settle(f.setup); }
      f.setup.mockInput.pressEnter(); await settle(f.setup);
      expect(f.commands).toEqual([]); expect(f.authorityCalls).toEqual([]);
      expect(f.setup.captureCharFrame()).toContain("commands require direct user input");
    });
  }
  for (const text of protectedCommands) {
    test(`failed delivery restoration plus editing/history cannot authorize ${text.split(" ").slice(0, 2).join(" ")}`, async () => {
      const f = await fixture(undefined, ["previous message"]);
      f.session.prompt = async () => { throw new Error("test delivery failed"); };
      await submit(f.setup, "x" + text);
      expect(f.setup.captureCharFrame()).toContain("x" + text);
      f.setup.mockInput.pressKey("HOME"); f.setup.mockInput.pressKey("DELETE"); await settle(f.setup);
      f.setup.mockInput.pressArrow("up"); await settle(f.setup);
      f.setup.mockInput.pressArrow("down"); await settle(f.setup);
      f.setup.mockInput.pressEnter(); await settle(f.setup);
      expect(f.commands).toEqual([]); expect(f.authorityCalls).toEqual([]);
      expect(f.setup.captureCharFrame()).toContain("commands require direct user input");
    });
    test(`queued worker recall and view restoration retain untrusted origin: ${text.split(" ").slice(0, 2).join(" ")}`, async () => {
      const f = await fixture();
      (f.child.transcript.pending as any[]).push({ id: "queued", line: { kind: "text", role: "user", text }, deliveryText: text });
      let recalls = 0;
      f.manager.recallQueuedUserMessage = async () => { recalls++; return { id: "queued", text }; };
      f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
      f.setup.mockInput.pressArrow("up"); await settle(f.setup);
      expect(recalls).toBe(1);
      expect(f.setup.captureCharFrame()).toContain(text);
      f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
      f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
      await f.setup.mockInput.typeText(" "); await settle(f.setup);
      f.setup.mockInput.pressEnter(); await settle(f.setup);
      expect(f.commands).toEqual([]); expect(f.authorityCalls).toEqual([]);
      expect(f.childLines.some(({ line }) => line.text.includes("commands require direct user input"))).toBe(true);
    });
  }
  test("replacing every character of a cached draft by editing does not silently make it direct", async () => {
    const cached = "/mcp status";
    const f = await fixture(cached);
    await checkout(f.setup);
    f.setup.mockInput.pressKey("HOME");
    for (let index = 0; index < cached.length; index++) f.setup.mockInput.pressKey("DELETE");
    await settle(f.setup);
    expect(f.setup.captureCharFrame()).not.toContain(cached);
    await submit(f.setup, protectedCommands[0]!);
    expect(f.commands).toEqual([]);
    expect(f.setup.captureCharFrame()).toContain("commands require direct user input");
  });
  for (const text of ["/mcp sta", "/validation sta", "/checkpoint cle"]) {
    test(`argument completion of cached ${text} cannot grant authority`, async () => {
      const f = await fixture(text);
      await checkout(f.setup);
      f.setup.mockInput.pressEnter(); await settle(f.setup);
      expect(f.commands).toEqual([]); expect(f.authorityCalls).toEqual([]);
      expect(f.setup.captureCharFrame()).toContain("commands require direct user input");
    });
  }
  test("main text-only queued recall cannot become consent after editing and history restoration", async () => {
    const f = await fixture(undefined, ["previous message"]);
    let queue: string[] = [];
    f.session.getSteeringMessages = () => queue;
    f.session.getFollowUpMessages = () => [];
    f.session.clearQueue = () => { const steering = queue; queue = []; return { steering, followUp: [] }; };
    f.session.steer = async (text: string) => { queue.push(text); };
    f.emit({ type: "agent_start" }); await settle(f.setup);
    const text = protectedCommands[0]!;
    await submit(f.setup, "x" + text);
    expect(queue).toEqual(["x" + text]);
    f.setup.mockInput.pressArrow("up"); await settle(f.setup);
    expect(queue).toEqual([]);
    f.emit({ type: "agent_settled" }); await settle(f.setup);
    f.setup.mockInput.pressKey("HOME"); f.setup.mockInput.pressKey("DELETE"); await settle(f.setup);
    f.setup.mockInput.pressArrow("up"); await settle(f.setup);
    f.setup.mockInput.pressArrow("down"); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.commands).toEqual([]);
    expect(f.setup.captureCharFrame()).toContain("commands require direct user input");
  });
  test("fresh draft retains authority through per-view save and restore", async () => {
    const f = await fixture();
    const text = protectedCommands[0]!;
    await f.setup.mockInput.typeText(text); await settle(f.setup);
    f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
    f.setup.mockInput.pressTab({ shift: true }); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.commands).toEqual([text]);
  });
});

describe("main TUI direct MCP authority boundary", () => {
  test("preview and commands are transient direct-user calls, not prompts or cache history", async () => {
    const f = await fixture();
    for (const text of ["/mcp", "/mcp connect server " + "a".repeat(64), "/mcp approve server " + "b".repeat(64), "/mcp revoke server", "/mcp disconnect server"]) await submit(f.setup, text);
    expect(f.commands).toHaveLength(5);
    expect(f.setup.captureCharFrame()).toContain("MCP preview:");
    expect(f.calls).toEqual([]);
  });
  test("direct keyboard command completion still previews MCP", async () => {
    const f = await fixture();
    await f.setup.mockInput.typeText("/mcp"); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.commands).toEqual(["/mcp"]); expect(f.calls).toEqual([]);
  });
  test("busy refuses connect/approve but permits revoke/disconnect", async () => {
    const f = await fixture();
    f.emit({ type: "agent_start" }); await settle(f.setup);
    await submit(f.setup, "/mcp connect server " + "a".repeat(64));
    await submit(f.setup, "/mcp approve server " + "b".repeat(64));
    expect(f.commands).toEqual([]);
    expect(f.setup.captureCharFrame()).toContain("become idle");
    await submit(f.setup, "/mcp revoke server"); await submit(f.setup, "/mcp disconnect server");
    expect(f.commands).toEqual(["/mcp revoke server", "/mcp disconnect server"]);
    expect(f.calls).toEqual([]);
  });
  test("selected mutable and readonly workers never dispatch to main controller", async () => {
    const f = await fixture(); f.setup.mockInput.pressTab({shift: true}); await settle(f.setup);
    for (const readonly of [false, true]) {
      f.child.readonly = readonly;
      await submit(f.setup, "/mcp"); await submit(f.setup, "/mcp connect server " + "a".repeat(64));
    }
    expect(f.commands).toEqual([]); expect(f.calls).toEqual([]);
    expect(f.childLines).toHaveLength(4);
    expect(f.childLines.every(({line, options}) => line.text.includes("main TUI session") && options.persist === false)).toBe(true);
  });
  test("executing a cached MCP prompt never grants preview or connection authority", async () => {
    const f = await fixture("/mcp connect server " + "a".repeat(64));
    f.setup.mockInput.pressTab(); await settle(f.setup);
    f.setup.mockInput.pressArrow("up"); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.setup.captureCharFrame()).toContain("MCP commands require direct user input");
    expect(f.commands).toEqual([]); expect(f.calls).toEqual([]);
  });
  test("checking a cached MCP prompt out into the editor still cannot authorize", async () => {
    const f = await fixture("/mcp connect server " + "a".repeat(64));
    f.setup.mockInput.pressTab(); await settle(f.setup);
    f.setup.mockInput.pressArrow("up"); await settle(f.setup);
    f.setup.mockInput.pressTab(); await settle(f.setup);
    f.setup.mockInput.pressEnter(); await settle(f.setup);
    expect(f.setup.captureCharFrame()).toContain("MCP commands require direct user input");
    expect(f.commands).toEqual([]); expect(f.calls).toEqual([]);
  });
  test("missing controller and failures stay local without raw error details", async () => {
    const f = await fixture();
    f.setCommand(async () => { throw new Error("private raw failure"); });
    await submit(f.setup, "/mcp");
    expect(f.setup.captureCharFrame()).toContain("MCP request failed");
    expect(f.setup.captureCharFrame()).not.toContain("private raw failure");
    f.retire(); await submit(f.setup, "/mcp");
    expect(f.setup.captureCharFrame()).toContain("MCP is unavailable"); expect(f.calls).toEqual([]);
  });
  test("pending results cannot appear after runtime retirement", async () => {
    const f = await fixture(); let finish!: (text: string) => void;
    f.setCommand(() => new Promise(resolve => { finish = resolve; }));
    await submit(f.setup, "/mcp"); f.retire(); finish("STALE MCP REPORT"); await settle(f.setup);
    expect(f.setup.captureCharFrame()).not.toContain("STALE MCP REPORT"); expect(f.calls).toEqual([]);
  });
  test("main abort withdraws MCP authority before aborting", async () => {
    const f = await fixture(); f.emit({type: "agent_start"}); await settle(f.setup);
    f.setup.mockInput.pressEscape(); await settle(f.setup); f.setup.mockInput.pressEscape(); await settle(f.setup);
    expect(f.calls).toEqual(["cancel", "abort"]);
  });
  test("main factory owns fresh controllers and explicit disposal, never SDK command registration", () => {
    const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    const factory = main.indexOf("async ({ cwd, sessionManager, sessionStartEvent }) => {");
    expect(main.indexOf("new McpController", factory)).toBeGreaterThan(factory);
    expect(main).toContain("mcp.bind(result.session)"); expect(main).toContain("try { mcp.dispose(); } finally { disposeSession(); }");
    expect(main).toContain("mcpControllers.delete(result.session)");
    expect(main).not.toMatch(/registerCommand\(["']mcp/);
    const headless = readFileSync(new URL("../src/headless.ts", import.meta.url), "utf8");
    const workers = readFileSync(new URL("../src/subagents/manager.ts", import.meta.url), "utf8");
    expect(headless).not.toContain("McpController"); expect(workers).not.toContain("McpController");
  });
});

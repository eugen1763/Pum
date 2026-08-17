import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chartBarWidths,
  mergeSessionStats,
  SessionStatsManager,
  sessionStatsFile,
  statsFromEntries,
} from "../src/session-stats";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assistant(id: string, model: string, usage: any, calls: any[] = []) {
  return {
    type: "message",
    message: {
      role: "assistant",
      provider: "mock",
      model,
      usage,
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
    },
  };
}

function result(id: string, toolName: string, isError = false, blocked = false) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName,
      isError,
      details: blocked ? { pumRejected: true } : {},
      content: [{ type: "text", text: "result" }],
    },
  };
}

function writeJsonl(path: string, entries: readonly unknown[]) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function fakeSession(path: string, entries: any[], model = "mock/alpha") {
  const listeners = new Set<(event: any) => void>();
  const [provider, id] = model.split("/");
  const session = {
    sessionFile: path,
    sessionId: path,
    sessionManager: { getEntries: () => entries, buildContextEntries: () => entries },
    agent: { state: { model: { provider, id, contextWindow: 100_000 } } },
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as any;
  return { session, emit: (event: any) => listeners.forEach((listener) => listener(event)) };
}

describe("session statistics aggregation", () => {
  test("maps usage, model changes, compression forms, and tool outcomes", () => {
    const stats = statsFromEntries([
      assistant("a", "alpha", { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, cost: { total: 0.1 } }, [
        { id: "ok", name: "read" },
        { id: "bad", name: "bash" },
        { id: "blocked", name: "edit" },
        { id: "open", name: "write" },
      ]),
      result("ok", "read"),
      result("bad", "bash", true),
      result("blocked", "edit", true, true),
      { type: "model_change", provider: "mock", modelId: "beta" },
      assistant("b", "beta", { input: 7, output: 5, cacheRead: 11, cacheWrite: 1, cost: { total: 0.2 } }),
      { type: "compaction", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 1, cost: { total: 0.03 } } },
      { type: "branch_summary", usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.04 } } },
      { type: "custom", customType: "pum.tool_event", data: { id: "direct", name: "worktree", state: "running" } },
      { type: "custom", customType: "pum.tool_event", data: { id: "direct", name: "worktree", state: "ok" } },
      { type: "custom", customType: "pum.web_search", data: { id: "search", state: "error" } },
    ], "mock/alpha");

    expect(stats.models).toEqual([
      expect.objectContaining({ model: "mock/alpha", role: "Agent", attempts: null, outgoing: 12, incoming: 4, cacheRead: 3, cost: 0.1, compressions: 0 }),
      expect.objectContaining({ model: "mock/beta", role: "Agent", attempts: null, outgoing: 14, incoming: 8, cacheRead: 12, cost: 0.27, compressions: 2 }),
    ]);
    expect(stats.tools).toEqual([
      { tool: "bash", successful: 0, failed: 1, blocked: 0, running: 0, interrupted: 0, total: 1 },
      { tool: "edit", successful: 0, failed: 0, blocked: 1, running: 0, interrupted: 0, total: 1 },
      { tool: "read", successful: 1, failed: 0, blocked: 0, running: 0, interrupted: 0, total: 1 },
      { tool: "web_search", successful: 0, failed: 1, blocked: 0, running: 0, interrupted: 0, total: 1 },
      { tool: "worktree", successful: 1, failed: 0, blocked: 0, running: 0, interrupted: 0, total: 1 },
      { tool: "write", successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 1, total: 1 },
    ]);
  });

  test("keeps Agent and Check rows separate for one model", () => {
    const merged = mergeSessionStats([
      statsFromEntries([assistant("a", "same", { input: 2, output: 1 })], "mock/same"),
      {
        models: [{ model: "mock/same", role: "Check", attempts: 2, outgoing: 4, incoming: 2, cacheRead: 1, cost: 0.01, compressions: 0 }],
        tools: [],
        outcomes: { successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 0 },
      },
    ]);
    expect(merged.models.map((row) => `${row.model}:${row.role}`)).toEqual([
      "mock/same:Agent",
      "mock/same:Check",
    ]);
  });

  test("scales five chart bars against all outcomes", () => {
    expect(chartBarWidths({ successful: 4, failed: 2, blocked: 1, running: 1, interrupted: 2 }, 20))
      .toEqual({ successful: 8, failed: 4, blocked: 2, running: 2, interrupted: 4 });
    expect(chartBarWidths({ successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 0 }, 20))
      .toEqual({ successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 0 });
  });

  test("coalesces stats writes off the per-event path", () => {
    const root = join(process.cwd(), `.stats-coalesce-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const path = join(root, "main.jsonl");
    writeJsonl(path, []);
    const main = fakeSession(path, [], "mock/alpha");
    const manager = new SessionStatsManager();
    const file = sessionStatsFile(path);

    manager.bindMainSession(main.session);
    rmSync(file, { force: true });

    for (let index = 0; index < 50; index++) {
      main.emit({ type: "turn_start" });
      main.emit({ type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "bash" });
      main.emit({ type: "tool_execution_end", toolCallId: `tool-${index}` });
    }
    // 150 events, no write on the hot path.
    expect(existsSync(file)).toBe(false);

    manager.flush();
    expect(existsSync(file)).toBe(true);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.agents).toHaveLength(1);
    expect(persisted.agents[0].observations[0].attempts).toBe(50);

    // A pure read writes nothing, and queues nothing to write later.
    rmSync(file);
    manager.snapshot();
    expect(existsSync(file)).toBe(false);
    manager.flush();
    expect(existsSync(file)).toBe(false);

    main.emit({ type: "turn_start" });
    manager.dispose();
    expect(JSON.parse(readFileSync(file, "utf8")).agents[0].observations[0].attempts).toBe(51);
  });

  test("reuses the snapshot of an agent whose session file has not moved", () => {
    const root = join(process.cwd(), `.stats-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const mainPath = join(root, "main.jsonl");
    const childPath = join(root, "child.jsonl");
    writeJsonl(mainPath, []);
    writeJsonl(childPath, [
      assistant("a1", "beta", { input: 10, output: 5 }, [{ id: "c1", name: "bash" }]),
      result("c1", "bash"),
    ]);
    const main = fakeSession(mainPath, [], "mock/alpha");
    const manager = new SessionStatsManager();
    manager.prepareMainSession(mainPath);
    manager.registerAgentFile("restored-child", childPath, "mock/beta");
    manager.bindMainSession(main.session);

    const stamp = new Date(1_700_000_000_000);
    utimesSync(childPath, stamp, stamp);
    const first = manager.snapshot();
    expect(first.outcomes.successful).toBe(1);

    // Same size and timestamp, different content. A cached agent never reads it
    // again, so the numbers must not move.
    const replacement = readFileSync(childPath, "utf8").replace("bash", "grep");
    expect(replacement).toHaveLength(readFileSync(childPath, "utf8").length);
    writeFileSync(childPath, replacement);
    utimesSync(childPath, stamp, stamp);
    expect(statSync(childPath).mtimeMs).toBe(stamp.getTime());

    expect(manager.snapshot().tools).toEqual(first.tools);

    // A real change to the file is picked up.
    writeJsonl(childPath, [
      assistant("a1", "beta", { input: 10, output: 5 }, [
        { id: "c1", name: "bash" },
        { id: "c2", name: "read" },
      ]),
      result("c1", "bash"),
      result("c2", "read"),
    ]);
    expect(manager.snapshot().outcomes.successful).toBe(2);
  });

  test("keeps live running tools separate from interrupted tools", () => {
    const root = join(process.cwd(), `.stats-running-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const path = join(root, "main.jsonl");
    writeJsonl(path, []);
    const main = fakeSession(path, [], "mock/alpha");
    const manager = new SessionStatsManager();

    manager.bindMainSession(main.session);
    main.emit({ type: "tool_execution_start", toolCallId: "live", toolName: "bash" });
    expect(manager.snapshot().tools).toContainEqual(expect.objectContaining({
      tool: "bash", running: 1, interrupted: 0,
    }));

    manager.bindMainSession(main.session);
    expect(manager.snapshot().tools).toContainEqual(expect.objectContaining({
      tool: "bash", running: 0, interrupted: 1,
    }));
  });

  test("migrates legacy combined fallback outcomes to interrupted", () => {
    const root = join(process.cwd(), `.stats-legacy-outcome-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const path = join(root, "main.jsonl");
    writeJsonl(path, []);
    writeFileSync(sessionStatsFile(path), JSON.stringify({
      version: 1,
      agents: [{
        id: "closed",
        initialModel: "mock/alpha",
        attemptsExact: true,
        observations: [],
        runningTools: [],
        countedBranchSummaryIds: [],
        fallback: {
          models: [],
          tools: [{ tool: "read", successful: 0, failed: 0, blocked: 0, runningInterrupted: 2, total: 2 }],
          outcomes: { successful: 0, failed: 0, blocked: 0, runningInterrupted: 2 },
        },
      }],
    }));
    const manager = new SessionStatsManager();

    manager.prepareMainSession(path);

    expect(manager.snapshot().tools).toEqual([
      { tool: "read", successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 2, total: 2 },
    ]);
  });

  test("tracks attempts, retries, Check requests, compression attribution, and closed children", () => {
    const root = join(process.cwd(), `.stats-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const mainPath = join(root, "main.jsonl");
    const childPath = join(root, "child.jsonl");
    const mainEntries: any[] = [];
    const childEntries: any[] = [];
    writeJsonl(mainPath, mainEntries);
    writeJsonl(childPath, childEntries);
    const main = fakeSession(mainPath, mainEntries, "mock/alpha");
    const child = fakeSession(childPath, childEntries, "mock/beta");
    const manager = new SessionStatsManager();

    manager.bindMainSession(main.session);
    main.emit({ type: "turn_start" });
    main.emit({ type: "auto_retry_start" });
    main.emit({ type: "compaction_start" });
    main.emit({ type: "summarization_retry_attempt_start", source: "compaction" });
    main.emit({ type: "compaction_end", result: {}, aborted: false });
    manager.observeCheck({
      agentId: null,
      model: "mock/alpha",
      usage: { input: 4, output: 1, cacheRead: 2, cacheWrite: 1, cost: { total: 0.02 } },
    });
    manager.observeCheck({ agentId: null, model: "mock/alpha" });
    manager.attach("child", child.session, "mock/beta");
    child.emit({ type: "turn_start" });
    mainEntries.push(
      assistant("m", "alpha", { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
      { type: "compaction", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    );
    childEntries.push(
      assistant("c", "beta", { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, [{ id: "child-read", name: "read" }]),
      result("child-read", "read"),
    );
    writeJsonl(mainPath, mainEntries);
    writeJsonl(childPath, childEntries);
    manager.closeAgent("child");
    rmSync(childPath);

    const stats = manager.snapshot();
    expect(stats.models).toContainEqual(expect.objectContaining({
      model: "mock/alpha", role: "Agent", attempts: 4, compressions: 1,
    }));
    expect(stats.models).toContainEqual(expect.objectContaining({
      model: "mock/alpha", role: "Check", attempts: 2, outgoing: 5, incoming: 1, cacheRead: 2, cost: 0.02,
    }));
    expect(stats.models).toContainEqual(expect.objectContaining({
      model: "mock/beta", role: "Agent", attempts: 1, outgoing: 7, incoming: 3,
    }));
    expect(stats.tools).toContainEqual(expect.objectContaining({ tool: "read", successful: 1, total: 1 }));
  });

  test("preserves restored child registration when main binds without an existing companion", () => {
    const root = join(process.cwd(), `.stats-resume-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const mainPath = join(root, "main.jsonl");
    const childPath = join(root, "child.jsonl");
    const mainEntries = [assistant("main", "alpha", { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } })];
    const childEntries = [assistant("child", "beta", { input: 7, output: 3, cacheRead: 1, cacheWrite: 2, cost: { total: 0.1 } })];
    writeJsonl(mainPath, mainEntries);
    writeJsonl(childPath, childEntries);
    const main = fakeSession(mainPath, mainEntries, "mock/alpha");
    const manager = new SessionStatsManager();

    manager.prepareMainSession(mainPath);
    manager.registerAgentFile("restored-child", childPath, "mock/beta");
    manager.bindMainSession(main.session);

    expect(manager.snapshot().models).toContainEqual(expect.objectContaining({
      model: "mock/beta",
      role: "Agent",
      outgoing: 9,
      incoming: 3,
      cacheRead: 1,
      cost: 0.1,
    }));
  });

  test("same-path preparation preserves live main observation and restored children", () => {
    const root = join(process.cwd(), `.stats-rebind-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const mainPath = join(root, "main.jsonl");
    const childPath = join(root, "child.jsonl");
    const mainEntries: any[] = [];
    const childEntries = [assistant("child", "beta", { input: 5, output: 2, cacheRead: 0, cacheWrite: 1, cost: { total: 0 } })];
    writeJsonl(mainPath, mainEntries);
    writeJsonl(childPath, childEntries);
    const main = fakeSession(mainPath, mainEntries, "mock/alpha");
    const manager = new SessionStatsManager();

    manager.prepareMainSession(mainPath);
    manager.registerAgentFile("restored-child", childPath, "mock/beta");
    manager.bindMainSession(main.session);
    manager.prepareMainSession(mainPath);

    main.emit({ type: "turn_start" });
    mainEntries.push(assistant("main", "alpha", { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }));
    const stats = manager.snapshot();
    expect(stats.models).toContainEqual(expect.objectContaining({
      model: "mock/alpha",
      role: "Agent",
      attempts: 1,
      outgoing: 3,
    }));
    expect(stats.models).toContainEqual(expect.objectContaining({
      model: "mock/beta",
      role: "Agent",
      outgoing: 6,
      incoming: 2,
    }));
  });

  test("counts a persisted branch-summary initial request once on the active model", () => {
    const root = join(process.cwd(), `.stats-branch-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    mkdirSync(root);
    const path = join(root, "main.jsonl");
    const entries: any[] = [];
    writeJsonl(path, entries);
    const main = fakeSession(path, entries, "mock/alpha");
    const manager = new SessionStatsManager();

    manager.bindMainSession(main.session);
    main.emit({ type: "turn_start" });
    entries.push(
      assistant("a", "alpha", { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
      { type: "model_change", provider: "mock", modelId: "beta" },
      {
        type: "branch_summary",
        id: "summary-1",
        fromHook: false,
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
    );
    main.session.agent.state.model = { provider: "mock", id: "beta", contextWindow: 100_000 };
    main.emit({ type: "entry_appended", entry: entries.at(-1) });
    main.emit({ type: "summarization_retry_attempt_start", source: "branchSummary" });

    const snapshot = manager.snapshot();
    expect(snapshot.models).toContainEqual(expect.objectContaining({
      model: "mock/beta",
      role: "Agent",
      attempts: 2,
      compressions: 1,
    }));
    expect(snapshot.models.find((row) => row.model === "mock/beta")?.attempts).toBe(2);
  });

  test("keeps legacy attempts and incomplete usage unavailable", () => {
    const stats = statsFromEntries([
      assistant("legacy", "old", { tokens: 700, cost: { total: 0.2 } }),
    ], "mock/old");
    expect(stats.models[0]).toMatchObject({
      attempts: null,
      outgoing: null,
      incoming: null,
      cacheRead: null,
      cost: 0.2,
    });
  });
});

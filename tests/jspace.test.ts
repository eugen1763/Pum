import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyJspaceMode,
  createJspaceState,
  formatJspaceState,
  jspaceExtension,
  loadJspace,
  noteJspaceSettled,
  noteJspaceToolEnd,
  noteJspaceToolStart,
  saveJspace,
  setJspaceEnabled,
  startJspaceTurn,
} from "../src/jspace";

const directories: string[] = [];

afterEach(() => {
  setJspaceEnabled(false);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("J-Space state", () => {
  test("routes small, explanatory, and repository tasks", () => {
    expect(classifyJspaceMode("What is this file?")).toBe("fast");
    expect(classifyJspaceMode("Explain how this setting works.")).toBe("full");
    expect(classifyJspaceMode("Implement the feature, update the tests, and run the repository test suite."))
      .toBe("loop");
  });

  test("tracks tool evidence, failures, checkpoints, and coverage", () => {
    let state = startJspaceTurn(createJspaceState(1), "Fix the failing tests in src/app.tsx", 2);
    state = noteJspaceToolStart(state, "read", 3);
    state = noteJspaceToolEnd(state, "read", false, 4);
    state = noteJspaceToolStart(state, "bash", 5);
    state = noteJspaceToolEnd(state, "bash", true, 6);
    state = noteJspaceSettled(state, 7);

    expect(state.mode).toBe("loop");
    expect(state.phase).toBe("recover");
    expect(state.verified).toEqual(["read succeeded"]);
    expect(state.open).toEqual(["bash failed"]);
    expect(state.coverage).toMatchObject({ attempted: 2, successful: 1, failed: 1 });
    expect(state.checkpoint?.label).toBe("turn 1 settled");
    expect(formatJspaceState(state)).toContain("Next:");
  });

  test("persists state beside the session and rejects corrupt state", () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-jspace-"));
    directories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const state = startJspaceTurn(createJspaceState(1), "Build the feature", 2);
    saveJspace(sessionFile, state);

    expect(loadJspace(sessionFile)).toEqual(state);
    expect(readFileSync(join(directory, "session.jspace.json"), "utf8")).toContain('"version": 1');
    expect(loadJspace(join(directory, "missing.jsonl"))).toBeNull();
  });

  test("normalizes a stored ledger instead of trusting the file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-jspace-"));
    directories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    // Every optional field is absent, and the one list present is over the bound.
    writeFileSync(join(directory, "session.jspace.json"), JSON.stringify({
      version: 1,
      mode: "full",
      phase: "orient",
      goal: "Ship the change",
      next: "Read the diff",
      core: Array.from({ length: 40 }, (_, index) => `constraint ${index}`),
    }));

    const loaded = loadJspace(sessionFile);
    expect(loaded?.core).toHaveLength(6);
    expect(loaded?.verified).toEqual([]);
    expect(loaded?.coverage).toEqual({ attempted: 0, successful: 0, failed: 0 });
    expect(loaded?.checkpoint).toBeNull();
    // The formatter reads every field, so a partial file must not throw here.
    expect(formatJspaceState(loaded!)).toContain("Coverage: 0 attempted");
  });
});

describe("J-Space extension", () => {
  function handlers() {
    const registered = new Map<string, (event: any, ctx: any) => any>();
    (jspaceExtension as any).factory({
      on(event: string, handler: (event: any, ctx: any) => any) {
        registered.set(event, handler);
      },
    });
    const sessionManager = {
      getSessionFile: () => undefined,
    };
    const ctx = { sessionManager, cwd: "/repo" };
    return { registered, ctx };
  }

  test("does nothing while disabled", () => {
    const { registered, ctx } = handlers();
    const result = registered.get("before_agent_start")?.({ prompt: "build this", systemPrompt: "base" }, ctx);
    expect(result).toBeUndefined();
  });

  test("adds the control prompt after opt-in", () => {
    setJspaceEnabled(true);
    const { registered, ctx } = handlers();
    const result = registered.get("before_agent_start")?.({
      prompt: "Implement the change and run tests",
      systemPrompt: "base",
    }, ctx);
    expect(result.systemPrompt).toContain("J-Space task control");
    expect(result.systemPrompt).toContain("Current control mode: loop");
  });

  test("refreshes the ledger before each provider call", () => {
    setJspaceEnabled(true);
    const { registered, ctx } = handlers();
    registered.get("before_agent_start")?.({
      prompt: "Implement the change and run tests",
      systemPrompt: "base",
    }, ctx);
    const result = registered.get("context")?.({
      messages: [
        { role: "custom", customType: "pum.jspace.context", content: "stale", display: false },
        { role: "user", content: "continue", timestamp: Date.now() },
      ],
    }, ctx);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect((result.messages[1] as any).customType).toBe("pum.jspace.context");
    expect((result.messages[1] as any).content).toContain("Goal: Implement the change and run tests");
  });
});

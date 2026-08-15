import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { canonicalRealpathSync } from "./platform";
import { loadRelocation, relocationFileFor, saveRelocation } from "./relocation";

let destroy: (() => void) | undefined;
const directories: string[] = [];
afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 10 : 0 });
  }
});

const settings = {
  showThinking: false,
  theme: "tokyonight" as const,
  animations: false,
  workingRuleAnimation: "off" as const,
  webSearch: false,
  writingStyle: "none" as const,
  explanationStrength: "simple" as const,
  checkMode: "off" as const,
  checkModel: "mock/check",
  maxActiveSubagents: 10,
};

function repository(): string {
  const path = canonicalRealpathSync(mkdtempSync(join(tmpdir(), "pum-reloc-repo-")));
  directories.push(path);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(path, "a.txt"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return path;
}

function fakeSession() {
  const directory = canonicalRealpathSync(mkdtempSync(join(tmpdir(), "pum-reloc-session-")));
  directories.push(directory);
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionFile: join(directory, "session.jsonl"),
    sessionId: "current-session",
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async () => {},
    steer: async () => {},
  } as any;
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(options: {
  cwd: string;
  agents?: unknown[];
  onRelocate?: (target: string) => Promise<unknown>;
  session?: ReturnType<typeof fakeSession>;
} ) {
  const session = options.session ?? fakeSession();
  const relocated: string[] = [];
  const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const manager = {
    getAgents: () => options.agents ?? [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: async () => {},
    persistToolEvent() {},
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      initialCwd={options.cwd}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      onRelocate={async (target: string) => {
        relocated.push(target);
        return (await options.onRelocate?.(target)) === null ? null : session;
      }}
      settings={settings}
      searchProviders={[]}
      subagentManager={manager}
      promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
      promptStashStore={{
        load: () => [],
        append: () => [],
        markExecuted: () => [],
        markExecutedMany: () => [],
        replace: () => [],
        remove: () => [],
      }}
    />,
  );
  await settle(setup);
  return { setup, session, relocated };
}

async function type(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await settle(setup);
  await settle(setup);
}

describe("/worktree start and return", () => {
  test("moves the session into a generated worktree and back", async () => {
    const repo = repository();
    const { setup, session, relocated } = await renderApp({ cwd: repo });

    await type(setup, "/worktree start");
    const record = loadRelocation(session.sessionFile);
    expect(record?.location).toBe("worktree");
    expect(record?.branch).toMatch(/^pum\//);
    expect(existsSync(record!.worktreePath)).toBe(true);
    expect(relocated).toEqual([record!.worktreePath]);
    expect(setup.captureCharFrame()).toContain("now in worktree");
    // The status bar is the visible proof that the directory rebound, not just
    // that a worktree was created somewhere.
    expect(setup.captureCharFrame()).toContain(`${record!.name} · ${record!.branch}`);

    await type(setup, "/worktree return");
    expect(relocated[1]).toBe(repo);
    // Returning preserves the worktree; only the session moved.
    expect(existsSync(record!.worktreePath)).toBe(true);
    expect(setup.captureCharFrame()).toContain("back in");
    expect(setup.captureCharFrame()).not.toContain(`${record!.name} · ${record!.branch}`);
  }, 30_000);

  test("refuses a second layer", async () => {
    const repo = repository();
    const { setup } = await renderApp({ cwd: repo });
    await type(setup, "/worktree start");
    await type(setup, "/worktree start");
    expect(setup.captureCharFrame()).toContain("return first");
  }, 30_000);

  test("refuses while a managed agent is retained", async () => {
    const repo = repository();
    const { setup, session } = await renderApp({
      cwd: repo,
      agents: [{
        id: "a",
        name: "worker",
        status: "idle",
        parentAgentId: null,
        readonly: false,
        modelId: "mock/mock-model",
        thinkingLevel: "off",
        worktree: { name: "worker", path: "/tmp/w", branch: "pum/worker", baseBranch: "main", baseCommit: "abc" },
        transcript: { lines: [], pending: [], stream: undefined },
      }],
    });
    await type(setup, "/worktree start");
    expect(setup.captureCharFrame()).toContain("before moving the session");
    expect(loadRelocation(session.sessionFile)).toBeNull();
  }, 30_000);

  test("refuses to return when the session never moved", async () => {
    const repo = repository();
    const { setup } = await renderApp({ cwd: repo });
    await type(setup, "/worktree return");
    expect(setup.captureCharFrame()).toContain("not running in a generated worktree");
  }, 30_000);

  test("keeps the worktree when the move itself fails", async () => {
    const repo = repository();
    const { setup, session } = await renderApp({ cwd: repo, onRelocate: async () => null });
    await type(setup, "/worktree start");

    const frame = setup.captureCharFrame();
    expect(frame).toContain("did not move");
    // The worktree exists and is named, rather than deleted with the user's work.
    expect(loadRelocation(session.sessionFile)).toBeNull();
    expect(frame).toMatch(/worktree [a-z]+-[a-z]+-[0-9a-f]{4}/);
  }, 30_000);

  test("an unknown form is an error and keeps the draft", async () => {
    const repo = repository();
    const { setup } = await renderApp({ cwd: repo });
    await type(setup, "/worktree feature one");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Unknown worktree command");
    expect(frame).toContain("/worktree feature one");
  }, 30_000);

  test("a worktree that no longer matches its branch is not restored", async () => {
    const repo = repository();
    const session = fakeSession();
    // The record survives, but the worktree it names is gone.
    saveRelocation(session.sessionFile, {
      id: "reloc-1",
      generation: 1,
      sourceRoot: repo,
      worktreePath: join(repo, ".pum", "worktrees", "never-made"),
      name: "never-made",
      branch: "pum/never-made",
      baseBranch: "main",
      baseCommit: "abc1234",
      location: "worktree",
      createdAt: 1,
      updatedAt: 1,
    });

    const { setup } = await renderApp({ cwd: repo, session });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("no longer matches");
    // Failing closed means dropping the record, not authorizing a stale path.
    expect(existsSync(relocationFileFor(session.sessionFile))).toBe(false);
  }, 30_000);
});

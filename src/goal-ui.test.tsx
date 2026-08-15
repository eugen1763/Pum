import { afterEach, describe, expect, test } from "bun:test";
import { TextareaRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { QuestionnaireManager } from "./questionnaire";
import { loadGoal, saveGoal, type GoalRecord } from "./goal";

let destroy: (() => void) | undefined;
const temporaryDirectories: string[] = [];

afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempSessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-goal-ui-"));
  temporaryDirectories.push(directory);
  return join(directory, "main-session.jsonl");
}

function focusedTextarea(root: BaseRenderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable && root.focused) return root;
  for (const child of root.getChildren()) {
    const found = focusedTextarea(child);
    if (found) return found;
  }
  return undefined;
}

function fakeSession(sessionFile: string, prompts: string[]) {
  const listeners = new Set<(event: any) => void>();
  const session = {
    sessionId: "main-session",
    sessionFile,
    agent: {
      state: {
        model: { id: "model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: (listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setThinkingLevel() {}, setModel: async () => {},
    abort: async () => {}, compact: async () => ({ tokensBefore: 0 }),
    prompt: async (text: string) => { prompts.push(text); },
    steer: async (text: string) => { prompts.push(text); },
    followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
  } as any;
  session.emit = (event: any) => {
    for (const listener of listeners) listener(event);
  };
  return session;
}

const settings = {
  showThinking: false, theme: "tokyonight", animations: false,
  workingRuleAnimation: "off" as const, webSearch: false, writingStyle: "none" as const,
  explanationStrength: "simple" as const, checkMode: "off" as const,
  checkModel: "mock/check", maxActiveSubagents: 10, goalRetryLimit: 10,
};

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce(); await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce(); await setup.flush();
}

async function render(options: {
  sessionFile: string;
  prompts: string[];
  questionnaireManager?: QuestionnaireManager;
  nextSessionFile?: string;
  width?: number;
}) {
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {}, abortAgent: async () => {}, persistToolEvent() {},
    removeGoalJudge: async () => {}, spawnGoalJudge: async () => ({ id: "judge" }),
  } as any;
  const session = fakeSession(options.sessionFile, options.prompts);
  const setup = await createTestRenderer({
    width: options.width ?? 80,
    height: 20,
    kittyKeyboard: true,
  });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <App session={session} modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => (options.nextSessionFile
        ? fakeSession(options.nextSessionFile, options.prompts)
        : session)}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings} searchProviders={[]} subagentManager={manager}
      {...(options.questionnaireManager ? { questionnaireManager: options.questionnaireManager } : {})} />,
  );
  await settle(setup);
  return Object.assign(setup, { session });
}

/** Finish the turn the way pi does: settle, never agent_end. */
async function settleTurn(setup: Awaited<ReturnType<typeof render>>, answer?: string) {
  if (answer) {
    setup.session.emit({ type: "message_start", message: { role: "assistant" } });
    setup.session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: answer },
    });
    setup.session.emit({ type: "message_end", message: { role: "assistant" } });
  }
  setup.session.emit({ type: "agent_settled" });
  await settle(setup);
}

async function type(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await settle(setup);
}

/** Answer the second option of a one-question confirmation, or cancel it. */
async function answer(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  manager: QuestionnaireManager,
  confirm: boolean,
) {
  if (!confirm) {
    manager.cancel();
    await settle(setup);
    return;
  }
  manager.moveOption(1);
  manager.select();
  manager.select();
  await settle(setup);
}

describe("goal commands", () => {
  test("/goal <text> persists the goal and immediately starts work", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const setup = await render({ sessionFile, prompts });

    await type(setup, "/goal fix the flaky tests");

    const stored = loadGoal(sessionFile);
    expect(stored?.text).toBe("fix the flaky tests");
    expect(stored?.state).toBe("active");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("fix the flaky tests");
    expect(setup.captureCharFrame()).toContain("GOAL");
  });

  test("the goal rides the rule above the input, not the status bar", async () => {
    const sessionFile = tempSessionFile();
    const setup = await render({ sessionFile, prompts: [] });
    await type(setup, "/goal fix the flaky tests");

    const rows = setup.captureCharFrame().split("\n");
    const goalRows = rows.filter((row) => row.includes("GOAL · active"));
    expect(goalRows).toHaveLength(1);
    const goalRow = rows.findIndex((row) => row.includes("GOAL · active"));
    const promptRow = rows.findLastIndex((row) => row.includes("❯"));
    expect(goalRow).toBeGreaterThan(0);
    expect(promptRow).toBeGreaterThan(goalRow);
    // The rule is one row: rule glyphs and label share it, and nothing wraps.
    expect(rows[goalRow]).toContain("─");
    expect(rows[goalRow]!.trimEnd().endsWith("tests")).toBe(true);
  });

  test("/goal status reports the complete state, and errors keep the draft", async () => {
    const sessionFile = tempSessionFile();
    const setup = await render({ sessionFile, prompts: [] });

    await type(setup, "/goal status");
    expect(setup.captureCharFrame()).toContain("no goal is set");

    await type(setup, "/goal resume");
    expect(setup.captureCharFrame()).toContain("unknown /goal action");
    expect(focusedTextarea(setup.renderer.root)!.plainText).toBe("/goal resume");
  });

  test("/goal stop then /goal continue moves the lifecycle both ways", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const setup = await render({ sessionFile, prompts });

    await type(setup, "/goal fix the flaky tests");
    await settleTurn(setup);
    await type(setup, "/goal stop");
    expect(loadGoal(sessionFile)?.state).toBe("stopped");
    expect(setup.captureCharFrame()).toContain("goal stopped");

    await type(setup, "/goal continue");
    expect(loadGoal(sessionFile)?.state).toBe("active");
    expect(prompts).toHaveLength(2);
  });

  test("/goal continue refuses a goal that is not stopped", async () => {
    const sessionFile = tempSessionFile();
    const setup = await render({ sessionFile, prompts: [] });
    await type(setup, "/goal fix the flaky tests");
    await type(setup, "/goal continue");
    expect(setup.captureCharFrame()).toContain("only a stopped goal");
    expect(loadGoal(sessionFile)?.state).toBe("active");
  });
});

describe("goal replacement", () => {
  test("a second goal needs confirmation and cancelling preserves the first", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const questionnaireManager = new QuestionnaireManager();
    const setup = await render({ sessionFile, prompts, questionnaireManager });

    await type(setup, "/goal fix the flaky tests");
    await settleTurn(setup);
    await type(setup, "/goal rewrite the parser");
    expect(questionnaireManager.current()?.questions[0]?.id).toBe("goal-replace");

    await answer(setup, questionnaireManager, false);
    expect(loadGoal(sessionFile)?.text).toBe("fix the flaky tests");
    expect(prompts).toHaveLength(1);
    expect(setup.captureCharFrame()).toContain("goal unchanged");
  });

  test("confirming the replacement starts the new goal", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const questionnaireManager = new QuestionnaireManager();
    const setup = await render({ sessionFile, prompts, questionnaireManager });

    await type(setup, "/goal fix the flaky tests");
    await settleTurn(setup);
    await type(setup, "/goal rewrite the parser");
    await answer(setup, questionnaireManager, true);

    const stored = loadGoal(sessionFile)!;
    expect(stored.text).toBe("rewrite the parser");
    expect(stored.state).toBe("active");
    expect(prompts).toHaveLength(2);
  });

  test("a completed goal is terminal: it cannot continue, only be replaced", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const questionnaireManager = new QuestionnaireManager();
    saveGoal(sessionFile, {
      id: "goal-1", generation: 4, text: "fix the flaky tests", state: "completed",
      createdAt: 1, updatedAt: 1, workGeneration: 2, lastJudgedWorkGeneration: 2,
      judgeCount: 2, incompleteCount: 0, retryLimit: 10,
    } satisfies GoalRecord);
    const setup = await render({ sessionFile, prompts, questionnaireManager });

    await type(setup, "/goal continue");
    expect(setup.captureCharFrame()).toContain("replace or clear");
    expect(prompts).toEqual([]);

    await type(setup, "/goal rewrite the parser");
    expect(questionnaireManager.current()?.questions[0]?.id).toBe("goal-replace");
    await answer(setup, questionnaireManager, true);
    expect(loadGoal(sessionFile)?.text).toBe("rewrite the parser");
  });
});

describe("goal clearing", () => {
  test("/goal clear removes the stored state after confirmation", async () => {
    const sessionFile = tempSessionFile();
    const questionnaireManager = new QuestionnaireManager();
    const setup = await render({ sessionFile, prompts: [], questionnaireManager });

    await type(setup, "/goal fix the flaky tests");
    await settleTurn(setup);
    await type(setup, "/goal clear");
    await answer(setup, questionnaireManager, false);
    expect(loadGoal(sessionFile)).not.toBeNull();

    await type(setup, "/goal clear");
    await answer(setup, questionnaireManager, true);
    expect(loadGoal(sessionFile)).toBeNull();
    expect(setup.captureCharFrame()).not.toContain("GOAL ·");
  });
});

describe("goal resume", () => {
  test("an owed continuation is delivered once when the session opens", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    saveGoal(sessionFile, {
      id: "goal-1", generation: 3, text: "fix the flaky tests", state: "active",
      createdAt: 1, updatedAt: 1, workGeneration: 2, lastJudgedWorkGeneration: 2,
      judgeCount: 1, incompleteCount: 1, retryLimit: 10,
      pendingContinuation: { id: "cont-1", text: "add the missing regression test" },
    });

    const setup = await render({ sessionFile, prompts });

    expect(prompts).toEqual(["add the missing regression test"]);
    expect(loadGoal(sessionFile)?.pendingContinuation).toBeUndefined();
  });

  test("a stopped goal delivers nothing on resume", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    saveGoal(sessionFile, {
      id: "goal-1", generation: 3, text: "fix the flaky tests", state: "stopped",
      createdAt: 1, updatedAt: 1, workGeneration: 2, lastJudgedWorkGeneration: 2,
      judgeCount: 1, incompleteCount: 1, retryLimit: 10,
      pendingContinuation: { id: "cont-1", text: "add the missing regression test" },
    });

    const setup = await render({ sessionFile, prompts });

    expect(prompts).toEqual([]);
    expect(setup.captureCharFrame()).toContain("stopped");
  });
});

describe("/goalf", () => {
  test("interviews, proposes one goal, and waits for confirmation", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const questionnaireManager = new QuestionnaireManager();
    const setup = await render({ sessionFile, prompts, questionnaireManager });

    await type(setup, "/goalf improve startup");
    // The interview turn runs first, and stores nothing yet.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("improve startup");
    expect(prompts[0]).toContain("questionnaire");
    expect(loadGoal(sessionFile)).toBeNull();

    await settleTurn(setup, "Some reasoning.\nGOAL: cut cold start below 200ms, measured by bun run bench");
    expect(questionnaireManager.current()?.questions[0]?.id).toBe("goal-confirm");
    expect(loadGoal(sessionFile)).toBeNull();

    await answer(setup, questionnaireManager, true);
    expect(loadGoal(sessionFile)?.text)
      .toBe("cut cold start below 200ms, measured by bun run bench");
    expect(prompts).toHaveLength(2);
  });

  test("cancelling the proposal stores nothing and preserves the current goal", async () => {
    const sessionFile = tempSessionFile();
    const prompts: string[] = [];
    const questionnaireManager = new QuestionnaireManager();
    const setup = await render({ sessionFile, prompts, questionnaireManager });

    await type(setup, "/goal fix the flaky tests");
    await settleTurn(setup);
    await type(setup, "/goalf improve startup");
    await answer(setup, questionnaireManager, true); // confirm the replacement
    await settleTurn(setup, "GOAL: cut cold start below 200ms");
    await answer(setup, questionnaireManager, false); // cancel the proposal

    expect(loadGoal(sessionFile)?.text).toBe("fix the flaky tests");
    expect(setup.captureCharFrame()).toContain("goal unchanged");
  });

  test("an answer with no proposal stores nothing", async () => {
    const sessionFile = tempSessionFile();
    const questionnaireManager = new QuestionnaireManager();
    const setup = await render({ sessionFile, prompts: [], questionnaireManager });

    await type(setup, "/goalf improve startup");
    await settleTurn(setup, "I could not work out a goal.");

    expect(loadGoal(sessionFile)).toBeNull();
    expect(setup.captureCharFrame()).toContain("no goal was proposed");
  });
});

describe("new sessions", () => {
  test("/clear does not carry the goal into the fresh session", async () => {
    const sessionFile = tempSessionFile();
    const nextFile = tempSessionFile();
    const prompts: string[] = [];
    const setup = await render({ sessionFile, prompts, nextSessionFile: nextFile });

    await type(setup, "/goal fix the flaky tests");
    await settleTurn(setup);
    expect(setup.captureCharFrame()).toContain("GOAL · active");

    await type(setup, "/clear");
    expect(setup.captureCharFrame()).not.toContain("GOAL · active");
    // The old session keeps its own goal; the new one simply has none.
    expect(loadGoal(sessionFile)?.text).toBe("fix the flaky tests");
    expect(loadGoal(nextFile)).toBeNull();
  });
});

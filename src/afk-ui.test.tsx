import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { QuestionnaireManager } from "./questionnaire";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
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

const customEntries: { type: string; data: any }[] = [];

function fakeSession() {
  const path = join(mkdtempSync(join(tmpdir(), "pum-afk-ui-")), "current-session.jsonl");
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: {
      buildContextEntries: () => [],
      getEntries: () => [],
      appendCustomEntry: (type: string, data: any) => { customEntries.push({ type, data }); },
    },
    sessionFile: path,
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
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(questionnaireManager?: QuestionnaireManager, width = 100) {
  const session = fakeSession();
  const setup = await createTestRenderer({ width, height: 28, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const spawned: { task: string; onAnswer: (raw: unknown) => void }[] = [];
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: async () => {},
    persistToolEvent() {},
    appendAgentLine() {},
    removeAfkDelegate: async () => {},
    spawnAfkDelegate: async (options: any) => {
      spawned.push(options);
      return { id: `afk-${spawned.length}` };
    },
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={manager}
      questionnaireManager={questionnaireManager}
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
  return { setup, spawned };
}

const QUESTIONS = [{
  id: "q1",
  prompt: "Which database should the cache use?",
  options: [
    { value: "redis", label: "Redis" },
    { value: "memory", label: "In-memory" },
  ],
}];

async function type(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await settle(setup);
}

describe("/afk in the app", () => {
  test("toggles on, re-steers, and toggles off", async () => {
    const { setup } = await renderApp();

    await type(setup, "/afk");
    expect(setup.captureCharFrame()).toContain("AFK on");

    await type(setup, "/afk prefer the cheaper option");
    let frame = setup.captureCharFrame();
    expect(frame).toContain("AFK steered");
    expect(frame).toContain("prefer the cheaper option");

    await type(setup, "/afk");
    expect(setup.captureCharFrame()).toContain("AFK off");
  });

  test("the rule carries AFK, and shares the row with a goal", async () => {
    const { setup } = await renderApp();
    await type(setup, "/afk");

    const rows = setup.captureCharFrame().split("\n");
    // The transcript also says "AFK on", so pick the rule out by its glyphs:
    // exactly one row carries both, and it is the rule.
    const ruleRows = rows.filter((row) => row.includes("AFK") && row.includes("─"));
    expect(ruleRows).toHaveLength(1);
    const ruleIndex = rows.indexOf(ruleRows[0]!);
    expect(rows[ruleIndex - 1]?.trim()).toBe("");
    expect(ruleRows[0]!.endsWith("──")).toBe(true);
    // Painted onto the rule, not stacked above it.
    expect(rows[ruleIndex + 1]).toContain("❯");
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(100);
  });

  test("a questionnaire goes to a delegate instead of the popup", async () => {
    const questionnaireManager = new QuestionnaireManager();
    const { setup, spawned } = await renderApp(questionnaireManager);
    await type(setup, "/afk");

    const pending = questionnaireManager.request({ id: "main", name: "main" }, QUESTIONS);
    await settle(setup);

    // The popup must stay down and the delegate must get the exact question.
    expect(setup.captureCharFrame()).not.toContain("Which database should the cache use?");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.task).toContain("Which database should the cache use?");
    expect((spawned[0] as any).modelId).toBe("mock/mock-model");

    spawned[0]!.onAnswer({
      requestId: questionnaireManager.current()!.id,
      generation: "1",
      answers: [{ questionId: "q1", value: "redis", label: "Redis", custom: false }],
    });
    await settle(setup);

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [{ questionId: "q1", value: "redis", label: "Redis", custom: false }],
    });
    expect(setup.captureCharFrame()).toContain("AFK answered for main");
  });

  test("the audit row is persisted, so resume can replay it", async () => {
    customEntries.length = 0;
    const questionnaireManager = new QuestionnaireManager();
    const { setup, spawned } = await renderApp(questionnaireManager);
    await type(setup, "/afk");
    void questionnaireManager.request({ id: "main", name: "main" }, QUESTIONS);
    await settle(setup);

    spawned[0]!.onAnswer({
      requestId: questionnaireManager.current()!.id,
      generation: "1",
      answers: [{ questionId: "q1", value: "redis", label: "Redis", custom: false }],
    });
    await settle(setup);

    // Drawing the row is not enough: appendMainLine is UI-only, so without a
    // custom entry the row is gone the moment the session is resumed.
    const notices = customEntries.filter((entry) => entry.type === "pum.agent_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.data.line.text).toContain("AFK answered for main");
    expect(notices[0]!.data.line.text).toContain("Redis");
  });

  test("the prompt stays usable while a delegate answers", async () => {
    const questionnaireManager = new QuestionnaireManager();
    const { setup } = await renderApp(questionnaireManager);
    await type(setup, "/afk");
    void questionnaireManager.request({ id: "main", name: "main" }, QUESTIONS);
    await settle(setup);

    // Typing /afk must reach the prompt, or there is no way back from AFK.
    await setup.mockInput.typeText("/afk");
    await settle(setup);
    const promptRow = setup.captureCharFrame().split("\n").findLast((row) => row.includes("❯"));
    expect(promptRow).toContain("/afk");
  });

  test("stopping AFK hands the unanswered questionnaire back", async () => {
    const questionnaireManager = new QuestionnaireManager();
    const { setup } = await renderApp(questionnaireManager);
    await type(setup, "/afk");
    void questionnaireManager.request({ id: "main", name: "main" }, QUESTIONS);
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Which database should the cache use?");

    await type(setup, "/afk");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Which database should the cache use?");
    // The request survived: it was never answered or cancelled.
    expect(questionnaireManager.current()?.questions).toHaveLength(1);
  });

  test("a stale answer from an older AFK run is ignored", async () => {
    const questionnaireManager = new QuestionnaireManager();
    const { setup, spawned } = await renderApp(questionnaireManager);
    await type(setup, "/afk");
    void questionnaireManager.request({ id: "main", name: "main" }, QUESTIONS);
    await settle(setup);
    const requestId = questionnaireManager.current()!.id;

    await type(setup, "/afk");
    await type(setup, "/afk");
    await settle(setup);

    // Generation 1 belongs to the AFK run the user already stopped.
    spawned[0]!.onAnswer({
      requestId,
      generation: "1",
      answers: [{ questionId: "q1", value: "redis", label: "Redis", custom: false }],
    });
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("AFK answered");
  });
});

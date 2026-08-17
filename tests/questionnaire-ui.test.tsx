import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { QuestionnairePopup, questionnairePopupGeometry } from "../src/questionnaire-popup";
import { QuestionnaireManager, type QuestionnaireRequest } from "../src/questionnaire";
import { loadTheme } from "../src/theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function fakeSession() {
  return {
    sessionId: "main-session",
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
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

const settings = {
  showThinking: false,
  theme: "tokyonight",
  animations: false,
  workingRuleAnimation: "input-only" as const,
  webSearch: false,
  writingStyle: "none" as const,
  explanationStrength: "simple" as const,
  checkMode: "off" as const,
  checkModel: "mock/check",
  maxActiveSubagents: 10,
};

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(width = 64, height = 20, agents: any[] = []) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const questionnaireManager = new QuestionnaireManager();
  const subagentManager = {
    getAgents: () => agents,
    subscribe: () => () => {},
    bindMainSession: async () => {},
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={subagentManager}
      questionnaireManager={questionnaireManager}
    />,
  );
  await settle(setup);
  return { setup, questionnaireManager };
}

describe("questionnaire OpenTUI flow", () => {
  test("navigates multiple questions, accepts a custom answer, and restores prompt input", async () => {
    const { setup, questionnaireManager } = await renderApp();
    await setup.mockInput.typeText("draft");
    await settle(setup);
    const result = questionnaireManager.request({ id: "child-1", name: "worker-one" }, [
      {
        id: "scope",
        label: "Scope",
        prompt: "Choose the implementation scope",
        options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }],
      },
      {
        id: "notes",
        label: "Notes",
        prompt: "Choose notes",
        options: [{ value: "none", label: "No notes" }],
      },
    ]);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Questionnaire · worker-one");

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Choose notes");

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
    await setup.mockInput.typeText("Keep this explicit");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("custom answer entered");
    expect(setup.captureCharFrame()).not.toContain("Keep this explicit");

    setup.mockInput.pressEnter();
    await expect(result).resolves.toEqual({
      cancelled: false,
      answers: [
        { questionId: "scope", value: "large", label: "Large", custom: false },
        { questionId: "notes", value: "Keep this explicit", label: "Keep this explicit", custom: true },
      ],
    });
    await settle(setup);

    await setup.mockInput.typeText(" restored");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("draft restored");
  });

  test("Escape leaves custom input first, then cancels the questionnaire", async () => {
    const { setup, questionnaireManager } = await renderApp();
    const result = questionnaireManager.request({ id: "main", name: "main" }, [{
      id: "choice",
      prompt: "Choose",
      options: [{ value: "one", label: "One" }],
    }]);
    await settle(setup);

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(questionnaireManager.current()?.customInput).toBe(true);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(questionnaireManager.current()?.customInput).toBe(false);
    setup.mockInput.pressEscape();
    await expect(result).resolves.toEqual({ cancelled: true, answers: [] });
  });

  test("keeps the active child transcript and closes competing popups", async () => {
    const child = {
      id: "child-1",
      name: "worker-one",
      task: "Work",
      status: "idle",
      worktree: { name: "worker-one", path: "/tmp/worker-one", branch: "pum/worker-one", baseBranch: "main", baseCommit: "abc" },
      parentAgentId: null,
      modelId: "mock/mock-model",
      thinkingLevel: "off",
      transcript: { lines: [], stream: null, pending: [] },
      startedAt: 1,
      updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
    };
    const { setup, questionnaireManager } = await renderApp(64, 20, [child]);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("worker-one");

    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Settings");
    const result = questionnaireManager.request({ id: child.id, name: child.name }, [{
      id: "choice",
      prompt: "Choose",
      options: [{ value: "one", label: "One" }],
    }]);
    await settle(setup);
    const popup = setup.captureCharFrame();
    expect(popup).toContain("Questionnaire · worker-one");
    expect(popup).not.toContain("Settings");

    setup.mockInput.pressEscape();
    await expect(result).resolves.toEqual({ cancelled: true, answers: [] });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("worker-one");
  });

  test("renders in narrow and short terminals without exceeding the frame", async () => {
    expect(questionnairePopupGeometry(12, 4)).toEqual({
      left: 1,
      top: 0,
      width: 10,
      height: 4,
      compact: true,
    });
    const setup = await createTestRenderer({ width: 12, height: 4 });
    destroy = () => setup.renderer.destroy();
    const request: QuestionnaireRequest = {
      id: "short",
      requester: { id: "main", name: "main" },
      questions: [{
        id: "long",
        prompt: "A long question that must wrap safely",
        options: [{ value: "first", label: "A long selectable option" }],
      }],
      page: 0,
      optionIndices: [0],
      answers: new Map(),
      customInput: false,
    };
    createRoot(setup.renderer).render(
      <QuestionnairePopup
        theme={loadTheme("tokyonight")}
        request={request}
        terminalWidth={12}
        terminalHeight={4}
        inputRef={{ current: null }}
      />,
    );
    await settle(setup);
    const frame = setup.captureCharFrame().trimEnd().split("\n");
    expect(frame).toHaveLength(4);
    expect(frame.every((line) => line.length <= 12)).toBe(true);
  });
});

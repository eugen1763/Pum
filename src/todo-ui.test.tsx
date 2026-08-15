import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { saveTodoTasks, type TodoTask } from "./todo";

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

const T0 = 1_700_000_000_000;

function task(id: string, text: string, status: TodoTask["status"], age = 0): TodoTask {
  return { id, text, status, createdAt: T0 + age, updatedAt: T0 + age };
}

function fakeSession(path: string) {
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
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

async function renderApp(tasks: TodoTask[] = [], width = 100, height = 28) {
  const sessionFile = join(mkdtempSync(join(tmpdir(), "pum-todo-ui-")), "current-session.jsonl");
  if (tasks.length > 0) saveTodoTasks(sessionFile, tasks);
  const session = fakeSession(sessionFile);
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: async () => {},
    persistToolEvent() {},
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
  return setup;
}

describe("todo popup in the app", () => {
  test("Ctrl+O opens the list and Esc gives the prompt back", async () => {
    const setup = await renderApp([
      task("aaa111", "write the parser", "active"),
      task("bbb222", "review the diff", "pending", 1),
    ]);

    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("write the parser");
    expect(frame).toContain("review the diff");
    expect(frame).toContain("esc close");

    setup.mockInput.pressEscape();
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("write the parser");

    // Focus must come back, or the prompt silently swallows everything typed next.
    await setup.mockInput.typeText("after close");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("after close");
  });

  test("Ctrl+O does not type a control character into the prompt", async () => {
    const setup = await renderApp();
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);
    await setup.mockInput.typeText("plain");
    await settle(setup);
    const promptRow = setup.captureCharFrame().split("\n").findLast((row) => row.includes("❯"));
    expect(promptRow).toContain("plain");
    expect(promptRow).not.toContain("");
  });

  test("/todo opens the same popup and clears the command text", async () => {
    const setup = await renderApp([task("ccc333", "ship the release", "blocked")]);
    await setup.mockInput.typeText("/todo");
    setup.mockInput.pressEnter();
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("ship the release");
    expect(frame).not.toContain("❯ /todo");
  });

  test("an empty list explains how the agent turns the tools on", async () => {
    const setup = await renderApp();
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("enable_tools");
    expect(frame).toContain("Todo");
    expect(frame).toContain("todo_add");
  });

  test("f cycles the filter and the footer reports it", async () => {
    const setup = await renderApp([
      task("aaa111", "an active one", "active"),
      task("bbb222", "a completed one", "completed", 1),
    ]);
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("filter all");

    setup.mockInput.pressKey("f");
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("filter active");
    expect(frame).toContain("an active one");
    expect(frame).not.toContain("a completed one");
  });

  test("the popup opens on a narrow, short terminal without losing the footer", async () => {
    const setup = await renderApp([task("aaa111", "still reachable", "pending")], 52, 14);
    setup.mockInput.pressKey("o", { ctrl: true });
    await settle(setup);

    const rows = setup.captureCharFrame().split("\n");
    expect(rows.some((row) => row.includes("still reachable"))).toBe(true);
    expect(rows.some((row) => row.includes("esc"))).toBe(true);
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(52);
  });
});

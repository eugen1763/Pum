import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { saveNewsItems, type NewsItem } from "./news";

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

function fakeSession(path = join(mkdtempSync(join(tmpdir(), "pum-news-ui-")), "current-session.jsonl")) {
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

function newsItem(id: string, text: string, at: number, read = false, answered = false): NewsItem {
  return { id, text, at, read, answered };
}

const T0 = 1_700_000_000_000;

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(session: ReturnType<typeof fakeSession> = fakeSession()) {
  const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    sendUserMessage: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => ({
      name: "worker-one",
      path: "/tmp/project/.pum/worktrees/worker-one",
      branch: "pum/worker-one",
      baseBranch: "main",
      baseCommit: "abc123",
    }),
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
      promptHistoryStore={{
        load: () => [],
        append: () => [],
        remove: () => [],
      }}
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

describe("news keyboard shortcuts", () => {
  test("Ctrl+N opens the empty news popup and Esc restores the input", async () => {
    const setup = await renderApp();
    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("News");
    expect(frame).toContain("No answers yet.");

    setup.mockInput.pressEscape();
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("No answers yet.");
    await setup.mockInput.typeText("after close");
    await settle(setup);
    expectSetupInput(setup, "after close");
  });

  test("/news opens the popup and clears the command input", async () => {
    const setup = await renderApp();
    await setup.mockInput.typeText("/news");
    setup.mockInput.pressEnter();
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("No answers yet.");
    expect(frame).not.toContain("❯ /news");
  });

  test("shows the newest answer first and navigates with arrows", async () => {
    const session = fakeSession();
    saveNewsItems(session.sessionFile, [
      newsItem("a1", "Newest answer.", T0),
      newsItem("a2", "Older answer.", T0 - 60_000, true),
      newsItem("a3", "Oldest answer.", T0 - 3_600_000),
    ]);
    const setup = await renderApp(session);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("1 / 3");
    expect(frame).toContain("Newest answer.");

    setup.mockInput.pressArrow("left");
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("2 / 3");
    expect(frame).toContain("Older answer.");

    setup.mockInput.pressArrow("left");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("3 / 3");

    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("2 / 3");
    expect(setup.captureCharFrame()).toContain("Older answer.");
  });

  test("Space marks the current answer as read", async () => {
    const session = fakeSession();
    saveNewsItems(session.sessionFile, [newsItem("a1", "Unseen answer.", T0)]);
    const setup = await renderApp(session);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("◦");

    await setup.mockInput.typeText(" ");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("✓");
    expect(setup.captureCharFrame()).not.toContain("◦");
  });

  test("Enter replies with a prefilled quote and closes the popup", async () => {
    const session = fakeSession();
    saveNewsItems(session.sessionFile, [newsItem("a1", "First line of the answer.", T0)]);
    const setup = await renderApp(session);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("No answers yet.");
    expect(frame).toContain("> First line of the answer.");
  });

  test("a later user prompt marks the newest answer answered", async () => {
    const session = fakeSession();
    saveNewsItems(session.sessionFile, [newsItem("a1", "Answered by reply.", T0)]);
    const setup = await renderApp(session);

    await setup.mockInput.typeText("please continue");
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("✓");
  });

  test("closes news when another popup opens and opens from Settings", async () => {
    const setup = await renderApp();

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("No answers yet.");

    // Ctrl+H opens history and closes news.
    setup.mockInput.pressKey("h", { ctrl: true });
    await settle(setup);
    const historyFrame = setup.captureCharFrame();
    expect(historyFrame).toContain("Session history");
    expect(historyFrame).not.toContain("No answers yet.");

    // Escape history, open Settings, then Ctrl+N opens news and closes Settings.
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Settings");

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    const newsFrame = setup.captureCharFrame();
    expect(newsFrame).toContain("No answers yet.");
    expect(newsFrame).not.toContain("Settings");
  });
});

function expectSetupInput(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  expect(
    setup.captureCharFrame().split("\n").some((line) => line.includes(`❯ ${text}`)),
  ).toBe(true);
}

import { afterEach, describe, expect, test } from "bun:test";
import { TextareaRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App, promptPlaceholder } from "./app";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function fakeSession() {
  return {
    agent: {
      state: {
        model: {
          id: "mock-model",
          provider: "mock",
          input: ["text"],
          contextWindow: 32_000,
        },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [] },
    sessionFile: undefined,
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

async function renderApp(
  width: number,
  height: number,
  cachedPrompts: Array<{ text: string; executed: boolean }> = [],
) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession();
  const history: string[] = [];
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => ({}),
  } as any;
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={{
        showThinking: false,
        theme: "tokyonight",
        animations: false,
        workingRuleAnimation: "off",
        webSearch: false,
        writingStyle: "none",
        explanationStrength: "simple",
        checkMode: "off",
        checkModel: "mock/check",
        maxActiveSubagents: 10,
      }}
      searchProviders={[]}
      subagentManager={manager}
      promptHistoryStore={{
        load: () => [...history],
        append: (_cwd, prompt) => {
          if (history.at(-1) !== prompt) history.push(prompt);
          return [...history];
        },
        remove: () => [...history],
      }}
      promptStashStore={{
        load: () => cachedPrompts,
        append: () => cachedPrompts,
        markExecuted: () => cachedPrompts,
        markExecutedMany: () => cachedPrompts,
        replace: () => cachedPrompts,
        remove: () => cachedPrompts,
      }}
    />,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  return setup;
}

async function settle(setup: Awaited<ReturnType<typeof renderApp>>) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
}

function textarea(root: BaseRenderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root;
  for (const child of root.getChildren()) {
    const found = textarea(child);
    if (found) return found;
  }
  return undefined;
}

describe("prompt input layout", () => {
  test("renders the header-bottom rule directly below StatusBar", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const lines = setup.captureCharFrame().split("\n");

    expect(lines[0]).toBe("─".repeat(70));
    expect(lines[1]).toContain("pum");
    expect(lines[2]).toBe("─".repeat(70));
  });

  test("uses concise contextual placeholders without control hints", () => {
    const placeholders = [
      promptPlaceholder({ busy: false, stashOpen: false }),
      promptPlaceholder({ activeAgentName: "worker", busy: false, stashOpen: false }),
      promptPlaceholder({ activeAgentName: "worker", busy: true, stashOpen: false }),
      promptPlaceholder({ busy: true, stashOpen: false }),
      promptPlaceholder({ busy: false, stashOpen: true }),
    ];

    expect(placeholders).toEqual([
      "Ask something…",
      "Message worker…",
      "Steer worker…",
      "Steer…",
      "Cache…",
    ]);
    expect(placeholders.every((placeholder) => !placeholder.includes("[") && !placeholder.includes("Ctrl")))
      .toBe(true);
  });

  test("moves the only prompt glyph through command suggestions", async () => {
    const setup = await renderApp(70, 20);

    await setup.mockInput.typeText("/");
    await settle(setup);
    let frame = setup.captureCharFrame();

    expect(frame).toContain("❯ /compress");
    expect(frame).not.toContain("> /compress");
    expect(frame.match(/❯/gu)).toHaveLength(1);

    setup.mockInput.pressArrow("down");
    await settle(setup);
    frame = setup.captureCharFrame();

    expect(frame).toContain("❯ /clear");
    expect(frame).not.toContain("❯ /compress");
    expect(frame.match(/❯/gu)).toHaveLength(1);

    await setup.mockInput.typeText(" ");
    await settle(setup);
    frame = setup.captureCharFrame();

    expect(frame).toContain("❯ / ");
    expect(frame.match(/❯/gu)).toHaveLength(1);
  });

  test("Escape dismisses slash suggestions without deleting the draft", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("/c");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("/compress");

    setup.mockInput.pressEscape();
    await settle(setup);

    expect(textarea(setup.renderer.root)?.plainText).toBe("/c");
    expect(setup.captureCharFrame()).not.toContain("/compress");
  });

  test("shows when a cached prompt is checked out for editing", async () => {
    const setup = await renderApp(70, 20, [{ text: "cached draft", executed: false }]);
    // Each press depends on the state the previous one committed: Tab opens the
    // cache, Up selects a row, Tab checks that row out. Sending all three
    // before React commits makes the last Tab complete a path instead.
    setup.mockInput.pressTab();
    await settle(setup);
    setup.mockInput.pressArrow("up");
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);

    expect(textarea(setup.renderer.root)?.plainText).toBe("cached draft");
    expect(setup.captureCharFrame()).toContain("editing cache #1");
  });

  test("does not overflow a narrow terminal with confirmation hints", async () => {
    const setup = await renderApp(10, 16);
    setup.mockInput.pressKey("c", { ctrl: true });
    await settle(setup);

    expect(setup.captureCharFrame().split("\n").every((line) => line.length <= 10)).toBe(true);
  });

  test("completes a project path with Tab", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("review src/app.t");
    setup.mockInput.pressTab();
    await settle(setup);

    expect(textarea(setup.renderer.root)?.plainText).toBe("review src/app.tsx");
  });

  test("hides automatic path suggestions until the token has three characters", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("s");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("src/");

    await setup.mockInput.typeText("r");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("src/");

    await setup.mockInput.typeText("c");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("src/");
  });

  test("completes a short path prefix with Tab", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("s");
    setup.mockInput.pressTab();
    await settle(setup);

    expect(textarea(setup.renderer.root)?.plainText).toBe("scripts/");
  });

  test("shows path suggestions with the command-suggestion selection style", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("review src/app");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("❯ src/app-busy-steer.test.tsx");
    expect(frame.match(/❯/gu)).toHaveLength(1);
  });

  test("does not treat a leading slash as a path trigger", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("/src/app");
    await settle(setup);

    expect(setup.captureCharFrame()).not.toContain("src/app.tsx");
  });

  test("recalls an executed slash command with the arrow keys", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("/afk");
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pressArrow("up");
    await settle(setup);
    expect(textarea(setup.renderer.root)?.plainText).toBe("/afk");
  });

  test("wraps four columns before the former terminal-edge boundary", async () => {
    const setup = await renderApp(40, 16);

    await setup.mockInput.typeText("123456789012345678901234567890ABCD");
    await settle(setup);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("  123456789012345678901234567890AB");
    expect(frame).toContain("❯ CD");
    expect(frame.split("\n").every((line) => line.length <= 40)).toBe(true);
  });

  test("wraps prompt words without shifting continuation text", async () => {
    const setup = await renderApp(40, 16);

    await setup.mockInput.typeText("alpha beta gamma delta epsilon zeta");
    await settle(setup);
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const first = lines.find((line) => line.includes("alpha beta"));
    const second = lines.find((line) => line.includes("zeta"));
    const input = textarea(setup.renderer.root);

    expect(input?.wrapMode).toBe("word");
    expect(input?.width).toBe(32);
    expect(first).toContain("  alpha beta gamma delta epsilon");
    expect(second).toContain("❯ zeta");
    expect(first?.indexOf("alpha")).toBe(2);
    expect(second?.indexOf("zeta")).toBe(2);
    expect(frame).not.toContain("epsil\non");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { TextareaRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App, PROMPT_SCROLL_SPEED, promptPlaceholder } from "../src/app";
import { CARET_PERIOD_MS } from "../src/animation";
import {
  matchingCommandsForTarget,
  SUGGESTION_ROWS,
  suggestionWindowStart,
} from "../src/commands";

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
  options: { animations?: boolean; clock?: ManualClock } = {},
) {
  const setup = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
    clock: options.clock,
  });
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
        animations: options.animations ?? false,
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

function pressNavigation(
  setup: Awaited<ReturnType<typeof renderApp>>,
  name: "up" | "down" | "left" | "right" | "home" | "end",
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
) {
  setup.renderer.keyInput.processParsedKey({
    name,
    ctrl: modifiers.ctrl ?? false,
    meta: false,
    shift: modifiers.shift ?? false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "kitty",
  });
}

describe("prompt input layout", () => {
  test("typing after blur restores focus and inserts exact text once at the cursor", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const input = textarea(setup.renderer.root)!;
    await setup.mockInput.typeText("ab");
    await settle(setup);
    pressNavigation(setup, "left");
    input.blur();
    expect(input.focused).toBe(false);
    await setup.mockInput.typeText("/");
    await settle(setup);
    expect(input.plainText).toBe("a/b");
    expect(input.focused).toBe(true);
    input.blur();
    await setup.mockInput.typeText("É界.");
    await settle(setup);
    expect(input.plainText).toBe("a/É界.b");
    await setup.mockInput.typeText("X");
    expect(input.plainText).toBe("a/É界.Xb");
  });

  test("slash exits transcript focus and opens command suggestions", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const input = textarea(setup.renderer.root)!;
    await setup.mockInput.pressKey("y", { ctrl: true });
    await settle(setup);
    expect(input.focused).toBe(false);
    await setup.mockInput.typeText("/");
    await settle(setup);
    expect(input.focused).toBe(true);
    expect(input.plainText).toBe("/");
    expect(setup.captureCharFrame()).toContain("/clear");
  });

  test("navigation and Alt commands do not refocus a blurred prompt", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const input = textarea(setup.renderer.root)!;
    input.blur();
    pressNavigation(setup, "left");
    await setup.mockInput.pressKey("x", { meta: true });
    expect(input.focused).toBe(false);
    expect(input.plainText).toBe("");
    await setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("/secret");
    await settle(setup);
    expect(input.focused).toBe(false);
    expect(input.plainText).toBe("");
  });

  test("empty prompt help and shell shortcuts still own typing after blur", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const input = textarea(setup.renderer.root)!;
    input.blur();
    await setup.mockInput.typeText("?");
    await settle(setup);
    await setup.mockInput.typeText("/hidden");
    expect(input.plainText).toBe("");
    setup.mockInput.pressEscape();
    await settle(setup);
    input.blur();
    await setup.mockInput.typeText("!");
    await settle(setup);
    expect(input.plainText).toBe("");
    expect(input.focused).toBe(true);
    await setup.mockInput.typeText("pwd");
    expect(input.plainText).toBe("pwd");
  });

  test("renders the header-bottom rule directly below StatusBar", async () => {
    const setup = await renderApp(70, 16);
    await settle(setup);
    const lines = setup.captureCharFrame().split("\n");

    // The status row itself is responsive and drops fields on a narrow
    // terminal, so assert what this test is about: one measured row between
    // the two rules. Naming a field would tie the test to the checkout name.
    expect(lines[0]).toBe("─".repeat(70));
    expect(lines[1]).toContain("mock-model");
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
      "Forming a thought... (send to steer)",
      "Forming a thought... (send to steer)",
      "Cache…",
    ]);
    expect(placeholders.every((placeholder) => !placeholder.includes("[") && !placeholder.includes("Ctrl")))
      .toBe(true);
  });

  test("uses the slower prompt scroll and leaves cursor blinking to the terminal", async () => {
    const setup = await renderApp(70, 16);
    const input = textarea(setup.renderer.root);

    expect(PROMPT_SCROLL_SPEED).toBe(8);
    expect(input?.scrollSpeed).toBe(PROMPT_SCROLL_SPEED);
    expect(input?.cursorStyle).toEqual({ style: "block", blinking: true });
    expect(input?.showCursor).toBe(true);
  });

  test("does not animate the hardware cursor or keep an idle renderer live", async () => {
    const previousColorTerm = process.env.COLORTERM;
    process.env.COLORTERM = "truecolor";

    try {
      const clock = new ManualClock();
      const setup = await renderApp(70, 16, [], { animations: true, clock });
      const input = textarea(setup.renderer.root);

      expect(setup.renderer.liveRequestCount).toBe(0);
      expect(input?.showCursor).toBe(true);

      // The removed manual blink hid the cursor after 65% of this period. Even
      // after crossing that boundary, terminal-native blinking leaves the
      // textarea's logical cursor visible for every animated repaint.
      clock.advance(CARET_PERIOD_MS * 0.7);
      await setup.renderOnce();

      expect(input?.showCursor).toBe(true);
      expect(setup.renderer.liveRequestCount).toBe(0);
    } finally {
      if (previousColorTerm === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = previousColorTerm;
    }
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

  test("shows five suggestion rows and scrolls the rest into view", async () => {
    const commands = matchingCommandsForTarget("/", "main");
    expect(commands.length).toBeGreaterThan(SUGGESTION_ROWS);
    const setup = await renderApp(80, 24);
    const visibleNames = () => {
      const frame = setup.captureCharFrame();
      return commands
        .filter((command) => frame.includes(`${command.name}  \u2014`))
        .map((command) => command.name);
    };
    const windowNames = (cursor: number) => {
      const start = suggestionWindowStart(cursor, commands.length);
      return commands.slice(start, start + SUGGESTION_ROWS).map((command) => command.name);
    };

    await setup.mockInput.typeText("/");
    await settle(setup);
    expect(visibleNames()).toEqual(windowNames(0));

    // The window stays put until the selection passes the middle row.
    for (let press = 0; press < 3; press += 1) {
      setup.mockInput.pressArrow("down");
      await settle(setup);
    }
    expect(visibleNames()).toEqual(windowNames(3));
    expect(setup.captureCharFrame()).toContain(`\u276f ${commands[3]!.name}`);

    // The last command is reachable, and it is not visible from the top.
    const last = commands.length - 1;
    for (let press = 3; press < last; press += 1) {
      setup.mockInput.pressArrow("down");
      await settle(setup);
    }
    expect(visibleNames()).toEqual(windowNames(last));
    expect(setup.captureCharFrame()).toContain(`\u276f ${commands[last]!.name}`);
    expect(visibleNames()).not.toContain(commands[0]!.name);
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

  test("a multiline goal closes command suggestions and keeps Up and Down in the editor", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("/goal");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("/goalf");

    setup.mockInput.pressEnter({ shift: true });
    await settle(setup);

    const input = textarea(setup.renderer.root);
    expect(input?.plainText).toBe("/goal\n");
    expect(setup.captureCharFrame()).not.toContain("/goalf");
    expect(input?.cursorOffset).toBe(6);

    setup.mockInput.pressArrow("up");
    await settle(setup);
    expect(input?.cursorOffset).toBe(0);

    setup.mockInput.pressArrow("down");
    await settle(setup);
    expect(input?.cursorOffset).toBe(6);
  });

  test("a wrapped goal argument does not leave a command suggestion that captures Up and Down", async () => {
    const setup = await renderApp(40, 20);
    const goal = "/goal write a detailed goal that wraps onto another displayed prompt row";
    await setup.mockInput.typeText(goal);
    await settle(setup);

    const input = textarea(setup.renderer.root);
    expect(input?.editorView.getTotalVirtualLineCount()).toBeGreaterThan(1);
    expect(setup.captureCharFrame()).not.toContain("/goal  —");
    expect(input?.cursorOffset).toBe(goal.length);

    setup.mockInput.pressArrow("up");
    await settle(setup);
    expect(input?.cursorOffset).toBeLessThan(goal.length);

    setup.mockInput.pressArrow("down");
    await settle(setup);
    expect(input?.cursorOffset).toBe(goal.length);
  });

  test("checks out a cached prompt after the cache-close commit", async () => {
    const setup = await renderApp(70, 20, [{ text: "cached draft", executed: false }]);
    // Terminals can deliver this short key burst before React commits the open
    // cache view. Refs bind the selection, and the post-commit checkout must
    // keep the placeholder update from restoring the empty input on Windows.
    setup.mockInput.pressTab();
    setup.mockInput.pressArrow("up");
    setup.mockInput.pressTab();
    await settle(setup);

    expect(textarea(setup.renderer.root)?.plainText).toBe("cached draft");
    expect(setup.captureCharFrame()).toContain("editing cache #1");

    await setup.renderOnce();
    await setup.flush();
    expect(textarea(setup.renderer.root)?.plainText).toBe("cached draft");
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
    await settle(setup);
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
    // The candidates come from an asynchronous directory scan. Tab pressed
    // before they exist completes against nothing and leaves the "s" alone,
    // which is a slow machine finding a race rather than a broken completer.
    await settle(setup);
    setup.mockInput.pressTab();
    await settle(setup);

    expect(textarea(setup.renderer.root)?.plainText).toBe("scripts/");
  });

  test("shows path suggestions with the command-suggestion selection style", async () => {
    const setup = await renderApp(70, 20);
    await setup.mockInput.typeText("review src/app");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("❯ src/app.tsx");
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
    await settle(setup);
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

  test("moves Up and Down through displayed wrapped rows", async () => {
    const setup = await renderApp(40, 16);
    await setup.mockInput.typeText("alpha beta gamma delta epsilon zeta");
    await settle(setup);
    const input = textarea(setup.renderer.root)!;
    const endOffset = input.cursorOffset;
    const endRow = input.visualCursor.visualRow;

    pressNavigation(setup, "up");
    await settle(setup);
    expect(input.visualCursor.visualRow).toBe(endRow - 1);
    expect(input.cursorOffset).toBeLessThan(endOffset);

    pressNavigation(setup, "down");
    await settle(setup);
    expect(input.visualCursor.visualRow).toBe(endRow);
    expect(input.cursorOffset).toBe(endOffset);
  });

  test("uses Home and End for the displayed row and Ctrl for the full prompt", async () => {
    const setup = await renderApp(40, 16);
    const text = "alpha beta gamma delta epsilon zeta";
    await setup.mockInput.typeText(text);
    await settle(setup);
    const input = textarea(setup.renderer.root)!;
    const wrappedRow = input.visualCursor.visualRow;

    pressNavigation(setup, "home");
    await settle(setup);
    expect(input.visualCursor.visualRow).toBe(wrappedRow);
    expect(input.cursorOffset).toBeGreaterThan(0);

    pressNavigation(setup, "end");
    await settle(setup);
    expect(input.cursorOffset).toBe(text.length);

    pressNavigation(setup, "home", { ctrl: true });
    await settle(setup);
    expect(input.cursorOffset).toBe(0);

    pressNavigation(setup, "end", { ctrl: true });
    await settle(setup);
    expect(input.cursorOffset).toBe(text.length);
  });

  test("keeps Ctrl+Arrow navigation inside the prompt", async () => {
    const setup = await renderApp(40, 16);
    const text = "alpha beta gamma delta epsilon zeta";
    await setup.mockInput.typeText(text);
    await settle(setup);
    const input = textarea(setup.renderer.root)!;

    pressNavigation(setup, "left", { ctrl: true });
    await settle(setup);
    expect(input.cursorOffset).toBe(text.lastIndexOf("zeta"));

    pressNavigation(setup, "right", { ctrl: true });
    await settle(setup);
    expect(input.cursorOffset).toBe(text.length);

    pressNavigation(setup, "up", { ctrl: true });
    await settle(setup);
    expect(input.cursorOffset).toBe(0);

    pressNavigation(setup, "down", { ctrl: true });
    await settle(setup);
    expect(input.cursorOffset).toBe(text.length);
  });
});

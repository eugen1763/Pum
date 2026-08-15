import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App, queuedUserSteersInOrder } from "./app";

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

function fakeSession(options: { onPrompt?: (text: string) => void } = {}) {
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionId: "main-session",
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async (text: string) => options.onPrompt?.(text),
    steer: async () => {},
  } as any;
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

type RenderOptions = {
  kittyKeyboard?: boolean;
  otherModifiersMode?: boolean;
  width?: number;
  onPrompt?: (text: string) => void;
};

async function renderApp(options: RenderOptions = {}) {
  const setup = await createTestRenderer({
    width: options.width ?? 90,
    height: 28,
    kittyKeyboard: options.kittyKeyboard ?? true,
    otherModifiersMode: options.otherModifiersMode ?? false,
  });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession({ onPrompt: options.onPrompt });
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

/** The prompt rows: the two columns of text lines, one per input row. */
function promptRows(frame: string): string[] {
  const lines = frame.split("\n");
  const flatInputTop = lines.findIndex((line) => line.includes("Ask something…"));
  const flatInputBottom = lines.findIndex((line, index) =>
    index > flatInputTop && line.includes("❯"),
  );
  const start = Math.max(0, flatInputTop - 1);
  const end = flatInputBottom >= 0 ? flatInputBottom + 1 : lines.length;
  return lines.slice(start, end);
}

describe("prompt newline entry (Shift/Ctrl+Enter)", () => {
  test("Shift+Enter inserts a newline when the kitty protocol is negotiated", async () => {
    const setup = await renderApp();
    await setup.mockInput.typeText("first");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("second");
    await settle(setup);

    const rows = promptRows(setup.captureCharFrame());
    const first = rows.findIndex((row) => row.includes("first"));
    const second = rows.findIndex((row, index) => index > first && row.includes("second"));
    // Both lines are present and adjacent, so exactly one newline was added.
    expect(setup.captureCharFrame()).toContain("first");
    expect(setup.captureCharFrame()).toContain("second");
    expect(second).toBe(first + 1);
  });

  test("Ctrl+Enter inserts a newline when the kitty protocol is negotiated", async () => {
    const setup = await renderApp();
    await setup.mockInput.typeText("first");
    setup.mockInput.pressEnter({ ctrl: true });
    await setup.mockInput.typeText("second");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
  });

  test("raw kitty ESC[13;2u inserts a newline even without protocol negotiation", async () => {
    const setup = await renderApp({ kittyKeyboard: false });
    await setup.mockInput.typeText("first");
    setup.mockInput.pressKey("\x1b[13;2u"); // Shift+Enter, unparsed by OpenTUI
    await setup.mockInput.typeText("second");
    await settle(setup);

    const rows = promptRows(setup.captureCharFrame());
    const first = rows.findIndex((row) => row.includes("first"));
    const second = rows.findIndex((row) => row.includes("second"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(first + 1);
  });

  test("raw kitty ESC[13;5u inserts a newline even without protocol negotiation", async () => {
    const setup = await renderApp({ kittyKeyboard: false });
    await setup.mockInput.typeText("first");
    setup.mockInput.pressKey("\x1b[13;5u"); // Ctrl+Enter, unparsed by OpenTUI
    await setup.mockInput.typeText("second");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
  });

  test("modifyOtherKeys Shift+Enter and Ctrl+Enter insert newlines", async () => {
    const setup = await renderApp({ kittyKeyboard: false, otherModifiersMode: true });
    await setup.mockInput.typeText("first");
    setup.mockInput.pressEnter({ shift: true }); // ESC[27;2;13~
    await setup.mockInput.typeText("second");
    setup.mockInput.pressEnter({ ctrl: true }); // ESC[27;5;13~
    await setup.mockInput.typeText("third");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).toContain("third");
    const rows = promptRows(frame);
    const indices = ["first", "second", "third"].map((text) =>
      Math.max(0, rows.findIndex((row) => row.includes(text))),
    );
    expect(indices[1]).toBe(indices[0] + 1);
    expect(indices[2]).toBe(indices[1] + 1);
  });

  test("plain Enter still sends the prompt in every variant", async () => {
    const sent: Record<string, string[]> = { kitty: [], raw: [], other: [] };
    const kittySetup = await renderApp({ onPrompt: (text) => sent.kitty.push(text) });
    await kittySetup.mockInput.typeText("kitty message");
    kittySetup.mockInput.pressEnter();
    await settle(kittySetup);

    const rawSetup = await renderApp({
      kittyKeyboard: false,
      onPrompt: (text) => sent.raw.push(text),
    });
    await rawSetup.mockInput.typeText("raw message");
    rawSetup.mockInput.pressEnter();
    await settle(rawSetup);

    const otherSetup = await renderApp({
      kittyKeyboard: false,
      otherModifiersMode: true,
      onPrompt: (text) => sent.other.push(text),
    });
    await otherSetup.mockInput.typeText("other message");
    otherSetup.mockInput.pressEnter();
    await settle(otherSetup);

    // Plain Enter sends the prompt instead of inserting a newline, and the
    // sent message appears in the transcript (which renders one row per line
    // with a ❯ gutter of its own).
    expect(sent).toEqual({ kitty: ["kitty message"], raw: ["raw message"], other: ["other message"] });
    expect(rawSetup.captureCharFrame()).toContain("raw message");
    expect(otherSetup.captureCharFrame()).toContain("other message");
  });

  test("preserves internal spaces and tabs in displayed and delivered text", async () => {
    const sent: string[] = [];
    const setup = await renderApp({ onPrompt: (text) => sent.push(text) });
    await setup.mockInput.typeText("  alpha  beta\tgamma  ");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(sent).toEqual(["alpha  beta\tgamma"]);
    expect(setup.captureCharFrame()).toContain("alpha  beta");
  });

  test("matches recallable queued steers in original queue order", () => {
    const pending = [
      { id: "second", delivered: false, recallable: true, deliveryText: "wire-b", line: { kind: "text", role: "user", text: "display B" } },
      { id: "first", delivered: false, recallable: true, deliveryText: "wire-a", line: { kind: "text", role: "user", text: "display A" } },
      { id: "hidden", delivered: false, recallable: false, deliveryText: "wire-hidden", line: { kind: "text", role: "user", text: "hidden" } },
    ] as any;

    expect(queuedUserSteersInOrder(["wire-a", "wire-hidden", "wire-b"], pending))
      .toEqual(["display A", "display B"]);
  });

  test("trailing backslash plus Enter remains the fallback newline", async () => {
    const setup = await renderApp();
    await setup.mockInput.typeText("first\\");
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("second");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    // The trailing backslash is consumed by the fallback.
    expect(frame).not.toContain("first\\\n");
  });
});

describe("prompt gutter follows the cursor without typing", () => {
  test("arrow keys move the ❯ gutter to the cursor row", async () => {
    const setup = await renderApp({ width: 60 });
    await setup.mockInput.typeText("alpha");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("beta");
    await settle(setup);

    const frame = setup.captureCharFrame();
    const gutterRow = (text: string) =>
      frame.split("\n").findIndex((line) => line.includes(`❯ ${text}`));

    // Cursor sits at the end of the second line.
    expect(gutterRow("beta")).toBeGreaterThanOrEqual(0);
    expect(gutterRow("alpha")).toBe(-1);

    // Up moves the cursor (and gutter) to the first line.
    setup.mockInput.pressArrow("up");
    await settle(setup);
    let moved = setup.captureCharFrame();
    expect(moved.split("\n").findIndex((line) => line.includes("❯ alpha"))).toBeGreaterThanOrEqual(0);
    expect(moved.split("\n").findIndex((line) => line.includes("❯ beta"))).toBe(-1);

    // Down returns to the second line.
    setup.mockInput.pressArrow("down");
    await settle(setup);
    moved = setup.captureCharFrame();
    expect(moved.split("\n").findIndex((line) => line.includes("❯ beta"))).toBeGreaterThanOrEqual(0);
    expect(moved.split("\n").findIndex((line) => line.includes("❯ alpha"))).toBe(-1);
  });

  test("Home moves the gutter to the first line of a multiline prompt", async () => {
    const setup = await renderApp({ width: 60 });
    await setup.mockInput.typeText("alpha");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("beta");
    await settle(setup);

    setup.mockInput.pressKey("\x1b[H"); // Home
    await settle(setup);
    const moved = setup.captureCharFrame();
    expect(moved.split("\n").findIndex((line) => line.includes("❯ alpha"))).toBeGreaterThanOrEqual(0);
  });

  test("mouse click on the first prompt line moves the gutter", async () => {
    const setup = await renderApp({ width: 60 });
    await setup.mockInput.typeText("alpha");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("beta");
    await settle(setup);

    const lines = setup.captureCharFrame().split("\n");
    const alphaRow = lines.findIndex((line) => line.includes("alpha"));
    expect(alphaRow).toBeGreaterThanOrEqual(0);
    expect(lines[alphaRow].includes("❯ alpha")).toBe(false);

    // Click inside the first input line; the cursor (and gutter) move there
    // through the selection path, which does not fire onCursorChange.
    await setup.mockMouse.click(3, alphaRow);
    await settle(setup);

    const after = setup.captureCharFrame().split("\n");
    expect(after.findIndex((line) => line.includes("❯ alpha"))).toBeGreaterThanOrEqual(0);
    expect(after.findIndex((line) => line.includes("❯ beta"))).toBe(-1);
  });
});

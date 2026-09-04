import { afterEach, describe, expect, test } from "bun:test";
import { ScrollBoxRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { transcriptWindowRows } from "../src/transcript-window";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

const TERMINAL_WIDTH = 80;
const TERMINAL_HEIGHT = 24;

/** One user line and one answer line per turn, each with a findable marker. */
function entries(turns: number) {
  const list: any[] = [];
  for (let index = 0; index < turns; index++) {
    list.push({
      type: "message",
      id: `u${index}`,
      message: { role: "user", content: `ask ${index}` },
    });
    list.push({
      type: "message",
      id: `a${index}`,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
    });
  }
  return list;
}

function fakeSession(turns: number) {
  const list = entries(turns);
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => list },
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

async function renderApp(turns: number) {
  const setup = await createTestRenderer({
    width: TERMINAL_WIDTH,
    height: TERMINAL_HEIGHT,
    kittyKeyboard: true,
  });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession(turns);
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
      } as any}
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

/**
 * Markdown rows paint asynchronously, and mounting history takes a render and
 * then a layout, so every check here has to wait for the frames to go quiet.
 */
async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  for (let pass = 0; pass < 10; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 12));
    await setup.renderOnce();
    await setup.flush();
  }
  await setup.waitForVisualIdle({ quietFrames: 4, maxFrames: 240 });
}

function find(root: BaseRenderable, id: string): BaseRenderable | undefined {
  if (root.id === id) return root;
  for (const child of root.getChildren()) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}

function scrollbox(root: BaseRenderable): ScrollBoxRenderable {
  const found = find(root, "transcript-scrollbox");
  if (!(found instanceof ScrollBoxRenderable)) throw new Error("no transcript scrollbox");
  return found;
}

/** Absolute indices of the transcript rows currently in the tree. */
function mountedRowIndices(root: BaseRenderable): number[] {
  const indices: number[] = [];
  const visit = (node: BaseRenderable) => {
    const match = /^transcript-line-(\d+)$/.exec(node.id ?? "");
    if (match) indices.push(Number(match[1]));
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return indices.sort((a, b) => a - b);
}

/** The transcript text rows of the painted frame, blank rows removed. */
function transcriptText(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(ask|answer|❯ ask) \d+$/.test(line));
}

describe("transcript window", () => {
  test("mounts only the end of a long session", async () => {
    const setup = await renderApp(400);
    const indices = mountedRowIndices(setup.renderer.root);
    const rows = transcriptWindowRows(TERMINAL_HEIGHT);

    expect(indices.length).toBeLessThanOrEqual(rows);
    // 400 turns are 800 projected rows. The last one is always mounted.
    expect(indices.at(-1)).toBe(799);
    expect(indices).not.toContain(0);
    // The reader still starts at the end of the conversation.
    expect(setup.captureCharFrame()).toContain("answer 399");
  });

  test("mounts the whole of a short session", async () => {
    const setup = await renderApp(4);
    expect(mountedRowIndices(setup.renderer.root)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("mounts older rows when the reader scrolls back, without moving the view", async () => {
    const setup = await renderApp(400);
    const scroll = scrollbox(setup.renderer.root);
    const reading = mountedRowIndices(setup.renderer.root)[0]!;

    // The top of the mounted run is the top of the viewport at this position.
    scroll.scrollTop = 0;
    await settle(setup);

    expect(mountedRowIndices(setup.renderer.root)[0]!).toBeLessThan(reading);
    // The row the reader had at the top of the screen is still at the top of
    // the screen. Without the scroll correction the rows that mounted above it
    // would have pushed it down and out of the viewport.
    const row = scroll.findDescendantById(`transcript-line-${reading}`);
    expect(row).toBeDefined();
    expect(row!.y - scroll.viewport.y).toBe(0);
    expect(transcriptText(setup.captureCharFrame()).length).toBeGreaterThan(0);
  });

  // A reader who sends the view to the very top asks for the start of the
  // session, not for one more window of history. Holding their old place there
  // makes the gesture look dead and puts the first message out of reach.
  test("reaches the first row in one jump to the top", async () => {
    const setup = await renderApp(400);
    const scroll = scrollbox(setup.renderer.root);

    // The reader drags the scrollbar to the top: the view lands against the
    // first mounted row and the drag says the reader put it there.
    const bar = scroll.verticalScrollBar;
    await setup.mockMouse.drag(bar.x, bar.y + bar.height - 2, bar.x, bar.y);
    await settle(setup);

    expect(mountedRowIndices(setup.renderer.root)[0]).toBe(0);
    expect(scroll.scrollTop).toBe(0);
    expect(setup.captureCharFrame()).toContain("ask 0");
  });

  test("reaches the first row when the reader keeps scrolling back", async () => {
    const setup = await renderApp(60);
    const scroll = scrollbox(setup.renderer.root);

    for (let attempt = 0; attempt < 20; attempt++) {
      if (mountedRowIndices(setup.renderer.root)[0] === 0) break;
      scroll.scrollTop = 0;
      await settle(setup);
    }

    expect(mountedRowIndices(setup.renderer.root)[0]).toBe(0);
    // Nothing is left to mount above, so this scroll stays at the top.
    scroll.scrollTop = 0;
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("ask 0");
  });

  test("mounts a row the transcript cursor walks back to", async () => {
    // 100 turns are 200 rows, and one window is 60 of them, so the cursor
    // starts at row 199 with row 129 well outside the tree.
    const setup = await renderApp(100);
    const start = mountedRowIndices(setup.renderer.root)[0]!;
    expect(start).toBe(140);

    setup.mockInput.pressKey("y", { ctrl: true });
    for (let step = 0; step < 70; step++) setup.mockInput.pressArrow("up");
    await settle(setup);

    expect(mountedRowIndices(setup.renderer.root)).toContain(129);
    // Row 129 is the answer of turn 64. It is on screen, not merely in the tree.
    expect(setup.captureCharFrame()).toContain("answer 64");
  });

  test("mounts more rows for a taller terminal", async () => {
    const setup = await renderApp(400);
    expect(mountedRowIndices(setup.renderer.root).length)
      .toBe(transcriptWindowRows(TERMINAL_HEIGHT));

    setup.resize(TERMINAL_WIDTH, 60);
    await settle(setup);

    // A window that kept its old start would leave the taller viewport short of
    // rows and paint blank space above the conversation.
    expect(mountedRowIndices(setup.renderer.root).length).toBe(transcriptWindowRows(60));
    expect(setup.captureCharFrame()).toContain("answer 399");
  });

  test("returns to the end and lets the window shrink again", async () => {
    const setup = await renderApp(400);
    const scroll = scrollbox(setup.renderer.root);

    scroll.scrollTop = 0;
    await settle(setup);
    expect(mountedRowIndices(setup.renderer.root).length)
      .toBeGreaterThan(transcriptWindowRows(TERMINAL_HEIGHT));

    scroll.scrollTop = scroll.scrollHeight;
    await settle(setup);

    expect(mountedRowIndices(setup.renderer.root).length)
      .toBeLessThanOrEqual(transcriptWindowRows(TERMINAL_HEIGHT));
    expect(setup.captureCharFrame()).toContain("answer 399");
  });
});

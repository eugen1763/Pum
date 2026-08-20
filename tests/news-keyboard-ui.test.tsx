import { afterEach, describe, expect, test } from "bun:test";
import { MarkdownRenderable, ScrollBoxRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import type { ClipboardRoute } from "../src/clipboard";
import { saveNewsItems, type NewsItem } from "../src/news";

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

function fakeSession(
  path = join(mkdtempSync(join(tmpdir(), "pum-news-ui-")), "current-session.jsonl"),
  contextEntries: any[] = [],
) {
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => contextEntries, getEntries: () => [] },
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
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(
  session: ReturnType<typeof fakeSession> = fakeSession(),
  copyNewsAnswerText?: (text: string) => Promise<ClipboardRoute>,
) {
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
      copyNewsAnswerText={copyNewsAnswerText}
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
    expect(setup.captureCharFrame()).toContain("1 / 3");
    expect(newsMarkdownSetup(setup)).toBe("Newest answer.");

    setup.mockInput.pressArrow("left");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("2 / 3");
    expect(newsMarkdownSetup(setup)).toBe("Older answer.");

    setup.mockInput.pressArrow("left");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("3 / 3");
    expect(newsMarkdownSetup(setup)).toBe("Oldest answer.");

    setup.mockInput.pressArrow("right");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("2 / 3");
    expect(newsMarkdownSetup(setup)).toBe("Older answer.");
  });

  test("n closes News and jumps to the answer; p jumps to the user prompt", async () => {
    const before = Array.from({ length: 18 }, (_, index) => ({
      type: "message",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: index % 2 === 0
          ? `Earlier prompt ${index}`
          : [{ type: "text", text: `Earlier answer ${index}` }],
      },
    }));
    const after = Array.from({ length: 18 }, (_, index) => ({
      type: "message",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: index % 2 === 0
          ? `Later prompt ${index}`
          : [{ type: "text", text: `Later answer ${index}` }],
      },
    }));
    const prompt = "Target user prompt";
    const answer = "Target assistant answer";
    const promptIndex = before.length;
    const answerIndex = promptIndex + 1;
    const session = fakeSession(undefined, [
      ...before,
      { type: "message", message: { role: "user", content: prompt } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
      ...after,
    ]);
    saveNewsItems(session.sessionFile, [{
      ...newsItem("a1", answer, T0),
      prompts: [{ text: prompt, steer: false }],
    }]);
    const setup = await renderApp(session);
    const renderable = setup.renderer.root.findDescendantById("transcript-scrollbox");
    expect(renderable).toBeInstanceOf(ScrollBoxRenderable);
    const transcript = renderable as ScrollBoxRenderable;
    expect(transcript.scrollHeight).toBeGreaterThan(transcript.viewport.height);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("n");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("1 / 1");
    expectTranscriptTargetVisible(transcript, answerIndex);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    setup.renderer.keyInput.processParsedKey({
      name: "",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      number: false,
      sequence: "\u001b[112u",
      raw: "\u001b[112u",
      eventType: "press",
      source: "kitty",
    });
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("1 / 1");
    expectTranscriptTargetVisible(transcript, promptIndex);
  });

  test("shows finish identity and uses the stable completion message for prompt navigation", async () => {
    const notice = "Subagent worker completed.\nsummary: Child tests passed.";
    const answer = "Main merged the child result.";
    const before = Array.from({ length: 24 }, (_, index) => ({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Earlier answer ${index}` }],
      },
    }));
    const promptIndex = before.length + 1;
    const session = fakeSession(undefined, [
      ...before,
      {
        type: "custom_message",
        customType: "pum.agent_message",
        content: notice,
        details: {
          id: "wrong-settlement",
          sender: "worker",
          recipient: "main",
          text: notice,
          at: T0 - 1,
          kind: "completion",
        },
      },
      {
        type: "custom_message",
        customType: "pum.agent_message",
        content: notice,
        details: {
          id: "settlement-worker:1:completed",
          sender: "worker",
          recipient: "main",
          text: notice,
          at: T0,
          kind: "completion",
        },
      },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ]);
    saveNewsItems(session.sessionFile, [{
      ...newsItem("subagent-finish:settlement-worker:1:completed", answer, T0),
      prompts: [{ text: notice, steer: false }],
      completion: {
        settlementId: "worker:1:completed",
        messageId: "settlement-worker:1:completed",
        agentId: "worker",
        agentName: "worker",
        requesterAgentId: null,
        requesterName: "main",
        summary: "Child tests passed.",
      },
    }]);
    const setup = await renderApp(session);
    const transcript = setup.renderer.root.findDescendantById("transcript-scrollbox") as ScrollBoxRenderable;

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("worker → main · finish_subagent");
    expect(newsMarkdownSetup(setup)).toBe(answer);

    await setup.mockInput.typeText("p");
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("1 / 1");
    expectTranscriptTargetVisible(transcript, promptIndex);
  });

  test("Space toggles the current answer read and unread", async () => {
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

    await setup.mockInput.typeText(" ");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("◦");
    expect(setup.captureCharFrame()).not.toContain("✓");

    await setup.mockInput.typeText(" ");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("✓");
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

  test("a later user prompt marks the newest answer answered when it follows directly", async () => {
    const session = fakeSession(undefined, [{
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Answered by reply." }] },
    }]);
    saveNewsItems(session.sessionFile, [newsItem("a1", "Answered by reply.", T0)]);
    const setup = await renderApp(session);

    await setup.mockInput.typeText("please continue");
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("✓");
  });

  test("a message in between stops the previous answer being marked read", async () => {
    const session = fakeSession(undefined, [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Blocked by a note." }] },
      },
      {
        type: "custom",
        customType: "pum.agent_message_display",
        data: { id: "m1", sender: "worker", recipient: "main", text: "subagent note" },
      },
    ]);
    saveNewsItems(session.sessionFile, [newsItem("a1", "Blocked by a note.", T0)]);
    const setup = await renderApp(session);

    await setup.mockInput.typeText("please continue");
    setup.mockInput.pressEnter();
    await settle(setup);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("◦");
    expect(setup.captureCharFrame()).not.toContain("✓");
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

  test("shows the user prompt and steers above the answer", async () => {
    const session = fakeSession();
    saveNewsItems(session.sessionFile, [{
      ...newsItem("a1", "The final answer.", T0),
      prompts: [
        { text: "First question", steer: false },
        { text: "Keep going", steer: true },
      ],
    }]);
    const setup = await renderApp(session);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    const contents = descendants(setup.renderer.root, MarkdownRenderable).map((row) => row.content);
    expect(contents[0]).toBe("First question");
    expect(contents[1]).toBe("Keep going");
    expect(contents.at(-1)).toBe("The final answer.");
    expect(newsMarkdownSetup(setup)).toBe("The final answer.");
  });

  test("C copies the selected answer to the clipboard", async () => {
    const session = fakeSession();
    saveNewsItems(session.sessionFile, [
      newsItem("a1", "Copy the first answer.", T0),
      newsItem("a2", "Copy the second answer.", T0 - 60_000),
    ]);
    const copied: string[] = [];
    const copyNewsAnswerText = async (text: string): Promise<ClipboardRoute> => {
      copied.push(text);
      return "command";
    };
    const setup = await renderApp(session, copyNewsAnswerText);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("c");
    await settle(setup);
    expect(copied).toEqual(["Copy the first answer."]);

    setup.mockInput.pressArrow("left");
    await settle(setup);
    await setup.mockInput.typeText("c");
    await settle(setup);
    expect(copied).toEqual(["Copy the first answer.", "Copy the second answer."]);
  });

  // Successful tool calls fold into one activity row, so a row sits at a very
  // different index than its line does in the session. The jump has to use the
  // index of the row on screen, not the index of the line in the transcript.
  test("jumps to an answer that sits behind folded tool rows", async () => {
    const answer = "Target assistant answer";
    const prompt = "Target user prompt";
    const entries: any[] = [];
    for (let turn = 0; turn < 30; turn++) {
      entries.push({ type: "message", message: { role: "user", content: `Later prompt ${turn}` } });
      for (let call = 0; call < 4; call++) {
        const id = `t${turn}-${call}`;
        entries.push({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id, name: "read", arguments: { path: `file-${id}.ts` } }],
          },
        });
        entries.push({ type: "message", message: { role: "toolResult", toolCallId: id, output: "ok" } });
      }
      entries.push({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: `Later answer ${turn}` }] },
      });
    }
    entries.push({ type: "message", message: { role: "user", content: prompt } });
    entries.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
    });
    for (let turn = 0; turn < 10; turn++) {
      entries.push({ type: "message", message: { role: "user", content: `Tail prompt ${turn}` } });
      entries.push({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: `Tail answer ${turn}` }] },
      });
    }
    const session = fakeSession(undefined, entries);
    saveNewsItems(session.sessionFile, [{
      ...newsItem("a1", answer, T0),
      prompts: [{ text: prompt, steer: false }],
    }]);
    const setup = await renderApp(session);
    const transcript = setup.renderer.root.findDescendantById("transcript-scrollbox") as ScrollBoxRenderable;

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("n");
    await settle(setup);

    expect(setup.captureCharFrame()).not.toContain("1 / 1");
    expect(setup.captureCharFrame()).toContain(answer);
  });

  test("says so when the stored answer has no row to jump to", async () => {
    const session = fakeSession(undefined, [
      { type: "message", message: { role: "user", content: "A question" } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "A different answer" }] },
      },
    ]);
    saveNewsItems(session.sessionFile, [newsItem("a1", "An answer that was compacted away", T0)]);
    const setup = await renderApp(session);

    setup.mockInput.pressKey("n", { ctrl: true });
    await settle(setup);
    await setup.mockInput.typeText("n");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("1 / 1");
    expect(frame).toContain("not in the transcript any more");
  });
});

function expectSetupInput(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  expect(
    setup.captureCharFrame().split("\n").some((line) => line.includes(`❯ ${text}`)),
  ).toBe(true);
}

function expectTranscriptTargetVisible(transcript: ScrollBoxRenderable, index: number) {
  const target = transcript.findDescendantById(`transcript-line-${index}`);
  expect(target).toBeDefined();
  expect(target!.screenY).toBeGreaterThanOrEqual(transcript.viewport.screenY);
  expect(target!.screenY).toBeLessThan(transcript.viewport.screenY + transcript.viewport.height);
}

function descendants<T extends BaseRenderable>(
  root: BaseRenderable,
  type: abstract new (...args: any[]) => T,
): T[] {
  const found: T[] = [];
  const visit = (node: BaseRenderable) => {
    if (node instanceof type) found.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

/** The news popup body is a single MarkdownRenderable with the answer text. */
function newsMarkdownSetup(setup: Awaited<ReturnType<typeof createTestRenderer>>): string {
  const rows = descendants(setup.renderer.root, MarkdownRenderable);
  expect(rows.length).toBeGreaterThan(0);
  const row = rows[rows.length - 1]!;
  expect(row.width).toBeGreaterThan(0);
  expect(row.height).toBeGreaterThan(0);
  return row.content;
}

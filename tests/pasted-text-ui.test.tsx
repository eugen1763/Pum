import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { cleanupPendingPastedTexts, MAX_PASTED_TEXT_BYTES } from "../src/pasted-text";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
  cleanupPendingPastedTexts();
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

function fakeSession(path = join(mkdtempSync(join(tmpdir(), "pum-pasted-ui-")), "current-session.jsonl")) {
  let subscribeHandler: ((event: any) => void) | undefined;
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
    subscribe: (handler: (event: any) => void) => {
      subscribeHandler = handler;
      return () => {};
    },
    /** Test hook: fire the main session's agent_settled event. */
    settle: () => subscribeHandler?.({ type: "agent_settled" }),
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

function pastedTextFiles(): string[] {
  const dirs = readdirSync(tmpdir()).filter((name) => name.startsWith("pum-pasted-text-"));
  return dirs.flatMap((dir) =>
    readdirSync(join(tmpdir(), dir)).map((file) => join(tmpdir(), dir, file)),
  );
}

const BIG_PAYLOAD = "y".repeat(MAX_PASTED_TEXT_BYTES + 1024);

describe("large text paste placeholder", () => {
  test("a paste larger than 16 KB becomes a marker instead of raw text", async () => {
    const setup = await renderApp();

    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[Pasted text #1]");
    expect(frame).not.toContain("yyy");
    expect(pastedTextFiles().length).toBe(1);
  });

  test("a paste at or under 16 KB stays inline", async () => {
    const setup = await renderApp();

    await setup.mockInput.pasteBracketedText("plain small text");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("plain small text");
    expect(frame).not.toContain("[Pasted text");
    expect(pastedTextFiles().length).toBe(0);
  });

  test("a four-line stack trace becomes a marker even when it is small", async () => {
    const setup = await renderApp();
    const stack = [
      "Error: failed",
      "    at first (app.ts:1:1)",
      "    at second (app.ts:2:1)",
      "    at third (app.ts:3:1)",
    ].join("\n");

    await setup.mockInput.pasteBracketedText(stack);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[Pasted text #1]");
    expect(frame).not.toContain("Error: failed");
    expect(pastedTextFiles().length).toBe(1);
  });

  test("a three-line paste stays inline", async () => {
    const setup = await renderApp();

    await setup.mockInput.pasteBracketedText("one\ntwo\nthree");
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("three");
    expect(frame).not.toContain("[Pasted text");
    expect(pastedTextFiles().length).toBe(0);
  });

  test("the marker uses the [Pasted text #n] form and the temp file holds the payload", async () => {
    const setup = await renderApp();

    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
    const files = pastedTextFiles();
    expect(files.length).toBe(1);
  });

  test("Alt+Enter does not cache a draft with a pasted-text attachment", async () => {
    const setup = await renderApp();
    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);

    setup.mockInput.pressEnter({ meta: true });
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
    expect(setup.captureCharFrame()).toContain("cannot be stored in the cache");
    expect(pastedTextFiles().length).toBe(1);
  });

  test("restores a pasted-text draft and attachment after a failed main send", async () => {
    const session = fakeSession();
    session.prompt = async () => { throw new Error("send rejected"); };
    const setup = await renderApp(session);
    await setup.mockInput.typeText("before ");
    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);

    setup.mockInput.pressEnter();
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("before [Pasted text #1]");
    expect(setup.captureCharFrame()).toContain("send rejected");
    expect(pastedTextFiles().length).toBe(1);
  });

  test("sending removes the temp file after the turn settles", async () => {
    const session = fakeSession();
    const setup = await renderApp(session);

    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);
    expect(pastedTextFiles().length).toBe(1);

    setup.mockInput.pressEnter();
    await settle(setup);
    // The file must survive long enough for the model to read it.
    expect(pastedTextFiles().length).toBe(1);

    session.settle();
    await settle(setup);
    expect(pastedTextFiles().length).toBe(0);
  });

  test("editing the marker removes the marker and its temp file", async () => {
    const setup = await renderApp();

    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);
    expect(pastedTextFiles().length).toBe(1);

    setup.mockInput.pressBackspace();
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("[Pasted text");
    expect(frame).not.toContain("yyy");
    expect(frame).toContain("removed 1 pasted-text attachment after its marker was edited");
    expect(pastedTextFiles().length).toBe(0);
  });

  test("deleting the pasted snippet before sending removes its temp file", async () => {
    const setup = await renderApp();

    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD);
    await settle(setup);
    const file = pastedTextFiles()[0];
    expect(existsSync(file)).toBe(true);

    // Select-all then delete removes the whole snippet from the draft.
    for (let index = 0; index < 40; index++) setup.mockInput.pressBackspace();
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("[Pasted text");
    expect(pastedTextFiles().length).toBe(0);
  });
});

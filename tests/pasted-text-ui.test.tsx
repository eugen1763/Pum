import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { MAX_PASTED_TEXT_BYTES } from "../src/pasted-text";
import { settleSyntaxHighlighting } from "../src/syntax";

let destroy: (() => Promise<void>) | undefined;
afterEach(async () => { await destroy?.(); destroy = undefined; });
const settings = {
  showThinking: false, theme: "tokyonight" as const, animations: false,
  workingRuleAnimation: "off" as const, webSearch: false, writingStyle: "none" as const,
  explanationStrength: "simple" as const, checkMode: "off" as const,
  checkModel: "mock/check", maxActiveSubagents: 10,
};
function fakeSession() {
  let handler: ((event: any) => void) | undefined;
  return {
    agent: { state: { model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    sessionFile: join(mkdtempSync(join(tmpdir(), "pum-pasted-ui-")), "current-session.jsonl"),
    sessionId: "current-session",
    subscribe: (callback: (event: any) => void) => { handler = callback; return () => {}; },
    settle: () => handler?.({ type: "agent_settled" }),
    setThinkingLevel() {}, setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }), prompt: async () => {}, steer: async () => {},
  } as any;
}
async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce(); await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settleSyntaxHighlighting(setup.renderer.root);
  await setup.renderer.idle();
  await setup.renderOnce(); await setup.flush();
}
async function renderApp(session = fakeSession(), managerOverrides: Record<string, unknown> = {}) {
  const setup = await createTestRenderer({ width: 100, height: 28, kittyKeyboard: true });
  const root = createRoot(setup.renderer);
  destroy = async () => {
    await settleSyntaxHighlighting(setup.renderer.root);
    root.unmount();
    await setup.flush();
    await setup.renderer.idle();
    setup.renderer.destroy();
  };
  const manager = {
    getAgents: () => [], subscribe: () => () => {}, bindMainSession: async () => {},
    abortAgent: async () => {}, sendUserMessage: async () => {}, persistToolEvent() {},
    ...managerOverrides,
  } as any;
  const history: string[] = [];
  root.render(
    <App session={session} modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
      settings={settings} searchProviders={[]} subagentManager={manager}
      promptHistoryStore={{ load: () => [], append: (_cwd, text) => { history.push(text); return [...history]; }, remove: () => [] }}
      promptStashStore={{ load: () => [], append: () => [], markExecuted: () => [], markExecutedMany: () => [], replace: () => [], remove: () => [] }}
    />,
  );
  await settle(setup);
  return Object.assign(setup, { history });
}
const pasteDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pum-pasted-text-"));
const BIG_PAYLOAD = "y".repeat(MAX_PASTED_TEXT_BYTES + 1024);
const STACK = "Error: failed\n    at first\n    at second\n    at third";

describe("in-memory paste placeholder", () => {
  for (const payload of [BIG_PAYLOAD, STACK]) {
    test(`shortens a ${payload.length}-character paste without files`, async () => {
      const before = pasteDirs();
      const setup = await renderApp();
      await setup.mockInput.pasteBracketedText(payload); await settle(setup);
      expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
      expect(setup.captureCharFrame()).not.toContain(payload.slice(0, 10));
      expect(pasteDirs()).toEqual(before);
    });
  }
  test("small and three-line pastes stay inline", async () => {
    const setup = await renderApp();
    await setup.mockInput.pasteBracketedText("one\ntwo\nthree"); await settle(setup);
    expect(setup.captureCharFrame()).toContain("three");
    expect(setup.captureCharFrame()).not.toContain("[Pasted text");
  });
  test("sends full literal payload and persists usable history and transcript text", async () => {
    const before = pasteDirs();
    const session = fakeSession();
    const prompts: string[] = [];
    session.prompt = async (text: string) => { prompts.push(text); };
    const setup = await renderApp(session);
    const first = "first $& $` $' $$ [Pasted text #2]\na\nb\nc";
    await setup.mockInput.pasteBracketedText(first); await settle(setup);
    await setup.mockInput.typeText(" then ");
    await setup.mockInput.pasteBracketedText(STACK); await settle(setup);
    setup.mockInput.pressEnter(); await settle(setup);
    expect(prompts).toEqual([first + " then " + STACK]);
    expect(setup.history).toEqual(prompts);
    expect(setup.captureCharFrame()).toContain("Error: failed");
    expect(setup.captureCharFrame()).not.toContain("Read this temp file");
    session.settle(); await settle(setup);
    expect(pasteDirs()).toEqual(before);
  });
  test("failed main delivery restores the marker and retries the actual payload", async () => {
    const session = fakeSession();
    session.prompt = async () => { throw new Error("send rejected"); };
    const setup = await renderApp(session);
    await setup.mockInput.typeText("before ");
    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD); await settle(setup);
    setup.mockInput.pressEnter(); await settle(setup);
    expect(setup.captureCharFrame()).toContain("before [Pasted text #1]");
    expect(setup.captureCharFrame()).toContain("send rejected");
    const prompts: string[] = [];
    session.prompt = async (text: string) => { prompts.push(text); };
    setup.mockInput.pressEnter(); await settle(setup);
    expect(prompts).toEqual(["before " + BIG_PAYLOAD]);
  });
  test("queued steering contains the payload, not an ephemeral marker", async () => {
    const session = fakeSession();
    const steering: string[] = [];
    session.steer = async (text: string) => { steering.push(text); };
    const setup = await renderApp(session);
    await setup.mockInput.typeText("start"); setup.mockInput.pressEnter(); await settle(setup);
    await setup.mockInput.pasteBracketedText(STACK); await settle(setup);
    setup.mockInput.pressEnter(); await settle(setup);
    expect(steering).toEqual([STACK]);
    expect(setup.captureCharFrame()).toContain("Error: failed");
  });
  test("child delivery uses full text and pending pastes block agent switching", async () => {
    const sent: unknown[][] = [];
    const agent = {
      id: "worker", name: "worker", task: "test", status: "idle", parentAgentId: null,
      modelId: "mock/mock-model", thinkingLevel: "off",
      worktree: { name: "worker", path: process.cwd(), branch: "main", baseBranch: "main", baseCommit: "abc" },
      transcript: { lines: [], stream: null, pending: [] }, startedAt: 1, updatedAt: 1,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
    };
    let fail = true;
    const setup = await renderApp(fakeSession(), {
      getAgents: () => [agent],
      sendUserMessage: async (...args: unknown[]) => {
        if (fail) throw new Error("child send rejected");
        sent.push(args);
      },
    });
    setup.mockInput.pressTab({ shift: true }); await settle(setup);
    await setup.mockInput.pasteBracketedText(STACK); await settle(setup);
    setup.mockInput.pressTab({ shift: true }); await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
    expect(setup.captureCharFrame()).toContain("worker");
    setup.mockInput.pressEnter(); await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
    fail = false;
    setup.mockInput.pressEnter(); await settle(setup);
    expect(sent).toEqual([["worker", STACK, [], STACK]]);
  });
  test("a paste inside a marker replaces the old payload atomically", async () => {
    const session = fakeSession();
    const prompts: string[] = [];
    session.prompt = async (text: string) => { prompts.push(text); };
    const setup = await renderApp(session);
    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD); await settle(setup);
    setup.mockInput.pressArrow("left"); await settle(setup);
    await setup.mockInput.pasteBracketedText(STACK); await settle(setup);
    setup.mockInput.pressEnter(); await settle(setup);
    expect(prompts).toEqual([STACK]);
  });
  test("Alt+Enter keeps the attached draft instead of caching a marker", async () => {
    const setup = await renderApp();
    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD); await settle(setup);
    setup.mockInput.pressEnter({ meta: true }); await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Pasted text #1]");
    expect(setup.captureCharFrame()).toContain("cannot be stored in the cache");
  });
  test("editing a marker removes the entire attachment", async () => {
    const session = fakeSession();
    const prompts: string[] = [];
    session.prompt = async (text: string) => { prompts.push(text); };
    const setup = await renderApp(session);
    await setup.mockInput.pasteBracketedText(BIG_PAYLOAD); await settle(setup);
    setup.mockInput.pressBackspace(); await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("[Pasted text");
    expect(setup.captureCharFrame()).toContain("removed 1 pasted-text attachment");
    await setup.mockInput.typeText("remaining"); setup.mockInput.pressEnter(); await settle(setup);
    expect(prompts).toEqual(["remaining"]);
  });
});

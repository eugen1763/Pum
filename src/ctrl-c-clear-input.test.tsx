import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { destroyTreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { settleSyntaxHighlighting } from "./syntax";

type SessionEvent = { type: string; [key: string]: unknown };

let destroy: (() => void | Promise<void>) | undefined;
let testDir: string | undefined;
afterEach(async () => {
  await destroy?.();
  destroy = undefined;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
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

function agent(id: string, name: string, status = "idle") {
  return {
    id,
    name,
    task: "test",
    status,
    worktree: { name, path: `/tmp/${name}`, branch: `pum/${name}`, baseBranch: "main", baseCommit: "abc" },
    parentAgentId: null,
    modelId: "mock/mock-model",
    thinkingLevel: "off",
    transcript: { lines: [], stream: null, pending: [] },
    startedAt: 1,
    updatedAt: 1,
    usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
  };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function renderApp(options: {
  agents?: any[];
  onExit?: () => void;
  captureImage?: () => Promise<{ path: string; mimeType: string }>;
} = {}) {
  const setup = await createTestRenderer({
    width: 76,
    height: 22,
    kittyKeyboard: true,
    otherModifiersMode: true,
    exitOnCtrlC: false,
  });
  const root = createRoot(setup.renderer);
  destroy = async () => {
    await settleSyntaxHighlighting(setup.renderer.root);
    root.unmount();
    await setup.flush();
    await setup.renderer.idle();
    setup.renderer.destroy();
    await destroyTreeSitterClient();
  };
  let sessionListener: ((event: SessionEvent) => void) | undefined;
  const calls = {
    abort: 0,
    exit: 0,
    prompts: [] as string[],
    steers: [] as string[],
    childMessages: [] as Array<{ id: string; text: string }>,
  };
  const session = {
    sessionId: "main-session",
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text", "image"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: (listener: (event: SessionEvent) => void) => {
      sessionListener = listener;
      return () => {};
    },
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => { calls.abort++; },
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async (text: string) => { calls.prompts.push(text); },
    steer: async (text: string) => { calls.steers.push(text); },
  } as any;
  const manager = {
    getAgents: () => options.agents ?? [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    sendUserMessage: async (id: string, text: string) => { calls.childMessages.push({ id, text }); },
    abortAgent: async () => {},
    resendUndeliveredMainSettlements: async () => {},
  } as any;
  root.render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings}
      searchProviders={[]}
      subagentManager={manager}
      captureImage={options.captureImage}
      onExit={() => {
        calls.exit++;
        options.onExit?.();
      }}
    />,
  );
  await settle(setup);
  return { setup, calls, emit: (event: SessionEvent) => sessionListener?.(event) };
}

function pressCtrlC(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  setup.renderer.keyInput.processParsedKey({
    name: "c",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    sequence: "\u0003",
    number: false,
    raw: "\u0003",
    eventType: "press",
    source: "kitty",
  });
}

function promptLine(frame: string) {
  return frame.split("\n").find((line) => line.includes("❯ ")) ?? "";
}

describe("Ctrl+C prompt clearing", () => {
  test("finishes highlighting before renderer teardown", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await renderApp();
      await destroy?.();
      destroy = undefined;

      expect(warn.mock.calls.filter(([message]) => String(message).includes("Code highlighting failed"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("clears single-line text with one press", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.typeText("single-line draft");
    await settle(setup);

    pressCtrlC(setup);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("single-line draft");
    expect(frame).not.toContain("again to quit");
    expect(calls.exit).toBe(0);
  });

  test("clears multiline text with one press", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.typeText("first line");
    // Raw kitty Shift+Enter. pressKey("enter") types the literal word, which
    // leaves a single-line draft and no multiline case left to clear.
    setup.mockInput.pressKey("\x1b[13;2u");
    await setup.mockInput.typeText("second line");
    await settle(setup);
    const drafted = setup.captureCharFrame().split("\n");
    const firstRow = drafted.findIndex((row) => row.includes("first line"));
    const secondRow = drafted.findIndex((row, index) => index > firstRow && row.includes("second line"));
    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(secondRow).toBe(firstRow + 1);

    pressCtrlC(setup);
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("first line");
    expect(frame).not.toContain("second line");
    expect(frame).not.toContain("again to quit");
    expect(calls.exit).toBe(0);
  });

  test("clears only the selected subagent draft", async () => {
    const child = agent("child-1", "worker-one");
    const { setup, calls } = await renderApp({ agents: [child] });
    await setup.mockInput.typeText("main draft");
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await setup.mockInput.typeText("child draft");

    pressCtrlC(setup);
    await settle(setup);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    await setup.mockInput.typeText(" plus");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls.prompts).toEqual(["main draft plus"]);

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("child draft");
    expect(promptLine(setup.captureCharFrame())).toContain("Message worker-one");
  });

  test("inserts an image marker at the caret", async () => {
    testDir = mkdtempSync(join(tmpdir(), "pum-image-caret-test-"));
    const imagePath = join(testDir, "image.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { setup } = await renderApp({
      captureImage: async () => ({ path: imagePath, mimeType: "image/png" }),
    });

    await setup.mockInput.typeText("beforeafter");
    for (let index = 0; index < 5; index++) setup.mockInput.pressArrow("left");
    setup.mockInput.pressKey("v", { meta: true });
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("before[Image #1]after");
  });

  test("removes an attached image file", async () => {
    testDir = mkdtempSync(join(tmpdir(), "pum-ctrl-c-test-"));
    const imagePath = join(testDir, "image.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { setup } = await renderApp({
      captureImage: async () => ({ path: imagePath, mimeType: "image/png" }),
    });

    setup.mockInput.pressKey("v", { meta: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("[Image #1]");
    expect(existsSync(imagePath)).toBe(true);

    pressCtrlC(setup);
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("[Image #1]");
    expect(existsSync(imagePath)).toBe(false);
  });

  test("keeps empty-input double Ctrl+C quit behavior", async () => {
    const { setup, calls } = await renderApp();
    pressCtrlC(setup);
    await settle(setup);
    expect(calls.exit).toBe(0);

    pressCtrlC(setup);
    await settle(setup);
    expect(calls.exit).toBe(1);
  });

  test("does not treat rapid clear then Ctrl+C as a quit pair", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.typeText("clear me");
    pressCtrlC(setup);
    pressCtrlC(setup);
    await settle(setup);

    expect(calls.exit).toBe(0);

    pressCtrlC(setup);
    await settle(setup);
    expect(calls.exit).toBe(1);
  });

  test("dismisses busy slash suggestions and still cancels on the second Escape", async () => {
    const { setup, calls, emit } = await renderApp();
    emit({ type: "agent_start" });
    await setup.mockInput.typeText("/c");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("/compress");

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("/compress");
    expect(promptLine(setup.captureCharFrame())).toContain("/c");
    expect(calls.abort).toBe(0);

    setup.mockInput.pressEscape();
    await settle(setup);
    expect(calls.abort).toBe(1);
  });

  test("clears a steering draft without cancelling busy work", async () => {
    const { setup, calls, emit } = await renderApp();
    emit({ type: "agent_start" });
    await settle(setup);
    await setup.mockInput.typeText("steering draft");

    pressCtrlC(setup);
    await settle(setup);

    expect(setup.captureCharFrame()).not.toContain("steering draft");
    expect(calls.abort).toBe(0);
    expect(calls.exit).toBe(0);
    await setup.mockInput.typeText("replacement steer");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls.steers).toEqual(["replacement steer"]);
  });

  test("Ctrl+C closes Settings instead of arming application quit", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.typeText("preserved draft");
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);

    pressCtrlC(setup);
    await settle(setup);

    expect(setup.captureCharFrame()).not.toContain("Settings");
    expect(setup.captureCharFrame()).not.toContain("again to quit");
    expect(calls.exit).toBe(0);
  });

  test("does not clear the transcript draft while Settings owns focus", async () => {
    const { setup, calls } = await renderApp();
    await setup.mockInput.typeText("preserved draft");
    setup.mockInput.pressKey("p", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Settings");

    pressCtrlC(setup);
    await settle(setup);
    expect(calls.exit).toBe(0);
    setup.mockInput.pressEscape();
    await settle(setup);
    await setup.mockInput.typeText(" plus");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(calls.prompts).toEqual(["preserved draft plus"]);
  });
});

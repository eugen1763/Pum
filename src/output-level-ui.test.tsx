import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { AGENT_MESSAGE_CUSTOM_TYPE } from "./subagents/types";
import { normalizeSettings, type OutputMode } from "./settings";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

const entries = [
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      details: { source: "test" },
      isError: false,
    },
  },
  {
    type: "custom_message",
    customType: AGENT_MESSAGE_CUSTOM_TYPE,
    content: "worker update",
    details: {
      id: "message-1",
      sender: "worker",
      recipient: "main",
      text: "worker update",
      at: 1,
    },
  },
];

function fakeSession(source: unknown[] = entries) {
  return {
    agent: {
      state: {
        model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => source, getEntries: () => source },
    sessionFile: undefined,
    sessionId: "output-level-session",
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
  await new Promise((resolve) => setTimeout(resolve, 25));
  await setup.renderOnce();
  await setup.flush();
}

async function renderMode(
  mode: OutputMode,
  copyTranscriptText?: any,
  options: { entries?: unknown[]; height?: number } = {},
) {
  const setup = await createTestRenderer({
    width: 100,
    height: options.height ?? 50,
    kittyKeyboard: true,
  });
  destroy = () => setup.renderer.destroy();
  const session = fakeSession(options.entries);
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={normalizeSettings({ animations: false, workingRuleAnimation: "off", outputMode: mode })}
      searchProviders={[]}
      subagentManager={{
        getAgents: () => [],
        subscribe: () => () => {},
        bindMainSession: async () => {},
        setMaxActiveSubagents() {},
      } as any}
      copyTranscriptText={copyTranscriptText}
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

describe("output-level transcript UI", () => {
  test("Quiet groups routine tools and hides agent messages", async () => {
    const setup = await renderMode("quiet");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Read 1 file.");
    expect(frame).not.toContain("worker → main");
  });

  test("Normal keeps grouped activity and agent messages", async () => {
    const setup = await renderMode("normal");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Read 1 file.");
    expect(frame).toContain("worker → main");
  });

  test("Verbose shows individual raw tool results and agent messages", async () => {
    const setup = await renderMode("verbose");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("read(src/a.ts)");
    expect(frame).toContain("worker → main");
    expect(frame).toContain('"path": "src/a.ts"');
  });

  test("uses Vim-style transcript focus to expand and copy raw row data", async () => {
    let copied = "";
    const setup = await renderMode("quiet", async (text: string) => {
      copied = text;
      return "native" as const;
    });

    setup.mockInput.pressKey("y", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("transcript  j/k move");

    setup.mockInput.pressArrow("up");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("read(src/a.ts)");

    setup.mockInput.pressKey("c");
    await settle(setup);
    expect(copied).toContain('"path": "src/a.ts"');
    expect(copied).toContain("file contents");

    setup.mockInput.pressEscape();
    await settle(setup);
    await setup.mockInput.typeText("prompt focus restored");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("prompt focus restored");
  });

  test("selects and expands a row on click without treating a drag as a click", async () => {
    let copied = "";
    const setup = await renderMode("quiet", async (text: string) => {
      copied = text;
      return "native" as const;
    });
    const row = setup.renderer.root.findDescendantById("transcript-line-0");
    expect(row).toBeDefined();

    await setup.mockMouse.drag(row!.screenX + 3, row!.screenY, row!.screenX + 8, row!.screenY);
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("read(src/a.ts)");

    await setup.mockMouse.click(row!.screenX, row!.screenY);
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("read(src/a.ts)");
    expect(setup.captureCharFrame()).toContain("transcript  j/k move");

    setup.mockInput.pressKey("c");
    await settle(setup);
    expect(copied).toContain('\"path\": \"src/a.ts\"');
    expect(copied).toContain("file contents");
  });
});

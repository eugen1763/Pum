import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "../src/app";
import { AGENT_MESSAGE_CUSTOM_TYPE } from "../src/subagents/types";
import { normalizeSettings, type OutputMode } from "../src/settings";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

const thinkingEntry = {
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "weighing the options" }],
  },
};

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

const completionEntry = {
  type: "custom_message",
  customType: AGENT_MESSAGE_CUSTOM_TYPE,
  content: "Subagent finisher completed.",
  details: {
    id: "settlement-finisher-1",
    sender: "finisher",
    recipient: "main",
    text: "Subagent finisher completed.",
    at: 2,
    kind: "completion",
  },
};

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
  options: {
    entries?: unknown[];
    height?: number;
    showAgentMessages?: boolean;
    showThinking?: boolean;
  } = {},
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
      settings={normalizeSettings({
        animations: false,
        workingRuleAnimation: "off",
        outputMode: mode,
        ...(options.showAgentMessages === undefined
          ? {}
          : { showAgentMessages: options.showAgentMessages }),
        ...(options.showThinking === undefined ? {} : { showThinking: options.showThinking }),
      })}
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
  test("Quiet groups routine tools and keeps agent messages", async () => {
    // What one agent said to another is a separate question from tool detail,
    // so the mode no longer decides it.
    const setup = await renderMode("quiet");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Read 1 file.");
    expect(frame).toContain("worker → main");
  });

  test("resumed reasoning is kept and filtered at render, never dropped at load", async () => {
    // A subagent transcript has always worked this way. If the main transcript
    // dropped reasoning at load instead, turning the setting on would reveal a
    // resumed subagent's reasoning and never the main agent's.
    const withThinking = [...entries, thinkingEntry];
    const hidden = await renderMode("normal", undefined, { entries: withThinking });
    expect(hidden.captureCharFrame()).not.toContain("weighing the options");
    destroy?.();
    destroy = undefined;

    const shown = await renderMode("normal", undefined, {
      entries: withThinking,
      showThinking: true,
    });
    expect(shown.captureCharFrame()).toContain("weighing the options");
  });

  test("the agent-message setting hides conversation but keeps completion notices", async () => {
    for (const mode of ["quiet", "normal", "verbose"] as const) {
      const setup = await renderMode(mode, undefined, {
        entries: [...entries, completionEntry],
        showAgentMessages: false,
      });
      expect(setup.captureCharFrame()).not.toContain("worker → main");
      expect(setup.captureCharFrame()).toContain("finisher → main");
      destroy?.();
      destroy = undefined;
    }
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

  test("uses arrows for transcript details and returns printable letters to the prompt", async () => {
    let copied = "";
    const setup = await renderMode("quiet", async (text: string) => {
      copied = text;
      return "native" as const;
    });

    setup.mockInput.pressKey("y", { ctrl: true });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("transcript  ↑/↓ move");

    setup.mockInput.pressArrow("up");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("read(src/a.ts)");

    setup.mockInput.pressKey("c");
    await settle(setup);
    expect(copied).toBe("");
    expect(setup.captureCharFrame()).not.toContain("transcript  ↑/↓ move");

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
    expect(setup.captureCharFrame()).toContain("transcript  ↑/↓ move");

    // Mouse selections do not reserve printable transcript shortcuts.
    // Selection copying above remains separate from row-key handling.
    copied = "";
    await setup.mockInput.typeText("jkc/");
    await settle(setup);
    expect(copied).toBe("");
    expect(setup.captureCharFrame()).toContain("jkc/");
    expect(setup.captureCharFrame()).not.toContain("transcript  ↑/↓ move");
  });
});

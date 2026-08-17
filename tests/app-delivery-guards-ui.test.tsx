import { afterEach, describe, expect, test } from "bun:test";
import { TextareaRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { App } from "../src/app";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function focusedTextarea(root: BaseRenderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable && root.focused) return root;
  for (const child of root.getChildren()) {
    const found = focusedTextarea(child);
    if (found) return found;
  }
  return undefined;
}

function occurrences(frame: string, text: string): number {
  return frame.split(text).length - 1;
}

function fakeSession(imageInput = false) {
  return {
    sessionId: "main-session",
    agent: {
      state: {
        model: {
          id: "model",
          provider: "mock",
          input: imageInput ? ["text", "image"] : ["text"],
          contextWindow: 32_000,
        },
        thinkingLevel: "off",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: () => () => {}, setThinkingLevel() {}, setModel: async () => {},
    abort: async () => {}, compact: async () => ({ tokensBefore: 0 }), prompt: async () => {},
    steer: async () => {}, followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
  } as any;
}

function fakeChild(modelId: string) {
  return {
    id: "child", name: "worker", task: "Work", status: "running",
    worktree: { name: "worker", path: "/tmp/worker", branch: "pum/worker", baseBranch: "main", baseCommit: "abc" },
    parentAgentId: null, modelId, thinkingLevel: "off",
    transcript: { lines: [], stream: null, pending: [] },
    startedAt: 1, updatedAt: 1,
    usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: 0 },
  } as any;
}

const settings = {
  showThinking: false, theme: "tokyonight", animations: false,
  workingRuleAnimation: "off" as const, webSearch: false, writingStyle: "none" as const,
  explanationStrength: "simple" as const, checkMode: "off" as const,
  checkModel: "mock/check", maxActiveSubagents: 10,
};

const MODELS = [
  { id: "vision", provider: "mock", input: ["text", "image"], contextWindow: 32_000 },
  { id: "plain", provider: "mock", input: ["text"], contextWindow: 32_000 },
];

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce(); await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce(); await setup.flush();
}

async function render(options: {
  session: any;
  manager: any;
  captureImage?: () => Promise<{ path: string; mimeType: string }>;
  width?: number;
  height?: number;
}) {
  const setup = await createTestRenderer({
    width: options.width ?? 64,
    height: options.height ?? 20,
    kittyKeyboard: true,
  });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <App session={options.session} modelRuntime={{ getAvailableSnapshot: () => MODELS } as any}
      onNewSession={async () => options.session} loadSessions={async () => []}
      onSwitchSession={async () => options.session}
      settings={settings} searchProviders={[]} subagentManager={options.manager}
      {...(options.captureImage ? { captureImage: options.captureImage as any } : {})} />,
  );
  await settle(setup);
  return setup;
}

describe("main settlement rows", () => {
  test("keeps one row when a settlement delivery is retried", async () => {
    const listeners = new Set<(event: any) => void>();
    const manager = {
      getAgents: () => [],
      subscribe: (listener: (event: any) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      bindMainSession: async () => {}, abortAgent: async () => {}, persistToolEvent() {},
    } as any;
    const setup = await render({ session: fakeSession(), manager });
    const emit = (line: any) => {
      for (const listener of listeners) listener({ type: "main-line", line });
    };
    const settled = {
      kind: "agent-message", sender: "worker", recipient: "main",
      text: "worker finished", messageId: "settlement-completed-worker",
    };

    emit(settled);
    await settle(setup);
    // resendUndeliveredMainSettlements re-delivers the same stable settlement.
    emit({ ...settled });
    await settle(setup);
    emit({
      ...settled, sender: "scout", text: "scout finished",
      messageId: "settlement-completed-scout",
    });
    await settle(setup);

    const frame = setup.captureCharFrame();
    expect(occurrences(frame, "worker \u2192 main")).toBe(1);
    expect(occurrences(frame, "scout \u2192 main")).toBe(1);
  });
});

describe("clipboard image target model", () => {
  test("pastes when the selected agent's model accepts images and the main model does not", async () => {
    let captures = 0;
    const child = fakeChild("mock/vision");
    const manager = {
      getAgents: () => [child], subscribe: () => () => {},
      bindMainSession: async () => {}, abortAgent: async () => {}, persistToolEvent() {},
    } as any;
    const setup = await render({
      session: fakeSession(false),
      manager,
      captureImage: async () => {
        captures += 1;
        return { path: "/tmp/pum-test-image.png", mimeType: "image/png" };
      },
    });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressKey("v", { meta: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      await settle(setup);
      if (focusedTextarea(setup.renderer.root)?.plainText.includes("[Image #")) break;
    }

    expect(captures).toBe(1);
    expect(focusedTextarea(setup.renderer.root)?.plainText).toContain("[Image #");
    expect(setup.captureCharFrame()).not.toContain("does not support image input");
  });

  test("refuses when the selected agent's model rejects images and the main model accepts them", async () => {
    let captures = 0;
    const child = fakeChild("mock/plain");
    const manager = {
      getAgents: () => [child], subscribe: () => () => {},
      bindMainSession: async () => {}, abortAgent: async () => {}, persistToolEvent() {},
    } as any;
    const setup = await render({
      session: fakeSession(true),
      manager,
      captureImage: async () => {
        captures += 1;
        return { path: "/tmp/pum-test-image.png", mimeType: "image/png" };
      },
    });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressKey("v", { meta: true });
    await settle(setup);
    // The refusal reaches the main transcript, like every other paste error.
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);

    expect(captures).toBe(0);
    expect(setup.captureCharFrame()).toContain("does not support image input");
  });
});

describe("subagent cancellation errors", () => {
  test("reports a rejected abort in the transcript", async () => {
    const child = fakeChild("mock/plain");
    const manager = {
      getAgents: () => [child], subscribe: () => () => {},
      bindMainSession: async () => {}, persistToolEvent() {},
      abortAgent: async () => { throw new Error("abort failed: worktree busy"); },
    } as any;
    const setup = await render({ session: fakeSession(), manager, width: 72 });

    setup.mockInput.pressTab({ shift: true });
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressTab({ shift: true });
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("abort failed: worktree busy");
  });
});

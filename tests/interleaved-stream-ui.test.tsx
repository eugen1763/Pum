import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";

let destroy: (() => void) | undefined;
const temporaryDirectories: string[] = [];

afterEach(() => {
  destroy?.();
  destroy = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempSessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-stream-ui-"));
  temporaryDirectories.push(directory);
  return join(directory, "main-session.jsonl");
}

function fakeSession(sessionFile: string) {
  const listeners = new Set<(event: any) => void>();
  const session = {
    sessionId: "main-session",
    sessionFile,
    agent: {
      state: {
        model: { id: "model", provider: "mock", input: ["text"], contextWindow: 32_000 },
        thinkingLevel: "max",
      },
    },
    sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
    subscribe: (listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setThinkingLevel() {},
    setModel: async () => {},
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
  } as any;
  session.emit = (event: any) => {
    for (const listener of listeners) listener(event);
  };
  return session;
}

const baseSettings = {
  showThinking: false,
  theme: "tokyonight",
  animations: false,
  workingRuleAnimation: "off" as const,
  webSearch: false,
  writingStyle: "none" as const,
  explanationStrength: "simple" as const,
  checkMode: "off" as const,
  checkModel: "mock/check",
  maxActiveSubagents: 10,
};

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function render(showThinking: boolean) {
  const session = fakeSession(tempSessionFile());
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    abortAgent: async () => {},
    persistToolEvent() {},
    resendUndeliveredMainSettlements: async () => {},
  } as any;
  const setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={{ ...baseSettings, showThinking } as any}
      searchProviders={[]}
      subagentManager={manager}
    />,
  );
  await settle(setup);
  return Object.assign(setup, { session });
}

/**
 * One turn, exactly as a reasoning provider delivers it.
 *
 * The reasoning does not finish before the answer starts: its last part arrives
 * after the first words of the answer. Captured from a live `ds4-ops` turn.
 */
async function interleavedTurn(setup: Awaited<ReturnType<typeof render>>) {
  const deltas: [kind: "thinking" | "assistant", text: string][] = [
    ["thinking", "The user just said \"Hi\". This is a simple greeting."],
    ["thinking", " I should respond concisely. No need for tools. Keep it simple per STE writing"],
    ["assistant", "Hi! I"],
    ["thinking", " style."],
    ["assistant", " am ready to help with your project."],
  ];
  setup.session.emit({ type: "message_start", message: { role: "assistant" } });
  for (const [kind, delta] of deltas) {
    setup.session.emit({
      type: "message_update",
      assistantMessageEvent: { type: kind === "thinking" ? "thinking_delta" : "text_delta", delta },
    });
    await settle(setup);
  }
  setup.session.emit({ type: "message_end", message: { role: "assistant" } });
  setup.session.emit({ type: "agent_settled" });
  await settle(setup);
}

/** Painted rows with text on them: no chrome, no scrollbar column, no blanks. */
function rows(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.replace(/[█▀▄]+$/, "").trim())
    .filter((line) => line.length > 0 && !/^[─❯]/.test(line) && !line.startsWith("pum "));
}

/** Markdown paints asynchronously, so the answer arrives a few frames late. */
async function paintedRows(setup: Awaited<ReturnType<typeof render>>): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const painted = rows(setup.captureCharFrame());
    if (painted.some((row) => row.includes("ready to help"))) return painted;
    await settle(setup);
  }
  return rows(setup.captureCharFrame());
}

describe("a reasoning stream that interleaves with the answer", () => {
  test("keeps the answer in one row", async () => {
    const setup = await render(false);
    await interleavedTurn(setup);

    // The answer is one message, so it is one row. Committing the part that
    // arrived before the late reasoning would cut it in two, which reads as a
    // line break in the middle of the sentence.
    expect(await paintedRows(setup)).toContain("Hi! I am ready to help with your project.");
  });

  test("keeps the reasoning in one row", async () => {
    const setup = await render(true);
    await interleavedTurn(setup);

    const painted = await paintedRows(setup);
    expect(painted).toContain("Hi! I am ready to help with your project.");
    // The reasoning is one block as well, and its last words belong to it.
    expect(painted.filter((row) => row.includes("STE writing style.")).length).toBe(1);
    expect(painted.some((row) => row.trim() === "style.")).toBe(false);
  });
});

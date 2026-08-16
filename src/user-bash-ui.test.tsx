import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { App } from "./app";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function settings() {
  return {
    showThinking: false,
    theme: "tokyonight" as const,
    animations: false,
    workingRuleAnimation: "off" as const,
    webSearch: false,
    writingStyle: "none" as const,
    explanationStrength: "simple" as const,
    checkMode: "on" as const,
    checkModel: "mock/check",
    maxActiveSubagents: 10,
  };
}

async function renderShellApp(streaming = false) {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const commands: string[] = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const operations = { exec: async () => ({ exitCode: 0 }) } as any;
  const session = {
    agent: {
      state: {
        model: {
          id: "mock-model",
          provider: "mock",
          input: ["text"],
          contextWindow: 32_000,
        },
        thinkingLevel: "off",
      },
    },
    sessionManager: {
      buildContextEntries: () => [],
      getEntries: () => [],
    },
    sessionFile: undefined,
    sessionId: "main-session",
    isStreaming: streaming,
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async () => {},
    steer: async () => {},
    executeBash: async (command: string, onChunk: (chunk: string) => void, options: any) => {
      commands.push(command);
      expect(options.operations).toBe(operations);
      onChunk("shell output\n");
      return {
        output: "shell output\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      };
    },
    sendCustomMessage: async (message: any, options: any) => {
      customMessages.push({ message, options });
    },
  } as any;
  const manager = {
    getAgents: () => [],
    subscribe: () => () => {},
    bindMainSession: async () => {},
    resendUndeliveredMainSettlements: async () => {},
    persistToolEvent() {},
    createStandaloneWorktree: async () => ({
      name: "unused",
      path: process.cwd(),
      branch: "unused",
      baseBranch: "main",
      baseCommit: "abc",
    }),
  } as any;

  flushSync(() => createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={settings()}
      searchProviders={[]}
      subagentManager={manager}
      userBashOperations={operations}
    />,
  ));
  await setup.renderOnce();
  await setup.flush();
  return { setup, commands, customMessages };
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 1));
  flushSync();
  await setup.renderOnce();
  await setup.flush();
}

describe("user shell command mode", () => {
  test("removes the leading bang and executes a pasted multiline command", async () => {
    const { setup, commands, customMessages } = await renderShellApp();

    setup.mockInput.pressKey("!");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("! Ask something…");

    const command = "printf one \\\n  && printf two";
    await setup.mockInput.pasteBracketedText(command);
    setup.mockInput.pressKey("i", { meta: true });
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(commands).toEqual([command]);
    expect(customMessages).toHaveLength(1);
    expect(customMessages[0]!.options).toEqual({ triggerTurn: true });
    expect(setup.captureCharFrame()).toContain("bash(printf one \\)");

    setup.mockInput.pressBackspace();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ Ask something…");
  });

  test("shows and applies path suggestions", async () => {
    const { setup, commands } = await renderShellApp();
    setup.mockInput.pressKey("!");
    await setup.mockInput.typeText("cat src/user-bash.t");
    await settle(setup);

    expect(setup.captureCharFrame()).toContain("src/user-bash.ts");
    setup.mockInput.pressTab();
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(commands).toEqual(["cat src/user-bash.ts"]);
  });

  test("uses a steer message when the agent is already working", async () => {
    const { setup, customMessages } = await renderShellApp(true);
    setup.mockInput.pressKey("!");
    await setup.mockInput.typeText("printf ready");
    setup.mockInput.pressEnter();
    await settle(setup);

    expect(customMessages[0]!.options).toEqual({ deliverAs: "steer" });
  });

  test("Escape leaves an empty shell input", async () => {
    const { setup } = await renderShellApp();
    setup.mockInput.pressKey("!");
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("❯ Ask something…");
  });
});

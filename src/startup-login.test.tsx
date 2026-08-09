import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./app";

function session() {
  return {
    agent: { state: { model: { id: "unknown", provider: "unknown", input: ["text"], contextWindow: 1 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => [] }, sessionFile: undefined,
    subscribe: () => () => {}, setThinkingLevel() {}, setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }), abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }), prompt: async () => {}, steer: async () => {},
  } as any;
}

test("startup without an available provider renders the TUI and opens login", async () => {
  const setup = await createTestRenderer({ width: 70, height: 18 });
  const activeSession = session();
  createRoot(setup.renderer).render(
    <App
      session={activeSession}
      modelRuntime={{ getProviders: () => [], getAvailableSnapshot: () => [] } as any}
      onNewSession={async () => activeSession}
      loadSessions={async () => []}
      onSwitchSession={async () => activeSession}
      settings={{ showThinking: false, theme: "tokyonight", animations: false, workingRuleAnimation: "off", webSearch: false, writingStyle: "none", checkMode: false, checkModel: "mock/check" }}
      searchProviders={[]}
      subagentManager={{ getAgents: () => [], subscribe: () => () => {}, bindMainSession: async () => {} } as any}
      loginRequired
    />,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Login");
  expect(frame).toContain("Custom OpenAI-compatible provider");
  setup.renderer.destroy();
});

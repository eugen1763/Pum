import { describe, expect, test } from "bun:test";
import { renderTriggerTemplate, triggerTemplateValues } from "./template";
import type { ExternalTriggerEventData, TriggerSnapshot } from "./types";

const snapshot: TriggerSnapshot = {
  id: "trigger-1",
  name: "build",
  state: "waiting",
  target: { sessionId: "session-1", agentId: null, label: "main" },
  executable: "tool",
  args: [],
  mode: "once",
  restartDelayMs: null,
  createdAt: 1,
  nextRestartAt: null,
  fireCount: 1,
  maxFires: 1,
  pendingCount: 1,
  coalescedCount: 0,
  paused: false,
};

const event: ExternalTriggerEventData = {
  version: 1,
  triggerId: "trigger-1",
  name: "build",
  state: "waiting",
  target: snapshot.target,
  at: 2,
  fireCount: 1,
  pendingCount: 1,
  coalescedCount: 0,
  result: {
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    synthetic: false,
    manual: false,
    output: { path: "/private/out.log", bytes: 12, truncated: false, exists: true },
  },
};

describe("trigger templates", () => {
  test("substitutes only known literal fields and leaves unknown fields unchanged", () => {
    const values = triggerTemplateValues(snapshot, event);
    expect(renderTriggerTemplate("{{name}} {{outputPath}} {{unknown}}", values))
      .toBe("build /private/out.log {{unknown}}");
  });

  test("does not evaluate expression-like or shell-like template text", () => {
    const values = triggerTemplateValues(snapshot, event);
    expect(renderTriggerTemplate("{{constructor}} $({{name}}) {{name.toUpperCase}}", values))
      .toBe("{{constructor}} $(build) {{name.toUpperCase}}");
  });
});

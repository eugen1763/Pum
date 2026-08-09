import { describe, expect, test } from "bun:test";
import {
  renderTriggerTemplate,
  triggerTemplateValues,
  validateTriggerTemplate,
} from "./template";
import type { ExternalTriggerEventData, TriggerSnapshot } from "./types";

const snapshot: TriggerSnapshot = {
  id: "trigger-1",
  name: "build",
  state: "waiting",
  target: { sessionId: "session-1", agentId: null, label: "main" },
  executable: "tool",
  args: ["--check", "two words"],
  cwd: "/project",
  mode: "once",
  restartDelayMs: null,
  createdAt: 1,
  expiresAt: 86_400_001,
  nextRestartAt: null,
  fireCount: 1,
  maxFires: 10,
  pendingCount: 1,
  coalescedCount: 0,
  paused: false,
};

const result = {
  startedAt: 1,
  finishedAt: 2,
  durationMs: 1,
  exitCode: 0,
  signal: null,
  synthetic: false,
  manual: false,
  output: { path: "/private/out.log", bytes: 12, truncated: false, exists: true },
};

const event: ExternalTriggerEventData = {
  version: 1,
  triggerId: "trigger-1",
  name: "build",
  state: "waiting",
  target: snapshot.target,
  executable: snapshot.executable,
  args: snapshot.args,
  at: 2,
  fireCount: 1,
  pendingCount: 1,
  coalescedCount: 0,
  startedAt: 1,
  finishedAt: 2,
  durationMs: 1,
  exitCode: 0,
  signal: null,
  synthetic: false,
  manual: false,
  output: result.output,
  result,
};

describe("trigger templates", () => {
  test("substitutes the explicit literal field list", () => {
    const values = triggerTemplateValues(snapshot, event);
    expect(renderTriggerTemplate(
      "{{triggerName}} {{outputFile}} {{durationMs}} {{executable}} {{args}}",
      values,
    )).toBe('build /private/out.log 1 tool ["--check","two words"]');
  });

  test("rejects unknown, traversed, expression-like, and malformed placeholders", () => {
    for (const template of [
      "{{unknown}}",
      "{{trigger.name}}",
      "{{constructor}}",
      "{{triggerName.toUpperCase}}",
      "{{ triggerName }}",
      "{{triggerName}",
      "triggerName}}",
    ]) expect(() => validateTriggerTemplate(template)).toThrow();
  });

  test("does not evaluate shell text around valid placeholders", () => {
    const values = triggerTemplateValues(snapshot, event);
    expect(renderTriggerTemplate("$({{triggerName}}) `{{executable}}`", values))
      .toBe("$(build) `tool`");
  });
});

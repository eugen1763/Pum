import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindCheckModeApprovalSession, createCheckModeExtension, createExternalTriggerSafetyChecker,
  createSyntheticCheckCall, setCheckModeConfig,
} from "../src/check-mode";
import { RuntimeSettingsCoordinator } from "../src/runtime-settings";

const roots: string[] = [];
afterEach(() => {
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project() { const root = mkdtempSync(join(tmpdir(), "pum-policy-epoch-")); roots.push(root); return root; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function verifierGate() {
  const entered = deferred();
  const finish = deferred();
  const runtime = {
    getAvailableSnapshot: () => [{ provider: "test", id: "verifier" }],
    completeSimple: async () => {
      entered.resolve();
      await finish.promise;
      return { role: "assistant", content: [{ type: "text", text: "SAFE" }], stopReason: "stop" };
    },
  } as any;
  return { entered, finish, runtime };
}
function checkHook(runtime: any, cwd: string) {
  const handlers = new Map<string, Function>();
  (createCheckModeExtension(runtime) as any).factory({
    on: (event: string, handler: Function) => handlers.set(event, handler),
  });
  return (input: Record<string, unknown>, id = "call") => handlers.get("tool_call")!({
    toolName: "edit", toolCallId: id, input,
  }, { cwd, signal: new AbortController().signal, sessionManager: { buildContextEntries: () => [] } });
}

for (const synthetic of [false, true]) test(`pending verifier cannot approve after a root is removed (synthetic=${synthetic})`, async () => {
  const cwd = project(); const extra = project();
  setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [extra] });
  const gate = verifierGate();
  writeFileSync(join(extra, "package.json"), '{"name":"old"}');
  const input = { path: join(extra, "package.json"), edits: [{ oldText: "old", newText: "new" }] };
  const call = synthetic ? createSyntheticCheckCall(input) : { args: input, id: "ordinary" };
  const pending = checkHook(gate.runtime, cwd)(call.args, call.id);
  await gate.entered.promise;
  setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [] });
  gate.finish.resolve();
  expect(await pending).toMatchObject({ block: true });
  expect((await pending).reason).toContain("earlier approval is invalid");
});

test("unchanged effective config and pending desired relaxation do not invalidate SAFE", async () => {
  const cwd = project();
  const coordinator = new RuntimeSettingsCoordinator();
  const strict = { checkMode: "on" as const, checkModel: "test/verifier", sandboxMode: "off" as const, checkPaths: [], webSearch: false };
  coordinator.configure(strict, (value) => setCheckModeConfig({ profile: value.checkMode, model: value.checkModel, additionalPaths: value.checkPaths }));
  const settle = coordinator.begin("worker");
  const gate = verifierGate();
  writeFileSync(join(cwd, "package.json"), '{"name":"old"}');
  const pending = checkHook(gate.runtime, cwd)({ path: "package.json", edits: [{ oldText: "old", newText: "new" }] });
  await gate.entered.promise;
  setCheckModeConfig({ profile: "on", model: "test/verifier" });
  coordinator.request({ ...strict, checkMode: "off", webSearch: true });
  expect(coordinator.snapshot()?.pending).toBe(true);
  gate.finish.resolve();
  expect(await pending).toBeUndefined();
  settle();
  expect(coordinator.snapshot()?.pending).toBe(false);
});

test("structured trigger/shell checker rejects deterministic approval after concurrent revocation", async () => {
  const cwd = project(); const extra = project();
  setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [extra] });
  const check = createExternalTriggerSafetyChecker({ getAvailableSnapshot: () => [] } as any);
  const pending = check({ kind: "process", source: "external-trigger", operation: "start", executable: "printf", args: ["x"], cwd }, { kind: "main", sessionId: "test", cwd });
  setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [] });
  await expect(pending).rejects.toThrow("earlier approval is invalid");
});

function approvalFixture(before: Function = async () => undefined) {
  const executed: string[] = [];
  const tools = ["bash", "read"].map((name) => ({ name, execute: async (id: string, _args: object) => {
    executed.push(id); return { content: [{ type: "text", text: "executed" }], details: {} };
  } }));
  let listener: (event: any) => void = () => {};
  const session = { agent: { beforeToolCall: before, state: { tools } }, subscribe: (fn: typeof listener) => { listener = fn; return () => {}; }, dispose() {} } as any;
  bindCheckModeApprovalSession(session);
  const prepare = (id: string, name = "bash", args: object = {}) => session.agent.beforeToolCall({
    toolCall: { id, name, arguments: args }, args, context: { tools, messages: [] },
  }, new AbortController().signal);
  return { session, prepare, tools, executed, emit: (event: any) => listener(event) };
}

test("Check off-to-on during the full asynchronous preflight chain blocks before native-off execution", async () => {
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  const gate = deferred();
  const fixture = approvalFixture(async () => { await gate.promise; });
  const pending = fixture.prepare("off-call");
  setCheckModeConfig({ profile: "on", model: "test/verifier" });
  gate.resolve();
  expect(await pending).toMatchObject({ block: true });
  expect(fixture.executed).toEqual([]);
});

test("parallel preparation cannot execute an earlier prepared call after a sibling waits across tightening", async () => {
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
  const gate = deferred();
  const fixture = approvalFixture(async (event: any) => { if (event.toolCall.id === "later") await gate.promise; });
  const args = {};
  expect(await fixture.prepare("earlier", "bash", args)).toBeUndefined();
  const later = fixture.prepare("later", "read");
  setCheckModeConfig({ profile: "on", model: "test/verifier" });
  gate.resolve();
  expect(await later).toMatchObject({ block: true });
  await expect(fixture.tools[0]!.execute("earlier", args)).rejects.toThrow("earlier approval is invalid");
  expect(fixture.executed).toEqual([]);
});

test("synthetic validation execute entry is invalidated after its preflight returned", async () => {
  setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: ["/extra"] });
  const fixture = approvalFixture();
  const call = createSyntheticCheckCall({ command: "printf x" });
  expect(await fixture.prepare(call.id, "bash", call.args)).toBeUndefined();
  setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [] });
  await expect(fixture.tools[0]!.execute(call.id, call.args)).rejects.toThrow("earlier approval is invalid");
  expect(fixture.executed).toEqual([]);
});

test("synthetic validation preserves exact checked args and consumes authority once", async () => {
  const fixture = approvalFixture();
  const call = createSyntheticCheckCall({ command: "printf x" });
  expect(await fixture.prepare(call.id, "bash", call.args)).toBeUndefined();
  await fixture.tools[0]!.execute(call.id, call.args);
  await expect(fixture.tools[0]!.execute(call.id, call.args)).rejects.toThrow("no matching preflight approval");
  expect(fixture.executed).toEqual([call.id]);
});

test("copied args, wrong tool and mismatched ID never transfer prepared authority", async () => {
  const fixture = approvalFixture();
  const args = { command: "printf x" };
  await fixture.prepare("same", "bash", args);
  await expect(fixture.tools[0]!.execute("same", { ...args })).rejects.toThrow("no matching preflight approval");
  await expect(fixture.tools[1]!.execute("same", args)).rejects.toThrow("no matching preflight approval");
  await expect(fixture.tools[0]!.execute("different", args)).rejects.toThrow("no matching preflight approval");
  // Even a mismatched execution attempt consumes that exact record.
  await expect(fixture.tools[0]!.execute("same", args)).rejects.toThrow("no matching preflight approval");
  expect(fixture.executed).toEqual([]);
});

for (const edge of ["agent_end", "agent_settled", "dispose"]) test(`${edge} clears abandoned approval and blocks late preflight`, async () => {
  const gate = deferred();
  const fixture = approvalFixture(async (event: any) => { if (event.toolCall.id === "pending") await gate.promise; });
  const args = {};
  await fixture.prepare("abandoned", "bash", args);
  const pending = fixture.prepare("pending");
  if (edge === "dispose") fixture.session.dispose();
  else fixture.emit({ type: edge });
  gate.resolve();
  expect(await pending).toMatchObject({ block: true });
  await expect(fixture.tools[0]!.execute("abandoned", args)).rejects.toThrow(edge === "dispose" ? "earlier approval is invalid" : "no matching preflight approval");
  expect(fixture.executed).toEqual([]);
  if (edge !== "dispose") {
    await fixture.prepare("abandoned", "bash", args);
    await fixture.tools[0]!.execute("abandoned", args);
    expect(fixture.executed).toEqual(["abandoned"]);
  }
});

test("duplicate result IDs cannot delete an unexecuted sibling's approval", async () => {
  const fixture = approvalFixture();
  const args = {};
  await fixture.prepare("same", "bash", args);
  fixture.emit({ type: "message_end", message: { role: "toolResult", toolCallId: "same" } });
  await fixture.tools[0]!.execute("same", args);
  expect(fixture.executed).toEqual(["same"]);
});

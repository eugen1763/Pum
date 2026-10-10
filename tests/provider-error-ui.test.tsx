import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseColor } from "@opentui/core";
import { loadTheme } from "../src/theme";
import { createRoot, flushSync } from "@opentui/react";
import { App } from "../src/app";
import { replayEntries } from "../src/replay";
import { providerErrorLine, settleAssistantTranscript } from "../src/provider-error";
import { settleSyntaxHighlighting } from "../src/syntax";
import { SubagentManager } from "../src/subagents/manager";
import type { PendingTranscriptState } from "../src/transcript";

let destroy: (() => Promise<void>) | undefined;
afterEach(async () => { await destroy?.(); destroy = undefined; });

const failure = (errorMessage = "400 tools.3.custom: unsupported maxItems", content: any[] = []) => ({
  role: "assistant", stopReason: "error", errorMessage, content,
});
const settings = {
  showThinking: true, theme: "tokyonight", animations: false, workingRuleAnimation: "off",
  webSearch: false, writingStyle: "none", explanationStrength: "simple", checkMode: "off",
  checkModel: "mock/check", sandboxMode: "off", maxActiveSubagents: 10,
} as any;

async function paint(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  flushSync();
  await setup.renderOnce();
  await setup.flush();
  // React's scheduled mount/effects must run before capturing a screen.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settleSyntaxHighlighting(setup.renderer.root);
  await setup.renderer.idle();
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await settleSyntaxHighlighting(setup.renderer.root);
  await setup.renderer.idle();
  await setup.renderOnce();
  await setup.flush();
  return setup.captureCharFrame();
}

async function render(entries: any[] = [], child = false) {
  const listeners = new Set<(event: any) => void>();
  const session = {
    sessionId: "mock-main", sessionFile: undefined,
    agent: { state: { model: { id: "mock-model", provider: "mock", input: ["text"], contextWindow: 32000 }, thinkingLevel: "off" } },
    sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
    subscribe: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setThinkingLevel() {}, setModel: async () => {}, abort: async () => {}, prompt: async () => {}, steer: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }), getSteeringMessages: () => [], getFollowUpMessages: () => [],
  } as any;
  const actualManager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-provider-error-test-unused" });
  const record = {
    snapshot: {
      id: "worker", name: "worker", task: "mock provider", status: "running", parentAgentId: null,
      modelId: "mock/mock-model", thinkingLevel: "off", startedAt: 1, updatedAt: 1,
      worktree: { name: "worker", path: process.cwd(), branch: "pum/mock", baseBranch: "main", baseCommit: "mock" },
      transcript: { lines: [], stream: null, pending: [] } as PendingTranscriptState,
      usage: { outgoing: 0, incoming: 0, cacheRead: 0, cost: 0, contextPct: null },
    }, activityGeneration: 0, idleNotifiedGeneration: 0,
  };
  if (child) (actualManager as any).records.set("worker", record);
  // Use the real child event reducer and subscription, without starting an SDK,
  // touching config/session files or delivering any lifecycle prompts.
  const manager = {
    getAgents: () => actualManager.getAgents(), subscribe: (listener: any) => actualManager.subscribe(listener),
    bindMainSession: async () => {}, abortAgent: async () => {}, persistToolEvent() {},
    resendUndeliveredMainSettlements: async () => {},
  } as any;
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const root = createRoot(setup.renderer);
  destroy = async () => {
    await settleSyntaxHighlighting(setup.renderer.root);
    root.unmount(); await setup.flush(); await setup.renderer.idle(); setup.renderer.destroy();
  };
  root.render(<App session={session} modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
    onNewSession={async () => session} loadSessions={async () => []} onSwitchSession={async () => session}
    settings={settings} searchProviders={[]} subagentManager={manager} />);
  await paint(setup);
  if (child) { setup.mockInput.pressTab({ shift: true }); await paint(setup); }
  return Object.assign(setup, {
    emit: (event: any) => {
      if (child) (actualManager as any).processSessionEvent(record, event);
      else for (const listener of listeners) listener(event);
    }, record,
  });
}

const countErrors = (frame: string) => frame.split("Provider error:").length - 1;

const schemaError = "400 tools.3.custom: unsupported maxItems";
const basicCredential = "dXNlcjpwYXNzd29yZA==";
const digestCredential = 'Digest username="private-user", realm="private,realm", nonce="private-nonce", uri="/private-path", response="private-response", cnonce="private-cnonce"';
const authorizationCases = [
  { name: "Basic", raw: `401 Authorization: Basic ${basicCredential}; ${schemaError}`, secrets: [basicCredential] },
  { name: "comma-containing Digest", raw: `401 Authorization: ${digestCredential}; ${schemaError}`, secrets: ["private-user", "private,realm", "private-nonce", "/private-path", "private-response", "private-cnonce"] },
  { name: "quoted JSON Digest", raw: JSON.stringify({ "Authorization": digestCredential, error: schemaError }), secrets: ["private-user", "private,realm", "private-nonce", "/private-path", "private-response", "private-cnonce"] },
  { name: "normalized marker and split Basic credential", raw: `401 Auth\x1b[31morization\x1b[0m:\tBa\x00sic ${basicCredential.slice(0, 8)}\n\t${basicCredential.slice(8)}; ${schemaError}`, secrets: [basicCredential.slice(0, 8), basicCredential.slice(8)] },
  { name: "quoted Basic value and header name", raw: `'Authorization' = 'Basic ${basicCredential}'; ${schemaError}`, secrets: [basicCredential] },
  { name: "case-insensitive Proxy-Authorization", raw: `401 pRoXy-AuThOrIzAtIoN:\tDigest username = 'proxy-user', response = 'proxy-password'; ${schemaError}`, secrets: ["proxy-user", "proxy-password"] },
  { name: "quoted JSON Basic", raw: JSON.stringify({ "Proxy-Authorization": `Basic ${basicCredential}`, error: schemaError }), secrets: [basicCredential] },
  { name: "Bearer whitespace", raw: `Authorization : Bearer\tprivate-bearer\n\tprivate-continuation; ${schemaError}`, secrets: ["private-bearer", "private-continuation"] },
  { name: "other scheme with semicolon parameters", raw: `Authorization: AWS4-HMAC-SHA256 Credential=private-credential, SignedHeaders=host;private-header;x-amz-date, Signature=private-signature; ${schemaError}`, secrets: ["private-credential", "private-header", "private-signature"] },
  { name: "quoted scheme alone does not end the value", raw: `Authorization: 'Basic' ${basicCredential}; ${schemaError}`, secrets: [basicCredential] },
];

function expectSafeAuthorization(text: string, secrets: string[]) {
  expect(text).toContain("[redacted]");
  expect(text).toContain(schemaError);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toContain("\x1b");
}

for (const child of [false, true]) describe(`${child ? "child" : "main"} provider failures`, () => {
  test("renders an empty-content HTTP failure once, only on final message", async () => {
    const setup = await render([], child);
    const message = failure();
    setup.emit({ type: "agent_start" });
    setup.emit({ type: "message_start", message: { role: "assistant" } });
    setup.emit({ type: "message_update", assistantMessageEvent: { type: "error", error: message } });
    expect(countErrors(await paint(setup))).toBe(0);
    setup.emit({ type: "message_end", message });
    const frame = await paint(setup);
    expect(frame).toContain("Provider error: 400 tools.3.custom: unsupported maxItems");
    expect(countErrors(frame)).toBe(1);
    const errorSpan = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Provider error:"));
    expect(errorSpan?.fg.equals(parseColor(loadTheme("tokyonight").error))).toBe(true);
    expect(frame).toContain("send to steer");
    setup.emit({ type: "agent_end", messages: [message] });
    expect(await paint(setup)).toContain("send to steer");
    setup.emit({ type: "agent_settled" });
    expect(countErrors(await paint(setup))).toBe(1);
  });

  test("renders fully redacted Basic, Digest and normalized authorization failures", async () => {
    const setup = await render([], child);
    for (const fixture of authorizationCases.slice(0, 4)) {
      const message = failure(fixture.raw);
      setup.emit({ type: "message_end", message });
      // Display sanitization must never rewrite the provider's durable message.
      expect(message.errorMessage).toBe(fixture.raw);
    }
    const frame = await paint(setup);
    expect(countErrors(frame)).toBe(4);
    for (const fixture of authorizationCases.slice(0, 4)) expectSafeAuthorization(frame, fixture.secrets);
  });

  test("keeps partial answer and interleaved reasoning before the failure", async () => {
    const setup = await render([], child);
    setup.emit({ type: "message_start", message: { role: "assistant" } });
    for (const [type, delta] of [["thinking_delta", "Reasoning"], ["text_delta", "Partial answer"], ["thinking_delta", " continued"]]) {
      setup.emit({ type: "message_update", assistantMessageEvent: { type, delta } });
    }
    setup.emit({ type: "message_end", message: failure("Connection lost") });
    const frame = await paint(setup);
    expect(frame).toContain("Reasoning continued");
    expect(frame).toContain("Partial answer");
    expect(frame.indexOf("Reasoning continued")).toBeLessThan(frame.indexOf("Partial answer"));
    expect(frame.indexOf("Partial answer")).toBeLessThan(frame.indexOf("Provider error: Connection lost"));
    expect(countErrors(frame)).toBe(1);
  });

  test("retry recovery retains attempt history without duplicate or false final failure", async () => {
    const setup = await render([], child);
    setup.emit({ type: "agent_start" });
    setup.emit({ type: "message_end", message: failure("503 temporarily unavailable") });
    setup.emit({ type: "agent_end", willRetry: true });
    setup.emit({ type: "auto_retry_start", attempt: 1, errorMessage: "503 temporarily unavailable" });
    expect(await paint(setup)).toContain("send to steer");
    setup.emit({ type: "agent_start" });
    setup.emit({ type: "message_start", message: { role: "assistant" } });
    setup.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Recovered answer" } });
    setup.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" } });
    setup.emit({ type: "auto_retry_end", success: true });
    setup.emit({ type: "agent_settled" });
    const frame = await paint(setup);
    expect(frame).toContain("Recovered answer");
    expect(countErrors(frame)).toBe(1);
    expect(frame).not.toContain("send to steer");
    if (child) {
      expect(setup.record.snapshot.status).toBe("idle");
      expect(setup.record.snapshot.transcript.lines).toEqual(replayEntries([
        { type: "message", message: failure("503 temporarily unavailable") },
        { type: "context_edit", targetId: "failed", replacement: null },
        { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered answer" }] } },
      ], process.cwd(), true));
    }
  });

  test("retry exhaustion shows each genuine failure once", async () => {
    const setup = await render([], child);
    setup.emit({ type: "agent_start" });
    setup.emit({ type: "message_end", message: failure("503 first attempt") });
    setup.emit({ type: "auto_retry_start", attempt: 1 });
    setup.emit({ type: "agent_end", willRetry: true });
    setup.emit({ type: "agent_start" });
    setup.emit({ type: "message_end", message: failure("503 final attempt") });
    setup.emit({ type: "auto_retry_end", success: false, finalError: "503 final attempt" });
    setup.emit({ type: "agent_settled" });
    const frame = await paint(setup);
    expect(frame).toContain("Provider error: 503 final attempt");
    expect(countErrors(frame)).toBe(2);
  });

  test("successful responses and cancelled requests are not provider failures", async () => {
    const setup = await render([], child);
    setup.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Successful answer" } });
    setup.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", errorMessage: "irrelevant" } });
    setup.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Request aborted" } });
    const frame = await paint(setup);
    expect(frame).toContain("Successful answer");
    expect(countErrors(frame)).toBe(0);
    expect(frame).not.toContain("Request aborted");
  });
});

describe("resumed provider failures and safe display", () => {
  for (const fixture of authorizationCases) test(`redacts full ${fixture.name} header value`, () => {
    const message = failure(fixture.raw);
    const line = providerErrorLine(message);
    expect(line?.kind).toBe("text");
    expectSafeAuthorization(line?.kind === "text" ? line.text : "", fixture.secrets);
    expect(message.errorMessage).toBe(fixture.raw);
  });

  test("ambiguous authorization values consume all tokens, including malformed quotes", () => {
    for (const raw of [
      `401 Authorization: Basic ${basicCredential}`,
      `401 Authorization: Basic ${basicCredential.slice(0, 8)}\n${basicCredential.slice(8)}`,
      `401 Authorization: Digest username="private-user", response="private-password`,
      `401 Authorization: Custom private-first; private-second, private-third`,
      `401 Authorization: Custom private-first}private-second]private-third`,
    ]) {
      expect(providerErrorLine(failure(raw))).toEqual({ kind: "text", role: "error", text: "Provider error: 401 Authorization: [redacted]" });
    }
  });

  test("redacts quoted authorization values on resume without rewriting entries", async () => {
    const fixture = authorizationCases[2]!;
    const entries = [{ type: "message", message: failure(fixture.raw) }];
    const before = JSON.stringify(entries);
    const setup = await render(entries);
    expectSafeAuthorization(await paint(setup), fixture.secrets);
    expect(JSON.stringify(entries)).toBe(before);
  });
  test("renders failed messages after retained content, without mutating durable entries", async () => {
    const entries = [
      { type: "message", message: failure("400 unsupported maxItems", [{ type: "thinking", thinking: "Retained reasoning" }, { type: "text", text: "Retained answer" }]) },
      { type: "message", message: failure() },
      { type: "message", message: { role: "assistant", stopReason: "aborted", errorMessage: "Cancelled", content: [] } },
    ];
    const before = JSON.stringify(entries);
    const setup = await render(entries);
    const frame = await paint(setup);
    expect(frame).toContain("Retained reasoning");
    expect(frame).toContain("Retained answer");
    expect(frame.indexOf("Retained answer")).toBeLessThan(frame.indexOf("Provider error:"));
    expect(countErrors(frame)).toBe(2);
    expect(frame).not.toContain("Cancelled");
    expect(JSON.stringify(entries)).toBe(before);
    expect(replayEntries([{ role: "assistant", stopReason: "error" }], process.cwd(), false)).toEqual([providerErrorLine({ role: "assistant", stopReason: "error" })!]);
  });

  test("redacts credentials, OAuth URLs and terminal escapes while retaining schema details", async () => {
    const error = '400 tools.3.custom unsupported maxItems; sk-ant-test-credential123 sk-\u001b[31mant-other-credential456 Authorization: Bearer private123 api_key="private456" {"refresh_token":"private789"} https://oauth.example/authorize?code=private-code \x1b[31mred\x1b[0m';
    const setup = await render([{ type: "message", message: failure(error) }]);
    const frame = await paint(setup);
    expect(frame).toContain("400 tools.3.custom unsupported maxItems");
    for (const secret of ["sk-ant-test", "credential456", "private123", "private456", "private789", "oauth.example", "private-code"]) expect(frame).not.toContain(secret);
    const line = providerErrorLine(failure(error));
    expect(line?.kind === "text" && line.text).not.toContain("\x1b");
  });

  test("redacts complete escaped quoted credential fields in helper and rendered display", async () => {
    const raw = JSON.stringify({ error: schemaError, password: 'private"credential-tail', api_key: 'private\\"other-tail', refresh_token: "private\nmultiline-tail" });
    const secrets = ["private", "credential-tail", "other-tail", "multiline-tail"];
    const line = providerErrorLine(failure(raw));
    expectSafeAuthorization(line?.kind === "text" ? line.text : "", secrets);
    const entries = [{ type: "message", message: failure(raw) }];
    const before = JSON.stringify(entries);
    const setup = await render(entries);
    expectSafeAuthorization(await paint(setup), secrets);
    expect(JSON.stringify(entries)).toBe(before);
  });

  test("redacts malformed and single-quoted escaped credential fields completely", () => {
    for (const raw of [
      `${schemaError}; password='private\\'credential-tail'`,
      `${schemaError}; password="private\\"credential-tail`,
      `${schemaError}; api_key="private\\`,
    ]) {
      const line = providerErrorLine(failure(raw));
      expectSafeAuthorization(line?.kind === "text" ? line.text : "", ["private", "credential-tail"]);
    }
  });

  test("failure follows partial output but precedes deferred delivered messages", () => {
    const result = settleAssistantTranscript<PendingTranscriptState>({ lines: [], stream: { kind: "assistant" as const, text: "Partial" }, pending: [
      { id: "queued", delivered: true, line: { kind: "text" as const, role: "user" as const, text: "Steer" } },
    ] }, failure());
    expect(result.lines.map((line) => line.kind === "text" ? line.role : "other")).toEqual(["assistant", "error", "user"]);
    expect(result.stream).toBeNull();
    expect(result.pending).toEqual([]);
  });
});

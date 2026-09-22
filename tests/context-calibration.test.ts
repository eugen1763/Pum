import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { ContextWindowController } from "../src/context-window";
import { contextCalibration, contextUsage, estimateContextMessage, estimateContextText } from "../src/context-estimate";

const model = (id = "one", contextWindow = 100_000) => ({ id, name: id, provider: "test", api: "openai-completions", baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as any;
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const usage = (input = 3000, output = 100) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output });
const tool = (description: string) => ({ name: "fixture", description, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }) as any;

// Public Agent stream/message_end events pair each sample with its real request.
// Like AgentSession, messages persist at message_end, each request is built from
// the session projection, and the prompt lives in transcript system messages.
function harness(options: { systemPrompt?: string; injection?: string; tools?: any[] } = {}) {
  let injection = options.injection ?? "";
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "system", content: options.systemPrompt ?? "s".repeat(3600), timestamp: 0 });
  const controller = new ContextWindowController();
  const tools = new Map<string, any>();
  const extension = controller.extension();
  if (typeof extension === "function") throw new Error("Expected named inline extension");
  extension.factory({ on: () => {}, registerTool: (definition: any) => tools.set(definition.name, definition) } as unknown as ExtensionAPI);
  let requestEstimate = 0;
  const agent = new Agent({
    initialState: { model: model(), messages: manager.buildSessionProjection().messages, tools: options.tools ?? [] },
    transformContext: async (messages) => injection ? [...messages, user(injection)] : messages,
    streamFn: (() => { throw new Error("No configured response"); }) as any,
  });
  const sync = () => { agent.state.messages = manager.buildSessionProjection().messages; };
  agent.prepareRequest = async (request) => ({ context: { ...request.context, messages: manager.buildSessionProjection().messages } });
  agent.subscribe((event) => {
    if (event.type === "message_end" && ["system", "user", "assistant", "toolResult"].includes(event.message.role)) manager.appendMessage(event.message as any);
  });
  const session = { agent, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { reserveTokens: 1000 } }),
    get model() { return agent.state.model; }, async compact() {} } as unknown as AgentSession;
  controller.bind(session);
  const meter = async () => (await tools.get("get_context_remaining").execute("meter", {})).details;
  const respond = async (sample: Record<string, unknown> | ((estimated: number) => Record<string, unknown>) = usage(), overrides: Record<string, unknown> = {}) => {
    agent.streamFunction = (_model, context) => {
      const requestTools = getCurrentTools(context.messages);
      requestEstimate = estimateContextText(getCurrentSystemPrompt(context.messages))
        + estimateContextText(JSON.stringify(requestTools.map(({ name, description, parameters }) => ({ name, description, parameters }))))
        + requestTools.length * 32 // Conservative per-definition provider framing.
        + context.messages.filter((message) => message.role !== "system")
          .reduce((sum, message) => sum + estimateContextMessage(message as AgentMessage), 0);
      const message = { role: "assistant", api: "openai-completions", provider: "test", model: agent.state.model.id,
        content: [{ type: "text", text: "Answer" }], timestamp: 2, stopReason: "stop",
        usage: typeof sample === "function" ? sample(requestEstimate) : sample, ...overrides } as any;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    await agent.prompt("Meter request");
    sync();
    return requestEstimate;
  };
  const append = (...messages: AgentMessage[]) => { for (const message of messages) manager.appendMessage(message as any); sync(); };
  const setPrompt = (text: string) => append({ role: "system", content: "", sections: { harness: text }, timestamp: 0 } as AgentMessage);
  /** Persisted conversation messages, which the next request contains. */
  const persisted = () => manager.buildSessionProjection().messages.filter((message) => message.role !== "system");
  return { agent, manager, meter, respond, append, setPrompt, persisted, setInjection: (text: string) => { injection = text; } };
}

describe("conservative context estimate helpers", () => {
  test("UTF-8 thirds round upward, with fixed message framing and image cost independent of bytes", () => {
    for (const text of ["", "a", "ab", "abc", "abcd", "é", "界", "😀", "e\u0301", "👩‍💻".repeat(1000)]) {
      expect(estimateContextText(text)).toBe(Math.ceil(Buffer.byteLength(text, "utf8") / 3));
      expect(estimateContextMessage(user(text))).toBe(16 + Math.ceil(Buffer.byteLength(text, "utf8") / 3));
    }
    for (const data of ["", "YQ==", "x".repeat(100_000)]) {
      const parts = [{ type: "image", mimeType: "image/png", data }, { type: "text", text: "界" }, { type: "image", mimeType: "image/jpeg", data }];
      for (const role of ["user", "toolResult", "custom"])
        expect(estimateContextMessage({ role, content: parts } as any)).toBe(16 + 2400 + 1);
    }
    expect(estimateContextMessage({ role: "assistant", content: [{ type: "thinking", thinking: "界" }, { type: "toolCall", name: "read", arguments: { path: "界" } }] } as any))
      .toBe(16 + 1 + estimateContextText('read{"path":"界"}'));
    expect(estimateContextMessage({ role: "bashExecution", command: "界", output: "😀" } as any)).toBe(19);
    for (const role of ["branchSummary", "compactionSummary"])
      expect(estimateContextMessage({ role, summary: "😀" } as any)).toBe(18);
  });

  test("training uses a >=1024-token request and upward-only factor bounded at two", () => {
    expect(contextCalibration(9999, 1023)).toEqual({ factor: 1, limited: false, eligible: false });
    expect(contextCalibration(1024, 1024)).toEqual({ factor: 1, limited: false, eligible: true });
    expect(contextCalibration(512, 1024)).toEqual({ factor: 1, limited: false, eligible: true });
    expect(contextCalibration(1536, 1024)).toEqual({ factor: 1.5, limited: false, eligible: true });
    expect(contextCalibration(2048, 1024)).toEqual({ factor: 2, limited: false, eligible: true });
    expect(contextCalibration(2049, 1024)).toEqual({ factor: 2, limited: true, eligible: true });
    for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(contextCalibration(invalid, 1024)).toEqual({ factor: 1, limited: false, eligible: false });
      expect(contextCalibration(2048, invalid)).toEqual({ factor: 1, limited: false, eligible: false });
    }
  });

  test("components and larger totals anchor conservatively, but inconsistent total cannot train", () => {
    expect(contextUsage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 1 })).toEqual({ total: 190, input: 170 });
    expect(contextUsage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 9000 })).toEqual({ total: 9000, input: 0 });
  });
});

describe("runtime-paired calibration", () => {
  test("invalid, all-zero, total-only and unsafe counts cannot anchor even a paired response", async () => {
    const invalid: unknown[] = [null, [], {}, { totalTokens: 5000 }, usage(0, 0), usage(0, 100)];
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
      for (const value of [-1, 0.5, NaN, Infinity, -Infinity, "3000", Number.MAX_SAFE_INTEGER + 1])
        invalid.push({ ...usage(), [field]: value });
    invalid.push({ ...usage(), input: Number.MAX_SAFE_INTEGER, output: 1, totalTokens: Number.MAX_SAFE_INTEGER });
    for (const sample of invalid) {
      expect(contextUsage(sample)).toBeUndefined();
      const h = harness();
      await h.respond(sample as any);
      const meter = await h.meter();
      expect(meter.source).toBe("estimate");
      expect(meter.providerUsageTokens).toBe(0);
      expect(meter.calibrationFactor).toBe(1);
      expect(meter.calibrationEligible).toBe(false);
    }
  });

  test("prompt input includes caches, not output, and never multiplies the measured anchor", async () => {
    const h = harness({ tools: [tool("schema".repeat(200))], injection: "injection".repeat(200) });
    const estimated = await h.respond((n) => ({ input: n, cacheRead: n, cacheWrite: n, output: n * 10, totalTokens: n * 13 }));
    const meter = await h.meter();
    expect(estimated).toBeGreaterThanOrEqual(1024);
    expect(meter.calibrationFactor).toBe(2);
    expect(meter.calibrationEligible).toBe(true);
    expect(meter.calibrationLimited).toBe(true);
    expect(meter.providerUsageTokens).toBe(estimated * 13);
    expect(meter.usedTokens).toBe(estimated * 13);
    expect(meter.uncalibratedTrailingTokens).toBe(0);
    expect(meter.uncalibratedOverheadTokens).toBe(0);
  });

  test("large output never trains a prompt-input multiplier", async () => {
    const h = harness();
    const estimated = await h.respond((n) => usage(Math.floor(n / 2), n * 10));
    const meter = await h.meter();
    expect(meter.usedTokens).toBe(Math.floor(estimated / 2) + estimated * 10);
    expect(meter.calibrationFactor).toBe(1);
    expect(meter.calibrationEligible).toBe(true);
    expect(meter.calibrationLimited).toBe(false);
  });

  test("restored or cloned usage has no runtime request pairing", async () => {
    const first = harness();
    await first.respond();
    const restored = harness();
    restored.append(...structuredClone(first.persisted()));
    expect((await restored.meter()).providerUsageTokens).toBe(0);
    // An equal content replacement makes the projection return a copied message.
    const answer = first.manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    if (answer.type !== "message" || answer.message.role !== "assistant") throw new Error("Missing answer");
    expect((await first.meter()).providerUsageTokens).toBeGreaterThan(0);
    first.manager.appendContextEdit(answer.id, { content: structuredClone(answer.message.content) });
    expect((await first.meter()).providerUsageTokens).toBe(0);
  });

  test("full prompt, schema and injection train the ratio once; future tail and growth alone are multiplied", async () => {
    const h = harness({ tools: [tool("schema".repeat(200))], injection: "private injection".repeat(200) });
    const estimated = await h.respond((n) => usage(Math.ceil(n * 1.5), 100));
    const initial = await h.meter();
    const factor = (initial.providerUsageTokens - 100) / estimated;
    expect(initial.calibrationFactor).toBe(factor);
    expect(initial.usedTokens).toBe(initial.providerUsageTokens);
    const tail = user("界😀".repeat(100));
    h.append(tail);
    const before = estimateContextText(h.agent.state.systemPrompt);
    h.setPrompt("g".repeat(300));
    const promptGrowth = estimateContextText(h.agent.state.systemPrompt) - before;
    expect(promptGrowth).toBeGreaterThanOrEqual(100);
    const grown = await h.meter();
    expect(grown.uncalibratedTrailingTokens).toBe(estimateContextMessage(tail));
    expect(grown.estimatedTrailingTokens).toBe(Math.ceil(estimateContextMessage(tail) * factor));
    expect(grown.uncalibratedOverheadTokens).toBe(promptGrowth);
    expect(grown.estimatedOverheadTokens).toBe(Math.ceil(promptGrowth * factor));
    expect(grown.usedTokens).toBe(initial.providerUsageTokens + grown.estimatedTrailingTokens + grown.estimatedOverheadTokens);
  });

  test("overhead growth has a high-water mark; shrinkage never subtracts and a new anchor resets it", async () => {
    const h = harness({ tools: [tool("base")], injection: "i".repeat(300) });
    await h.respond((n) => usage(n * 2));
    const before = estimateContextText(h.agent.state.systemPrompt);
    h.setPrompt("s".repeat(300));
    const promptGrowth = estimateContextText(h.agent.state.systemPrompt) - before;
    expect(promptGrowth).toBeGreaterThanOrEqual(100);
    h.agent.state.tools = [tool("base" + "t".repeat(600))];
    h.setInjection("i".repeat(1200));
    await h.agent.transformContext!(h.agent.state.messages, new AbortController().signal);
    const grown = await h.meter();
    expect(grown.uncalibratedOverheadTokens).toBe(promptGrowth + 500);
    expect(grown.estimatedOverheadTokens).toBe((promptGrowth + 500) * 2);
    h.setPrompt("");
    h.agent.state.tools = [];
    h.setInjection("");
    await h.agent.transformContext!(h.agent.state.messages, new AbortController().signal);
    expect((await h.meter()).usedTokens).toBe(grown.usedTokens);
    await h.respond(usage(10, 2));
    const fresh = await h.meter();
    expect(fresh.usedTokens).toBe(12);
    expect(fresh.estimatedOverheadTokens).toBe(0);
  });

  test("observed request growth survives shrinkage even without an intervening meter call", async () => {
    const h = harness({ injection: "i".repeat(300) });
    await h.respond((n) => usage(n * 2));
    const initial = await h.meter();
    h.setInjection("i".repeat(1200));
    await h.agent.transformContext!(h.agent.state.messages);
    h.setInjection("");
    await h.agent.transformContext!(h.agent.state.messages);
    const current = await h.meter();
    expect(current.uncalibratedOverheadTokens).toBe(300);
    expect(current.usedTokens).toBe(initial.usedTokens + 600);
  });

  test("low reported usage remains the measured anchor, never floored by the heuristic request estimate", async () => {
    const h = harness({ systemPrompt: "s".repeat(30_000) });
    const estimated = await h.respond(usage(1, 1));
    expect(estimated).toBeGreaterThan(10_000);
    const meter = await h.meter();
    expect(meter.calibrationFactor).toBe(1);
    expect(meter.calibrationEligible).toBe(true);
    expect(meter.usedTokens).toBe(2);
    expect(meter.source).toBe("provider_usage");
  });

  test("tiny paired prompts and larger-total normalization anchor without extrapolation", async () => {
    const tiny = harness({ systemPrompt: "short" });
    expect(await tiny.respond(usage(9000, 1))).toBeLessThan(1024);
    expect(await tiny.meter()).toMatchObject({ providerUsageTokens: 9001, usedTokens: 9001, calibrationFactor: 1, calibrationEligible: false });
    const h = harness();
    await h.respond({ ...usage(3000, 1), totalTokens: 20_000 });
    expect(await h.meter()).toMatchObject({ providerUsageTokens: 20_000, usedTokens: 20_000, calibrationFactor: 1, calibrationEligible: false });
  });

  test("wrong model/provider, failed responses, changed source and changed response reject paired usage", async () => {
    for (const overrides of [{ model: "other" }, { provider: "other" }, { api: "openai-responses" }, { stopReason: "error" }, { stopReason: "aborted" }]) {
      const h = harness();
      await h.respond(usage(), overrides);
      expect((await h.meter()).source).toBe("estimate");
    }
    // Persisted message objects are the ones that the next request sends.
    for (const mutate of [
      (h: ReturnType<typeof harness>) => { (h.persisted()[0] as any).content = "changed source"; },
      (h: ReturnType<typeof harness>) => { (h.persisted().at(-1) as any).content[0].text = "changed answer"; },
      (h: ReturnType<typeof harness>) => { (h.persisted().at(-1) as any).usage.input++; },
      (h: ReturnType<typeof harness>) => { h.agent.state.model = model("one", 90_000); },
      (h: ReturnType<typeof harness>) => { h.agent.state.model = { ...model(), api: "openai-responses" }; },
      (h: ReturnType<typeof harness>) => { h.agent.state.model = model("one", NaN); },
      (h: ReturnType<typeof harness>) => { h.agent.state.model = model("one", 0); },
    ]) {
      const h = harness();
      await h.respond();
      expect((await h.meter()).source).toBe("provider_usage");
      mutate(h);
      expect((await h.meter()).source).toBe("estimate");
      expect((await h.meter()).providerUsageTokens).toBe(0);
    }
  });

  test("calibration adds no session entries or private content to public meter results", async () => {
    const secret = "PRIVATE_INJECTION_FIXTURE_do_not_persist";
    const h = harness({ systemPrompt: "PRIVATE_PROMPT_FIXTURE".repeat(200), injection: secret.repeat(100), tools: [tool("PRIVATE_SCHEMA_FIXTURE".repeat(100))] });
    // Ordinary message persistence is the SDK's; calibration adds nothing else.
    const nonMessages = () => h.manager.getEntries().filter((entry) => entry.type !== "message");
    const entries = nonMessages().slice();
    await h.respond((n) => usage(n * 2));
    const report = JSON.stringify(await h.meter());
    expect(nonMessages()).toEqual(entries);
    expect(JSON.stringify(h.manager.getEntries())).not.toContain(secret);
    expect(JSON.stringify(h.agent.state.messages)).not.toContain(secret);
    for (const privateText of [secret, "PRIVATE_PROMPT_FIXTURE", "PRIVATE_SCHEMA_FIXTURE"])
      expect(report).not.toContain(privateText);
    // No inspection of private controller fields: persistence and exposure are the observable contract.
  });
});

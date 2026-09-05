import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { bindSearchSession, webSearch, wrapProvider } from "../src/web-search";
import { requestDiagnosticsReport } from "../src/request-diagnostics";

const disposals: (() => void)[] = [];
afterEach(() => {
  webSearch.enabled = false;
  for (const dispose of disposals.splice(0)) dispose();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const token = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "local-search-fixture" },
})).toString("base64url")}.fixture`;
const completion = (id: number) => ({ type: "response.completed", response: {
  id: `resp_${id}`, status: "completed", output: [],
  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
} });

function fixture(options: {
  upgrade?: (attempt: number) => Promise<void>;
  frame?: (socket: any, attempt: number) => boolean;
  http?: (attempt: number) => Promise<Response> | Response;
} = {}) {
  const frames: any[] = [];
  const wireFrames: string[] = [];
  const http: any[] = [];
  let upgrades = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket") {
        upgrades++;
        await options.upgrade?.(upgrades);
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      const raw = Buffer.from(await request.arrayBuffer());
      http.push(JSON.parse(request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(raw).toString() : raw.toString()));
      return options.http?.(http.length) ?? new Response(`data: ${JSON.stringify(completion(http.length))}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    },
    websocket: { message(socket, message) {
      wireFrames.push(String(message));
      frames.push(JSON.parse(String(message)));
      if (!options.frame?.(socket, frames.length)) socket.send(JSON.stringify(completion(frames.length)));
    } },
  });
  const sessionId = randomUUID();
  const native = openaiCodexProvider();
  const signals: AbortSignal[] = [];
  const base = Object.create(native);
  base.streamSimple = (model: any, context: any, options: any) => {
    signals.push(options.signal);
    return native.streamSimple(model, context, options);
  };
  const provider = wrapProvider(base);
  const session = { sessionId, dispose() {}, agent: {
    streamFunction: provider.streamSimple.bind(provider),
    transformContext: undefined as any,
  } };
  bindSearchSession(session as any, "main");
  disposals.push(() => { session.dispose(); closeOpenAICodexWebSocketSessions(sessionId); server.stop(true); });
  const context: any = { systemPrompt: "Local fixture", messages: [], tools: [
    { name: "read", description: "fixture tool", parameters: { type: "object", properties: {} } },
  ] };
  let hooks = 0;
  const start = async (extra: any = {}) => {
    context.messages.push({ role: "user", content: "local request", timestamp: Date.now() });
    await session.agent.transformContext(context.messages);
    // Keep the provider fixture's messages in pi-ai's native shape; preparation
    // above exercises PUM authority, not custom-message conversion.
    const stream = await session.agent.streamFunction({
      id: "gpt-5.4", name: "local", provider: "openai-codex", api: "openai-codex-responses",
      baseUrl: `http://127.0.0.1:${server.port}`, reasoning: false, input: ["text"],
      contextWindow: 64_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as any, context, { apiKey: token, sessionId, transport: "auto", timeoutMs: 2000,
      websocketConnectTimeoutMs: 2000, maxRetries: 1, ...extra,
      onPayload: (body: any, model: any) => { hooks++; return extra.onPayload?.(body, model); },
    });
    return { result: stream.result() };
  };
  return { start, frames, wireFrames, http, session, context, signals, get hooks() { return hooks; }, get upgrades() { return upgrades; } };
}

// Never wait only for a server gate: a provider failure must fail the test, not
// silently time out before reaching the intended transport boundary.
async function entered(g: ReturnType<typeof gate>, result: Promise<any>) {
  await Promise.race([g.promise, result.then((message) => { throw new Error(`Ended before gate: ${message.stopReason}`); })]);
}

test.each(["disable", "disable-enable", "parent", "dispose"])("installed Codex gated Upgrade: %s prevents the first frame and fallback", async (action) => {
  webSearch.enabled = true;
  const waiting = gate();
  const release = gate();
  const h = fixture({ upgrade: async () => { waiting.resolve(); await release.promise; } });
  const parent = new AbortController();
  const { result } = await h.start({ signal: parent.signal });
  try {
    await entered(waiting, result);
    expect(h.frames).toHaveLength(0);
    expect(h.hooks).toBe(1);
    if (action === "parent") parent.abort();
    else if (action === "dispose") h.session.dispose();
    else { webSearch.enabled = false; if (action === "disable-enable") webSearch.enabled = true; }
    release.resolve();
    expect((await result).stopReason).toBe("aborted");
    expect(h.frames).toHaveLength(0);
    expect(h.http).toHaveLength(0);
  } finally { release.resolve(); }
});

test("installed cached acquisition microtask gap is fenced at serialization, with no global socket patch", async () => {
  webSearch.enabled = true;
  const h = fixture();
  const { result: first } = await h.start();
  const answer = await first;
  expect(answer.stopReason).toBe("stop");
  h.context.messages.push(answer);
  expect(h.frames[0].tools.map((tool: any) => tool.type)).toEqual(["function", "web_search"]);
  let serializations = 0;
  const { result } = await h.start({ onPayload: (body: any) => ({ ...body,
    // SDK serializes bodyJson, synchronously acquires the cached socket, then
    // yields at await. Revoke in that exact gap before response.create stringify.
    fixture: { toJSON() { serializations++; if (serializations === 1) queueMicrotask(() => {
      webSearch.enabled = false; webSearch.enabled = true;
    }); return true; } },
  }) });
  expect((await result).stopReason).toBe("aborted");
  expect(serializations).toBe(2); // bodyJson + cached comparison; actual envelope is fenced
  expect(h.frames).toHaveLength(1);
  expect(h.http).toHaveLength(0);
  expect(h.upgrades).toBe(1);
  expect(h.hooks).toBe(2);
  // The fence must throw inside SDK release's try/finally, not strand the
  // cached entry busy during its earlier historical comparison.
  const recovered = await (await h.start()).result;
  expect(recovered.stopReason).toBe("stop");
  h.context.messages.push(recovered);
  expect((await (await h.start()).result).stopReason).toBe("stop");
  expect(h.upgrades).toBe(2);
  expect(h.frames).toHaveLength(3);
  expect(h.frames[2].previous_response_id).toBe("resp_2");
});

test.each(["root", "nested", "cached-root", "cached-nested"])("installed %s serializer revocation is fenced after traversal", async (location) => {
  for (const action of ["disable", "disable-enable", "parent", "dispose"]) {
    webSearch.enabled = true;
    const h = fixture();
    const cached = location.startsWith("cached-");
    if (cached) h.context.messages.push(await (await h.start()).result);
    const priorFrames = cached ? 1 : 0;
    const nestedTarget = cached ? 3 : 2;
    const root = location.endsWith("root");
    const parent = new AbortController();
    let traversals = 0;
    const revoke = () => {
      if (action === "parent") parent.abort();
      else if (action === "dispose") h.session.dispose();
      else { webSearch.enabled = false; if (action === "disable-enable") webSearch.enabled = true; }
    };
    const { result } = await h.start({ signal: parent.signal, onPayload: (body: any) => root
      ? { ...body, toJSON(this: any) { if (this.type === "response.create") { traversals++; revoke(); } return this; } }
      : { ...body, fixture: { toJSON() { if (++traversals === nestedTarget) revoke(); return true; } } },
    });
    expect((await result).stopReason).toBe("aborted");
    expect(traversals).toBe(root ? 1 : nestedTarget);
    expect(h.frames).toHaveLength(priorFrames);
    expect(h.http).toHaveLength(0);
    // A failure inside send's try/finally must release the cached socket.
    if (action !== "dispose") {
      webSearch.enabled = true;
      const recovered = await (await h.start()).result;
      expect(recovered.stopReason).toBe("stop");
      h.context.messages.push(recovered);
      expect((await (await h.start()).result).stopReason).toBe("stop");
      expect(h.upgrades).toBe(2);
      expect(h.frames[priorFrames + 1].previous_response_id).toBe(`resp_${priorFrames + 1}`);
    }
  }
});

test("installed serialization preserves root replacement, nested keys, getters and one conversion per traversal", async () => {
  webSearch.enabled = true;
  const h = fixture();
  let roots = 0;
  let nested = 0;
  let getters = 0;
  const rootKeys: string[] = [];
  const nestedKeys: string[] = [];
  const hook = (body: any) => ({ ...body, toJSON(this: any, key: string) {
    roots++;
    rootKeys.push(key);
    return { ...this, fixture: { toJSON(key: string) {
      nested++; nestedKeys.push(key);
      return { get kept() { getters++; return "custom"; }, omitted: undefined, array: [undefined, NaN, -0] };
    } }, toJSON() { throw new Error("Returned root must not be converted twice"); } };
  } });
  const first = await (await h.start({ onPayload: hook })).result;
  expect(first.stopReason).toBe("stop");
  expect(roots).toBe(2); // bodyJson and actual response.create, no extra conversion
  expect(nested).toBe(2);
  expect(getters).toBe(2);
  expect(rootKeys).toEqual(["", ""]);
  expect(nestedKeys).toEqual(["fixture", "fixture"]);
  expect(h.frames[0].fixture).toEqual({ kept: "custom", array: [null, null, 0] });
  h.context.messages.push(first);
  expect((await (await h.start({ onPayload: hook })).result).stopReason).toBe("stop");
  expect(h.frames[1].previous_response_id).toBe("resp_1");
  expect(h.frames[1].input).toHaveLength(1);
  expect(h.frames[1].tools.map((tool: any) => tool.type)).toEqual(["function", "web_search"]);
  expect(h.upgrades).toBe(1);
  expect(h.http).toHaveLength(0);
});

test("installed send preserves JSON.rawJSON primitive bytes without precision loss", async () => {
  webSearch.enabled = true;
  const h = fixture();
  let expected = "";
  const rawJSON = (JSON as typeof JSON & { rawJSON(source: string): unknown }).rawJSON;
  const { result } = await h.start({ onPayload: (body: any) => ({ ...body, toJSON(this: any) {
    const { toJSON: _toJSON, ...fields } = this;
    const value = { ...fields, integer: rawJSON("123456789012345678901234567890"),
      exponent: rawJSON("1e2"), escaped: rawJSON('"\\\\u0061"') };
    if (this.type === "response.create") expected = JSON.stringify(value);
    return value;
  } }) });
  expect((await result).stopReason).toBe("stop");
  expect(h.wireFrames).toEqual([expected]);
  expect(expected).toContain("123456789012345678901234567890");
  expect(expected).toContain("1e2");
  expect(expected).toContain("\\\\u0061");
});

test.each([null, "custom-root", ["custom-array"]])("installed original root serializer can return %j", async (value) => {
  webSearch.enabled = true;
  const h = fixture();
  let envelopes = 0;
  const { result } = await h.start({ onPayload: (body: any) => ({ ...body, toJSON(this: any) {
    if (this.type === "response.create") { envelopes++; return value; }
    return this;
  } }) });
  expect((await result).stopReason).toBe("stop");
  expect(envelopes).toBe(1);
  expect(h.frames).toEqual([value]);
  expect(h.http).toHaveLength(0);
});

test.each(["cycle", "bigint"])("installed envelope-only %s preserves native serialization failure and SDK fallback", async (kind) => {
  webSearch.enabled = true;
  const h = fixture();
  const { result } = await h.start({ onPayload: (body: any) => ({ ...body, toJSON(this: any) {
    if (this.type === "response.create") {
      if (kind === "bigint") return { value: 1n };
      this.cycle = this;
    }
    return this;
  } }) });
  expect((await result).stopReason).toBe("stop");
  expect(h.frames).toHaveLength(0);
  expect(h.http).toHaveLength(1); // unchanged SDK fallback uses its earlier valid bodyJson
  expect((await (await h.start()).result).stopReason).toBe("stop");
  expect(h.upgrades).toBe(1); // SDK pins this session to SSE after a non-abort failure
  expect(h.http).toHaveLength(2);
});

test("installed auto transport preserves full/delta caching, diagnostics and exact tool order while enabled", async () => {
  const prior = process.env.PUM_REQUEST_DIAGNOSTICS;
  process.env.PUM_REQUEST_DIAGNOSTICS = "1";
  disposals.push(() => { if (prior === undefined) delete process.env.PUM_REQUEST_DIAGNOSTICS; else process.env.PUM_REQUEST_DIAGNOSTICS = prior; });
  webSearch.enabled = true;
  const h = fixture();
  const first = await (await h.start()).result;
  h.context.messages.push(first);
  const second = await (await h.start()).result;
  expect(first.stopReason).toBe("stop");
  expect(second.stopReason).toBe("stop");
  expect(h.frames).toHaveLength(2);
  expect(h.frames[1].previous_response_id).toBe("resp_1");
  expect(h.frames[1].input).toHaveLength(1);
  expect(h.upgrades).toBe(1);
  expect(h.http).toHaveLength(0);
  expect(h.frames[1].tools).toEqual(h.frames[0].tools);
  expect(h.frames[0].tools.map((tool: any) => tool.type)).toEqual(["function", "web_search"]);
  const records = requestDiagnosticsReport(h.session.sessionId).requests;
  expect(records).toHaveLength(2);
  expect(records[0].tools).toEqual(records[1].tools);
  expect(records[0].nonInput).toEqual(records[1].nonInput);
  expect(records[1].transport.observed).toBe("websocket-delta");
  expect(records[1].reasons).not.toContain("tools-changed");
  expect(JSON.stringify(records)).not.toContain("toJSON");
  expect(JSON.stringify(records)).not.toContain(token);
});

test.each(["success", "error", "preparation-error"])("installed request %s settlement unregisters revocation, disposal and parent listeners", async (outcome) => {
  webSearch.enabled = true;
  const parent = new AbortController();
  const h = fixture(outcome === "error" ? { frame(socket) {
    socket.send(JSON.stringify({ type: "error", code: "invalid_request_error", message: "fixture rejected" }));
    return true;
  } } : {});
  const { result } = await h.start({ signal: parent.signal, ...(outcome === "preparation-error" ? { apiKey: "invalid-fixture" } : {}) });
  expect((await result).stopReason).toBe(outcome === "success" ? "stop" : "error");
  expect(h.signals).toHaveLength(1);
  webSearch.enabled = false;
  h.session.dispose();
  parent.abort();
  // All three sources would abort this signal if their registries/listeners
  // retained the settled request. No internal registry inspection is needed.
  expect(h.signals[0].aborted).toBe(false);
});

test("settled cached bodies stay comparable after disable and a fresh re-enable grant", async () => {
  webSearch.enabled = true;
  const h = fixture();
  const first = await (await h.start()).result;
  h.context.messages.push(first);
  webSearch.enabled = false;
  const second = await (await h.start()).result;
  expect(second.stopReason).toBe("stop");
  h.context.messages.push(second);
  webSearch.enabled = true;
  const third = await (await h.start()).result;
  expect(third.stopReason).toBe("stop");
  expect(h.frames.map((frame) => frame.tools.some((tool: any) => tool.type === "web_search"))).toEqual([true, false, true]);
  expect(h.upgrades).toBe(1);
  expect(h.http).toHaveLength(0);
});

test("installed WS connection-limit retry reuses the body but revocation during retry Upgrade prevents sending it", async () => {
  webSearch.enabled = true;
  const waiting = gate();
  const release = gate();
  const h = fixture({
    upgrade: async (attempt) => { if (attempt === 2) { waiting.resolve(); await release.promise; } },
    frame(socket) { socket.send(JSON.stringify({ type: "error", code: "websocket_connection_limit_reached", message: "fixture limit" })); return true; },
  });
  const { result } = await h.start();
  try {
    await entered(waiting, result);
    expect(h.frames).toHaveLength(1); // already dispatched cannot be retracted
    webSearch.enabled = false;
    webSearch.enabled = true;
    release.resolve();
    expect((await result).stopReason).toBe("aborted");
    expect(h.upgrades).toBe(2);
    expect(h.frames).toHaveLength(1);
    expect(h.hooks).toBe(1); // installed SDK does not rerun the hook
    expect(h.http).toHaveLength(0);
  } finally { release.resolve(); }
});

test("installed WS failure cannot fall back with the prepared search body after disable", async () => {
  webSearch.enabled = true;
  const h = fixture({ frame(socket) {
    webSearch.enabled = false;
    webSearch.enabled = true;
    socket.close(1011, "fixture failure");
    return true;
  } });
  const { result } = await h.start();
  expect((await result).stopReason).toBe("aborted");
  expect(h.frames).toHaveLength(1);
  expect(h.http).toHaveLength(0);
  expect(h.hooks).toBe(1);
});

test("installed actual SSE fallback retry is revoked although SDK never reruns onPayload", async () => {
  webSearch.enabled = true;
  const h = fixture({
    frame(socket) { socket.close(1011, "fixture fallback"); return true; },
    http() { return new Response("fixture retry", { status: 429, headers: { "retry-after-ms": "1" } }); },
  });
  const { result } = await h.start({ onResponse: () => {
    webSearch.enabled = false;
    webSearch.enabled = true;
  } });
  expect((await result).stopReason).toBe("aborted");
  expect(h.frames).toHaveLength(1);
  expect(h.http).toHaveLength(1); // fallback did occur, but its retry must not
  expect(h.http[0].tools.at(-1).type).toBe("web_search");
  expect(h.hooks).toBe(1);
});

test("installed SSE-only admission checks revocation after body serialization before fetch", async () => {
  webSearch.enabled = true;
  const h = fixture();
  const { result } = await h.start({ transport: "sse", onPayload: (body: any) => ({ ...body,
    fixture: { toJSON() { webSearch.enabled = false; webSearch.enabled = true; return true; } },
  }) });
  expect((await result).stopReason).toBe("aborted");
  expect(h.upgrades).toBe(0);
  expect(h.frames).toHaveLength(0);
  expect(h.http).toHaveLength(0);
  expect(h.hooks).toBe(1);
});

test("installed SSE-only retry checks the same revoked signal instead of reusing its body", async () => {
  webSearch.enabled = true;
  const h = fixture({ http() { return new Response("fixture retry", { status: 429, headers: { "retry-after-ms": "1" } }); } });
  const { result } = await h.start({ transport: "sse", onResponse: () => {
    webSearch.enabled = false; webSearch.enabled = true;
  } });
  expect((await result).stopReason).toBe("aborted");
  expect(h.upgrades).toBe(0);
  expect(h.frames).toHaveLength(0);
  expect(h.http).toHaveLength(1);
  expect(h.hooks).toBe(1);
});

test("a search-disabled pending request is not cancelled by another request's disable epoch", async () => {
  webSearch.enabled = false;
  const waiting = gate();
  const release = gate();
  const h = fixture({ upgrade: async () => { waiting.resolve(); await release.promise; } });
  const { result } = await h.start();
  try {
    await entered(waiting, result);
    webSearch.enabled = true;
    webSearch.enabled = false;
    release.resolve();
    expect((await result).stopReason).toBe("stop");
    expect(h.frames[0].tools.map((tool: any) => tool.type)).toEqual(["function"]);
    expect(h.http).toHaveLength(0);
  } finally { release.resolve(); }
});

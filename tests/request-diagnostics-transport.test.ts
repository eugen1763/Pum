import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import type { Context, Model } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions, resetOpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { bindSearchSession, webSearch, wrapProvider } from "../src/web-search";
import { clearRequestDiagnostics, requestDiagnosticsReport } from "../src/request-diagnostics";

const env = process.env.PUM_REQUEST_DIAGNOSTICS;
const search = webSearch.enabled;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  clearRequestDiagnostics();
  if (env === undefined) delete process.env.PUM_REQUEST_DIAGNOSTICS;
  else process.env.PUM_REQUEST_DIAGNOSTICS = env;
  webSearch.enabled = search;
});
const fakeToken = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "local-transport-fixture" },
})).toString("base64url")}.fixture`;

function response(id: number, cached: number) {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: `Answer ${id}`, annotations: [] }] };
  return [
    { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: cached } } } },
  ];
}

function fixture(fallback = false) {
  process.env.PUM_REQUEST_DIAGNOSTICS = "1";
  webSearch.enabled = false;
  const frames: any[] = [];
  const http: any[] = [];
  let count = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      const raw = Buffer.from(await request.arrayBuffer());
      http.push(JSON.parse(request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw).toString() : raw.toString()));
      return new Response(response(++count, 23).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    },
    websocket: { message(socket, message) {
      frames.push(JSON.parse(String(message)));
      if (fallback) { socket.close(1011, "PRIVATE_CONNECTION_ERROR_MUST_NOT_BE_REPORTED"); return; }
      // Full request 1 reports a cache read; delta request 2 reports zero.
      // This deliberately refutes the false equivalence between the two axes.
      for (const event of response(++count, count === 1 ? 30 : 0)) socket.send(JSON.stringify(event));
    } },
  });
  const sessionId = randomUUID();
  cleanup.push(() => { closeOpenAICodexWebSocketSessions(sessionId); resetOpenAICodexWebSocketDebugStats(sessionId); server.stop(true); });
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-5.4", name: "local", provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: `http://127.0.0.1:${server.port}`, reasoning: false, input: ["text"], contextWindow: 64_000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const provider = wrapProvider(openaiCodexProvider());
  const session = { sessionId, agent: { streamFunction: provider.streamSimple.bind(provider) } };
  bindSearchSession(session as any, "main");
  const context: Context = { systemPrompt: "Fixed fixture instruction", messages: [], tools: [] };
  const prompt = async (text: string) => {
    context.messages.push({ role: "user", content: text, timestamp: Date.now() });
    const stream = await session.agent.streamFunction(model, context, { apiKey: fakeToken, sessionId, transport: "auto" });
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    context.messages.push(result);
    return requestDiagnosticsReport(sessionId).requests.at(-1)!;
  };
  return { sessionId, frames, http, prompt, context };
}

test("installed SDK WebSocket counters identify full/delta, reuse and instruction reset separately from reported cache tokens", async () => {
  const h = fixture();
  const first = await h.prompt("first");
  expect(first.transport.observed).toBe("websocket-full");
  expect(first.transport.counters?.connectionsCreated).toBe(1);
  expect(first.usage?.cacheRead).toBe(30);
  expect(h.frames[0].previous_response_id).toBeUndefined();
  const second = await h.prompt("second");
  expect(second.transport.observed).toBe("websocket-delta");
  expect(second.transport.counters?.connectionsReused).toBe(1);
  expect(second.transport.counters?.deltaRequests).toBe(1);
  expect(second.usage?.cacheRead).toBe(0);
  expect(h.frames[1].previous_response_id).toBe("resp_1");
  expect(h.frames[1].input.length).toBe(1);
  expect(second.input!.items).toBeGreaterThan(h.frames[1].input.length); // hook observes FULL pre-transport body
  h.context.systemPrompt = "Changed instruction";
  const third = await h.prompt("third");
  expect(third.reasons).toContain("instructions-changed");
  expect(third.transport.observed).toBe("websocket-full");
  expect(third.transport.counters?.connectionsReused).toBe(1); // same socket, incompatible continuation
  expect(h.frames[2].previous_response_id).toBeUndefined();
  expect(h.http).toHaveLength(0);
  const json = JSON.stringify(requestDiagnosticsReport(h.sessionId));
  expect(json).not.toContain("resp_1");
  expect(json).not.toContain(fakeToken);
  expect(json).not.toContain("Changed instruction");
});

test("installed SDK socket failure reports bounded counters and SSE fallback without raw error or response ids", async () => {
  const h = fixture(true);
  const record = await h.prompt("fallback");
  expect(record.transport.observed).toBe("sse-fallback");
  expect(record.transport.counters?.websocketFailures).toBe(1);
  expect(record.transport.counters?.sseFallbacks).toBe(1);
  expect(record.usage?.cacheRead).toBe(23);
  expect(h.frames).toHaveLength(1);
  expect(h.http).toHaveLength(1);
  const json = JSON.stringify(requestDiagnosticsReport(h.sessionId));
  expect(json).not.toContain("PRIVATE_CONNECTION_ERROR");
  expect(json).not.toContain("lastWebSocketError");
  expect(json).not.toContain("lastPreviousResponseId");
});

import { describe, expect, test, spyOn } from "bun:test";
import { McpProtocolClient, MCP_PROTOCOL_VERSION, MCP_LIMITS, validateMcpSchema, validateMcpArguments,
  type McpSpawnRequest, type McpProtocolOptions, type McpTool } from "../src/mcp-protocol";

const config = { executable: "/fake/server", args: [], cwd: "/fake/project" };
const tool: McpTool = { name: "echo", description: "Echo text", inputSchema: { type: "object",
  properties: { text: { type: "string", maxLength: 100 } }, required: ["text"], additionalProperties: false } };
const init = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1" } };
function fake(options: McpProtocolOptions = {}, respond?: (message: any, reply: (result: unknown) => void) => void) {
  let request!: McpSpawnRequest;
  let closed = 0, killed = 0;
  let exit!: () => void;
  let rejectExit!: (error: Error) => void;
  let writeFailure = false;
  const sent: any[] = [];
  const emit = (value: unknown) => request.onStdout(JSON.stringify(value) + "\n");
  const connected = McpProtocolClient.connect(req => {
    request = req;
    return { write: async data => {
      if (writeFailure) throw new Error("secret transport failure");
      const message = JSON.parse(data); sent.push(message);
      const reply = (result: unknown) => emit({ jsonrpc: "2.0", id: message.id, result });
      if (respond) respond(message, reply);
      else if (message.method === "initialize") reply(init);
      else if (message.method === "tools/list") reply({ tools: [tool] });
      else if (message.method === "tools/call") reply({ content: [{ type: "text", text: message.params.arguments.text }] });
    }, close: () => { closed++; }, kill: () => { killed++; },
    completed: new Promise<void>((resolve, reject) => { exit = resolve; rejectExit = reject; }) };
  }, config, options);
  return { connected, sent, emit, raw: (data: Uint8Array | string) => request.onStdout(data),
    stderr: (data: string) => request.onStderr(data), exit: () => exit(), rejectExit: () => rejectExit(new Error("secret exit")),
    failWrites: () => { writeFailure = true; }, get closed() { return closed; }, get killed() { return killed; } };
}
async function ready(respond?: (message: any, reply: (result: unknown) => void) => void) {
  const f = fake({}, respond); const client = await f.connected; await client.listTools(); return { ...f, client, f };
}

describe("bounded tools-only MCP protocol", () => {
  test("exact initialize/initialized/list/call sequence, detached metadata, no ambient capabilities", async () => {
    const f = fake(); const client = await f.connected;
    expect(f.sent[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pum", version: "1" } } });
    expect(f.sent[1]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await client.listTools(); tools[0]!.inputSchema.required = [];
    await expect(client.callTool("echo", {})).rejects.toThrow();
    const result = await client.callTool("echo", { text: "hello" });
    expect(result).toEqual({ text: "[MCP tool echo: untrusted server output]\nhello", isError: false });
    expect(f.sent.map(x => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    client.close(); client.close(); expect(f.closed).toBe(1); expect(f.killed).toBe(1);
  });
  test.each(["2026-07-28", "2025-03-26", "", null])("unsupported negotiated version %s fails closed", async version => {
    const f = fake({}, (m, reply) => { if (m.method === "initialize") reply({ ...init, protocolVersion: version }); });
    await expect(f.connected).rejects.toThrow("MCP connection failed"); expect(f.killed).toBe(1);
    expect(f.sent).toHaveLength(1);
  });
  test("missing tools capability and malformed initialize fail generically", async () => {
    for (const value of [{ ...init, capabilities: {} }, { ...init, serverInfo: {} }, { ...init, serverInfo: { name: "secret\u001b", version: "1" } }]) {
      const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(value); });
      await expect(f.connected).rejects.toThrow("MCP connection failed"); expect(f.killed).toBe(1);
    }
  });
  test("split multibyte UTF8 and multiple frames in one chunk", async () => {
    let call: any;
    const f = await ready((m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); if (m.method === "tools/call") call = m; });
    const pending = f.client.callTool("echo", { text: "x" });
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "🌊" }] } }) + "\n");
    const split = frame.indexOf(Buffer.from("🌊")) + 1;
    f.raw(frame.subarray(0, split)); f.raw(frame.subarray(split));
    expect((await pending).text).toContain("🌊");
    f.raw('{"jsonrpc":"2.0","method":"notifications/progress"}\n{"jsonrpc":"2.0","method":"notifications/message"}\n');
    expect(f.f.closed).toBe(0); f.client.close();
  });
  test.each(["not json\n", "[]\n", "null\n", "\n", '{"jsonrpc":"1.0"}\n',
    '{"jsonrpc":"2.0","id":999,"result":{}}\n', '{"jsonrpc":"2.0","method":"x","result":{}}\n'])
  ("hostile frame fails closed: %s", async frame => {
    const f = await ready(); f.raw(frame); expect(f.f.killed).toBe(1);
    await expect(f.client.callTool("echo", { text: "x" })).rejects.toThrow("closed");
  });
  test("strict invalid UTF8 and overlong byte frames close, including unterminated frames", async () => {
    for (const frame of [Buffer.from([0xff, 10]), Buffer.from("é".repeat(MCP_LIMITS.frameBytes / 2 + 1)), Buffer.from("x".repeat(MCP_LIMITS.frameBytes + 1) + "\n")]) {
      const f = await ready(); f.raw(frame); expect(f.f.killed).toBe(1);
    }
  });
  test("one-byte frame delivery has bounded geometric allocation rather than quadratic copying", async () => {
    const f = await ready();
    const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { ignored: "x".repeat(100_000) } }) + "\n");
    const allocate = spyOn(Buffer, "allocUnsafe");
    const concatenate = spyOn(Buffer, "concat");
    try {
      for (let i = 0; i < data.length; i++) f.raw(data.subarray(i, i + 1));
      expect(f.f.closed).toBe(0);
      expect(allocate.mock.calls.length).toBeLessThanOrEqual(8);
      expect(concatenate).not.toHaveBeenCalled();
      // Reused capacity must not include stale bytes in the next short frame.
      f.emit({ jsonrpc: "2.0", method: "notifications/progress" });
      expect(f.f.closed).toBe(0);
    } finally { allocate.mockRestore(); concatenate.mockRestore(); f.client.close(); }
  });
  test("session stdout budget bounds otherwise valid notification flood", async () => {
    const f = await ready(); const line = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "x".repeat(240_000) } }) + "\n";
    for (let n = 0; n < 72; n++) f.raw(line);
    expect(f.f.killed).toBe(1);
  });
  test("unsolicited requests never gain roots/sampling/elicitation/prompts/tasks privileges", async () => {
    const f = await ready();
    for (const method of ["roots/list", "sampling/createMessage", "elicitation/create", "prompts/get", "tasks/get", "resources/read"]) {
      f.emit({ jsonrpc: "2.0", id: method, method, params: { url: "https://untrusted.invalid" } });
      await Promise.resolve();
      expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: method, error: { code: -32601, message: "Method not found" } });
    }
    f.emit({ jsonrpc: "2.0", id: "ping", method: "ping" });
    expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "ping", result: {} }); f.client.close();
  });
  test("listChanged invalidates once and cannot be revived, even if observer throws", async () => {
    let changed = 0, closed = 0;
    const f = fake({ onClose: () => { closed++; throw Error("observer"); }, onToolsChanged: () => { changed++; throw Error("observer"); } });
    const client = await f.connected; await client.listTools();
    f.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    f.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(changed).toBe(1); expect(closed).toBe(1); expect(f.killed).toBe(1);
    await expect(client.listTools()).rejects.toThrow("closed");
  });
  test("mismatch, duplicate, result+error, malformed errors and server errors reject pending without raw data", async () => {
    for (const variant of ["mismatch", "duplicate", "both", "error", "bad-error"]) {
      let call: any;
      const f = await ready((m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); if (m.method === "tools/call") call = m; });
      const pending = f.client.callTool("echo", { text: "x" });
      const result = { jsonrpc: "2.0", id: call.id, result: { content: [] } };
      if (variant === "mismatch") f.emit({ ...result, id: String(call.id) });
      if (variant === "duplicate") f.raw(JSON.stringify(result) + "\n" + JSON.stringify(result) + "\n");
      if (variant === "both") f.emit({ ...result, error: { code: 1, message: "SECRET" } });
      if (variant === "error" || variant === "bad-error") f.emit({ jsonrpc: "2.0", id: call.id, error: { code: variant === "error" ? 1 : "bad", message: "SECRET" } });
      await expect(pending).rejects.toThrow(/MCP/); expect(f.f.killed).toBe(1);
    }
  });
  test("stderr is discarded and exit/write failures are generic", async () => {
    const f = await ready(); f.stderr("SECRET stderr"); expect(f.f.closed).toBe(0);
    f.failWrites(); await expect(f.client.callTool("echo", { text: "x" })).rejects.toThrow("MCP transport failed");
    const other = await ready(); other.rejectExit(); await Promise.resolve(); expect(other.f.killed).toBe(1);
  });
  test("pagination is bounded, ordered and carries only opaque cursors", async () => {
    const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") {
      reply(m.params.cursor ? { tools: [{ ...tool, name: "two" }] } : { tools: [tool], nextCursor: "opaque" });
    } });
    const client = await f.connected; expect((await client.listTools()).map(t => t.name)).toEqual(["echo", "two"]);
    expect(f.sent.at(-1).params).toEqual({ cursor: "opaque" }); client.close();
  });
  test("tool/page/aggregate-byte limits, repeated cursor, duplicate tool names reject atomically", async () => {
    for (const mode of ["tools", "pages", "bytes", "cursor", "duplicate"]) {
      let page = 0;
      const f = fake({}, (m, reply) => {
        if (m.method === "initialize") reply(init);
        if (m.method !== "tools/list") return;
        page++;
        if (mode === "tools") reply({ tools: Array.from({ length: 33 }, (_, i) => ({ ...tool, name: `t${i}` })) });
        if (mode === "pages") reply({ tools: [], nextCursor: `p${page}` });
        if (mode === "bytes") reply({ tools: [], nextCursor: `p${page}`, _meta: { ignored: "x".repeat(150_000) } });
        if (mode === "cursor") reply({ tools: [], nextCursor: "same" });
        if (mode === "duplicate") reply({ tools: [tool, tool] });
      });
      const client = await f.connected; await expect(client.listTools()).rejects.toThrow("MCP discovery failed");
      expect(f.killed).toBe(1); expect(page).toBeLessThanOrEqual(4);
    }
  });
  test("hostile names, descriptions, required tasks and unsupported schemas fail discovery", async () => {
    for (const change of [{ name: "__proto__" }, { name: "constructor" }, { name: "has.dot" }, { name: "x".repeat(65) },
      { description: "x".repeat(2049) }, { description: "escape\u001b" }, { description: "new\nline" },
      { inputSchema: { type: "object", $ref: "https://untrusted.invalid" } }, { execution: { taskSupport: "required" } }]) {
      const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [{ ...tool, ...change }] }); });
      const client = await f.connected; await expect(client.listTools()).rejects.toThrow("MCP discovery failed"); expect(f.killed).toBe(1);
    }
  });
  test("text-only results ignore links/images/structured data and propagate tool error, bounded UTF8/lines", async () => {
    const f = await ready((m, reply) => {
      if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] });
      if (m.method === "tools/call") reply({ isError: true, content: [
        { type: "resource_link", uri: "https://NEVER-FOLLOW.invalid" }, { type: "image", data: "NEVER-RENDER" },
        { type: "text", text: "🌊".repeat(5000) + "\nline".repeat(500) + "\u001bSECRET-END" }], structuredContent: { private: "IGNORED" } });
    });
    const result = await f.client.callTool("echo", { text: "x" });
    expect(result.isError).toBe(true); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16 * 1024);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(200);
    expect(result.text).toContain("truncated or unsupported"); expect(result.text).not.toContain("NEVER"); expect(result.text).not.toContain("IGNORED");
    expect(result.text).not.toContain("�"); f.client.close();
  });
  test("malformed result fails closed instead of reporting success", async () => {
    for (const result of [{ content: "secret" }, { content: [{ type: "text", text: 42 }] }, { content: [], isError: "yes" }]) {
      const f = await ready((m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); if (m.method === "tools/call") reply(result); });
      await expect(f.client.callTool("echo", { text: "x" })).rejects.toThrow("MCP result failed"); expect(f.f.killed).toBe(1);
    }
  });
  test("abort rejects all in-flight calls promptly, sends cancel best effort and ignores late results", async () => {
    const f = await ready((m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); });
    const abort = new AbortController();
    const calls = [f.client.callTool("echo", { text: "x" }, abort.signal), f.client.callTool("echo", { text: "y" })];
    const rejected = Promise.all(calls.map(call => call.catch(error => error as Error)));
    abort.abort();
    for (const error of await rejected) expect((error as Error).message).toContain("cancelled");
    expect(f.sent.at(-1).method).toBe("notifications/cancelled"); expect(f.f.killed).toBe(1);
    f.emit({ jsonrpc: "2.0", id: 3, result: { content: [] } }); expect(f.f.killed).toBe(1);
  });
  test("connection-level abort after initialization cancels outstanding non-initialize requests", async () => {
    const signal = new AbortController();
    const f = fake({ signal: signal.signal }, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); });
    const client = await f.connected; await client.listTools();
    const call = client.callTool("echo", { text: "x" }).catch(error => error as Error);
    signal.abort(); expect((await call as Error).message).toContain("cancelled");
    expect(f.sent.at(-1).method).toBe("notifications/cancelled"); expect(f.killed).toBe(1);
  });
  test("already-aborted discovery/call closes without sending new requests", async () => {
    for (const phase of ["list", "call"]) {
      const f = await ready(); const before = f.sent.length;
      const signal = AbortSignal.abort();
      await expect(phase === "list" ? f.client.listTools(signal) : f.client.callTool("echo", { text: "x" }, signal)).rejects.toThrow(/MCP/);
      expect(f.sent.length).toBe(before); expect(f.f.killed).toBe(1);
    }
  });
  test("abort after a response but before its continuation cannot publish tools or return output", async () => {
    for (const phase of ["list", "call"]) {
      const abort = new AbortController();
      const f = fake({}, (m, reply) => {
        if (m.method === "initialize") reply(init);
        if (m.method === "tools/list") {
          reply({ tools: [tool] });
          if (phase === "list") abort.abort();
        }
        if (m.method === "tools/call") {
          reply({ content: [{ type: "text", text: "must not escape" }] });
          abort.abort();
        }
      });
      const client = await f.connected;
      if (phase === "call") await client.listTools();
      await expect(phase === "list" ? client.listTools(abort.signal) : client.callTool("echo", { text: "x" }, abort.signal)).rejects.toThrow(/MCP/);
      expect(f.killed).toBe(1);
      await expect(client.callTool("echo", { text: "x" })).rejects.toThrow("closed");
      // The response has already completed; do not issue cancellation for its id.
      expect(f.sent.some(m => m.method === "notifications/cancelled")).toBe(false);
    }
  });
  test("server initialization instructions and unused metadata never enter discovered tools", async () => {
    const f = fake({}, (m, reply) => {
      if (m.method === "initialize") reply({ ...init, instructions: "PRIVATE-SERVER-INSTRUCTIONS" });
      if (m.method === "tools/list") reply({ tools: [{ ...tool, title: "PRIVATE-TITLE", annotations: { readOnlyHint: true },
        icons: [{ src: "https://PRIVATE-ICON.invalid" }], _meta: { secret: "PRIVATE-META" } }] });
    });
    const client = await f.connected;
    expect(await client.listTools()).toEqual([tool]);
    client.close();
  });
  test("four in-flight limit, no implicit queue or retry", async () => {
    const f = await ready((m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); });
    const calls = Array.from({ length: 4 }, () => f.client.callTool("echo", { text: "x" }));
    await expect(f.client.callTool("echo", { text: "x" })).rejects.toThrow("limit");
    expect(f.sent.filter(x => x.method === "tools/call")).toHaveLength(4);
    const rejected = Promise.all(calls.map(call => call.catch(error => error as Error)));
    f.client.close(); for (const error of await rejected) expect((error as Error).message).toContain("closed");
  });
  test("initialize abort never emits cancellation and already-aborted connect never spawns", async () => {
    const abort = new AbortController(); const f = fake({ signal: abort.signal }, () => {});
    await Promise.resolve(); abort.abort(); await expect(f.connected).rejects.toThrow("MCP connection failed");
    expect(f.sent.some(m => m.method === "notifications/cancelled")).toBe(false); expect(f.killed).toBe(1);
    let spawned = false;
    await expect(McpProtocolClient.connect(() => { spawned = true; throw Error(); }, config, { signal: abort.signal })).rejects.toThrow();
    expect(spawned).toBe(false);
  });
  test("absolute call timeout is not extended by progress", async () => {
    const f = await ready((m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list") reply({ tools: [tool] }); });
    let timeout!: () => void;
    const original = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === MCP_LIMITS.callMs) { timeout = callback; return original(() => {}, 60_000); }
      return original(callback, ms);
    }) as typeof setTimeout);
    try {
      const call = f.client.callTool("echo", { text: "x" });
      f.emit({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 3, progress: 1 } });
      timeout(); await expect(call).rejects.toThrow("timed out"); expect(f.f.killed).toBe(1);
    } finally { timer.mockRestore(); f.client.close(); }
  });
  test("discovery uses one absolute deadline across pages", async () => {
    let list = 0; let timeout!: () => void;
    const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "tools/list" && ++list === 1) reply({ tools: [], nextCursor: "two" }); });
    const client = await f.connected;
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      delays.push(ms); timeout = callback; return original(() => {}, 60_000);
    }) as typeof setTimeout);
    try {
      const call = client.listTools().catch(error => error as Error);
      // Flush page-one continuation, without a sleep or external process.
      await Promise.resolve(); await Promise.resolve();
      expect(list).toBe(2); expect(delays).toHaveLength(2); expect(delays[1]!).toBeLessThanOrEqual(delays[0]!);
      timeout(); expect((await call as Error).message).toBe("MCP discovery failed."); expect(f.killed).toBe(1);
    } finally { timer.mockRestore(); client.close(); }
  });
  test("startup deadline also bounds a stuck initialized notification write", async () => {
    let timeout!: () => void; let killed = 0;
    const original = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      if (!timeout) timeout = callback;
      return original(() => {}, 60_000);
    }) as typeof setTimeout);
    try {
      const connect = McpProtocolClient.connect(req => ({
        write: data => {
          const m = JSON.parse(data);
          if (m.method === "initialize") { req.onStdout(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: init }) + "\n"); return Promise.resolve(); }
          return new Promise(() => {});
        }, close() {}, kill() { killed++; }, completed: new Promise(() => {}),
      }), config).catch(error => error as Error);
      await Promise.resolve(); await Promise.resolve(); timeout();
      expect((await connect as Error).message).toBe("MCP connection failed."); expect(killed).toBe(1);
    } finally { timer.mockRestore(); }
  });
  test("startup absolute timeout bounds hung spawn and kills its late handle", async () => {
    let timeout!: () => void;
    const original = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === MCP_LIMITS.startupMs) { timeout = callback; return original(() => {}, 60_000); }
      return original(callback, ms);
    }) as typeof setTimeout);
    let deliver!: (handle: any) => void; let killed = 0;
    try {
      const connect = McpProtocolClient.connect(() => new Promise(resolve => { deliver = resolve; }), config);
      timeout(); await expect(connect).rejects.toThrow("MCP connection failed");
      deliver({ write: async () => {}, close() {}, kill() { killed++; }, completed: Promise.resolve() });
      await Promise.resolve(); expect(killed).toBe(1);
    } finally { timer.mockRestore(); }
  });
});

describe("inert narrow schema and JSON arguments", () => {
  test("supported nested subset validates types, constraints and Unicode codepoint length", () => {
    const schema = validateMcpSchema({ type: "object", additionalProperties: false, properties: {
      s: { type: "string", minLength: 1, maxLength: 1, enum: ["🌊"] }, n: { type: "integer", minimum: 1, maximum: 3 },
      a: { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 2 }, nil: { type: "null" } }, required: ["s", "n", "a", "nil"] });
    const valid = { s: "🌊", n: 2, a: [true], nil: null };
    expect(validateMcpArguments(schema, valid)).toEqual(valid);
    for (const invalid of [{ ...valid, n: 0 }, { ...valid, n: 1.5 }, { ...valid, s: "aa" }, { ...valid, a: [] }, { ...valid, a: [1] }, { ...valid, extra: 1 }])
      expect(() => validateMcpArguments(schema, invalid)).toThrow();
  });
  test("rejects refs, regex, combinators, unknown dialect and malformed keywords", () => {
    for (const patch of [{ $ref: "#/x" }, { patternProperties: {} }, { allOf: [] }, { $schema: "http://json-schema.org/draft-07/schema#" },
      { additionalProperties: {} }, { required: ["missing"] }, { properties: { s: { type: "string", pattern: "(a+)+" } } },
      { properties: { s: { type: "string", maxLength: -1 } } }, { properties: { s: { type: "array" } } },
      { properties: { s: { type: "number", minimum: Infinity } } }, { enum: [{ x: 1 }] }])
      expect(() => validateMcpSchema({ type: "object", ...patch })).toThrow();
    expect(() => validateMcpSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'))).toThrow();
  });
  test("schema depth, nodes and bytes are independently bounded", () => {
    let nested: any = { type: "string" }; for (let n = 0; n < 10; n++) nested = { type: "object", properties: { child: nested } };
    expect(() => validateMcpSchema(nested)).toThrow();
    expect(() => validateMcpSchema({ type: "object", properties: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p${i}`, { type: "string" }])) })).toThrow();
    expect(() => validateMcpSchema({ type: "object", properties: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(2048) }])) })).toThrow();
  });
  test("oversized strings and property names fail before allocating serialized JSON", () => {
    const schema = validateMcpSchema({ type: "object" });
    const original = JSON.stringify;
    const stringify = spyOn(JSON, "stringify");
    try {
      for (const value of [{ text: "x".repeat(MCP_LIMITS.argumentBytes + 1) },
        { ["x".repeat(MCP_LIMITS.argumentBytes + 1)]: true },
        { a: "x".repeat(9000), b: "x".repeat(9000) }]) {
        expect(() => validateMcpArguments(schema, value)).toThrow();
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
    expect(JSON.stringify).toBe(original);
  });
  test("arguments reject non-JSON, cycles, dangerous keys, oversized bytes/depth/nodes without invoking hooks", () => {
    const schema = validateMcpSchema({ type: "object" });
    let hooked = false; const cyclic: any = {}; cyclic.x = cyclic;
    let deep: any = {}; for (let n = 0; n < 10; n++) deep = { x: deep };
    for (const value of [{ x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n }, { x: () => {} }, { x: new Date() }, cyclic, deep,
      { x: "x".repeat(16 * 1024) }, { x: Array(257).fill(null) }, JSON.parse('{"constructor":1}'),
      { get x() { hooked = true; return 1; } }, { toJSON() { hooked = true; return {}; } }, { x: Array(2) }])
      expect(() => validateMcpArguments(schema, value)).toThrow();
    expect(hooked).toBe(false);
  });
});

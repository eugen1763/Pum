import { describe, test, expect, spyOn } from "bun:test";
import { LspProtocolClient, LSP_LIMITS, type LspProtocolOptions } from "../src/lsp-protocol";
import type { McpSpawnRequest } from "../src/mcp-protocol";
const config = { cwd: "/fake/project", executable: "/fake/server", args: [] };
const uri = "file:///fake/project/a.py";
const init = { capabilities: { textDocumentSync: { openClose: true, change: 1 },
  diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } };
const item = { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, message: "🌊 problem" };
const frame = (value: unknown) => { const body = JSON.stringify(value); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; };
function fake(options: LspProtocolOptions = {}, respond?: (m: any, reply: (value: unknown) => void) => void) {
  let request!: McpSpawnRequest, killed = 0, closed = 0;
  let exit!: () => void, crash!: () => void;
  let broken = false, hung = false;
  const sent: any[] = [];
  const emit = (value: unknown) => request.onStdout(frame(value));
  const connected = LspProtocolClient.connect(req => {
    request = req;
    return { write: async data => {
      if (broken) throw new Error("SECRET");
      if (hung) return new Promise<void>(() => {});
      const [header, ...parts] = data.split("\r\n\r\n");
      const body = parts.join("\r\n\r\n");
      expect(header).toBe(`Content-Length: ${Buffer.byteLength(body)}`);
      const m = JSON.parse(body); sent.push(m);
      const reply = (result: unknown) => emit({ jsonrpc: "2.0", id: m.id, result });
      if (respond) respond(m, reply);
      else if (m.method === "initialize") reply(init);
      else if (m.method === "textDocument/diagnostic") reply({ kind: "full", items: [item] });
      else if (m.method === "shutdown") reply(null);
    }, close() { closed++; }, kill() { killed++; }, completed: new Promise<void>((resolve, reject) => {
      exit = resolve; crash = () => reject(new Error("SECRET"));
    }) };
  }, config, options);
  return { connected, sent, emit, raw: (data: string | Uint8Array) => request.onStdout(data),
    stderr: (data: string) => request.onStderr(data), exit: () => exit(), crash: () => crash(),
    breakWrites: () => { broken = true; }, hangWrites: () => { hung = true; },
    get killed() { return killed; }, get closed() { return closed; } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function shortTimers() {
  const original = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms: number, ...args: any[]) => original(fn, Math.min(ms, 15), ...args)) as typeof setTimeout);
}
describe("document-only LSP 3.17", () => {
  test("initialize, Python open/full change, switch close/open, uncached pulls, shutdown/exit", async () => {
    let closed = 0;
    const f = fake({ onClose: () => { closed++; } }); const c = await f.connected;
    expect(f.sent[0].params.capabilities.general.positionEncodings).toEqual(["utf-16"]);
    expect(f.sent[0].params.capabilities.textDocument.diagnostic.relatedDocumentSupport).toBe(false);
    expect(f.sent[1]).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(await c.diagnostics(uri, "🌊", 1)).toEqual([{ line: 0, character: 2, severity: 1, message: "🌊 problem" }]);
    await c.diagnostics(uri, "different", 2);
    await c.diagnostics(uri.replace("a.py", "b.py"), "", 1);
    expect(f.sent[2].params.textDocument).toEqual({ uri, text: "🌊", version: 1, languageId: "python" });
    expect(f.sent[4].params).toEqual({ textDocument: { uri, version: 2 }, contentChanges: [{ text: "different" }] });
    expect(f.sent.filter(m => m.method === "textDocument/diagnostic").every(m => !Object.hasOwn(m.params, "previousResultId"))).toBe(true);
    await c.close(); await c.close();
    expect(f.sent.map(m => m.method)).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/diagnostic",
      "textDocument/didChange", "textDocument/diagnostic", "textDocument/didClose", "textDocument/didOpen", "textDocument/diagnostic",
      "textDocument/didClose", "shutdown", "exit"]);
    expect(f.killed).toBe(1); expect(f.closed).toBe(1); expect(closed).toBe(1);
    await expect(c.diagnostics(uri, "", 3)).rejects.toThrow();
  });
  test("legacy full sync and identifier supported", async () => {
    const f = fake({}, (m, reply) => {
      if (m.method === "initialize") reply({ capabilities: { ...init.capabilities, positionEncoding: "utf-16", textDocumentSync: 1,
        diagnosticProvider: { ...init.capabilities.diagnosticProvider, identifier: "lint" } } });
      if (m.method === "textDocument/diagnostic") reply({ kind: "full", resultId: "never cached", items: [] });
      if (m.method === "shutdown") reply(null);
    });
    const c = await f.connected; await c.diagnostics(uri, "", 1);
    expect(f.sent.at(-1).params.identifier).toBe("lint"); await c.close();
  });
  test("unsupported or incomplete capabilities fail closed", async () => {
    for (const change of [{ textDocumentSync: 2 }, { textDocumentSync: { change: 1 } }, { textDocumentSync: 0 },
      { positionEncoding: "utf-8" }, { positionEncoding: null }, { diagnosticProvider: true }, { diagnosticProvider: {} },
      { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } },
      { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: true } },
      { diagnosticProvider: { ...init.capabilities.diagnosticProvider, documentSelector: [] } }]) {
      const f = fake({}, (m, reply) => { if (m.method === "initialize") reply({ capabilities: { ...init.capabilities, ...change } }); });
      await expect(f.connected).rejects.toThrow("LSP connection failed"); expect(f.killed).toBe(1); expect(f.sent).toHaveLength(1);
    }
  });
  test("bytewise headers/body and split UTF8, multiple frames and content type", async () => {
    let pull: any;
    const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "textDocument/diagnostic") pull = m; if (m.method === "shutdown") reply(null); });
    const c = await f.connected; const p = c.diagnostics(uri, "", 1); await tick();
    const data = Buffer.from(frame({ jsonrpc: "2.0", id: pull.id, result: { kind: "full", items: [item] } }).replace("Content-Length", "Content-Type: application/vscode-jsonrpc; charset=utf8\r\nContent-Length"));
    const allocation = spyOn(Buffer, "allocUnsafe"), concat = spyOn(Buffer, "concat");
    try {
      for (const byte of data) f.raw(new Uint8Array([byte]));
      expect(allocation.mock.calls.length).toBe(1); expect(concat).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); concat.mockRestore(); }
    expect((await p)[0]!.message).toBe("🌊 problem");
    f.raw(frame({ jsonrpc: "2.0", method: "window/logMessage" }) + frame({ jsonrpc: "2.0", method: "telemetry/event" }));
    expect(f.killed).toBe(0); await c.close();
  });
  test("malformed headers, oversized/invalid UTF8/JSON frames fail closed", async () => {
    for (const raw of ["Content-Length: 0\r\n\r\n", "Content-Length: -1\r\n\r\n", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
      "X: 3\r\n\r\n{}", "Content-Length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=latin1\r\n\r\n{}",
      `Content-Length: ${LSP_LIMITS.frameBytes + 1}\r\n\r\n`, "x".repeat(LSP_LIMITS.headerBytes + 1),
      Buffer.concat([Buffer.from("Content-Length: 1\r\n\r\n"), Buffer.from([255])]), frame([]), frame(null), "Content-Length: 1\r\n\r\nx"]) {
      const f = fake(); const c = await f.connected; f.raw(raw); expect(f.killed).toBe(1); await c.close();
    }
  });
  test("unknown/string/duplicate IDs and malformed responses cannot revive a result", async () => {
    for (const variant of ["unknown", "string", "duplicate", "both", "error", "params"]) {
      let pull: any;
      const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "textDocument/diagnostic") pull = m; });
      const c = await f.connected, p = c.diagnostics(uri, "", 1); await tick();
      const value = { jsonrpc: "2.0", id: pull.id, result: { kind: "full", items: [] } };
      if (variant === "duplicate") f.raw(frame(value) + frame(value));
      else if (variant === "unknown") f.emit({ ...value, id: 999 });
      else if (variant === "string") f.emit({ ...value, id: String(value.id) });
      else if (variant === "both") f.emit({ ...value, error: { code: 1, message: "SECRET" } });
      else if (variant === "params") f.emit({ ...value, params: {} });
      else f.emit({ jsonrpc: "2.0", id: value.id, error: { code: -32802, message: "SECRET" } });
      await expect(p).rejects.toThrow("LSP diagnostics failed"); expect(f.killed).toBe(1);
    }
  });
  test("server requests reject without execution; refresh signals invalidation; push fails closed", async () => {
    let refreshes = 0;
    const f = fake({ onDiagnosticsRefresh: () => { refreshes++; } }), c = await f.connected;
    expect(f.sent[0].params.capabilities.workspace.diagnostics).toBeUndefined();
    for (const method of ["workspace/applyEdit", "workspace/configuration", "client/registerCapability", "client/unregisterCapability", "workspace/diagnostic/refresh", "window/showDocument"]) {
      f.emit({ jsonrpc: "2.0", id: method, method, params: { untrusted: "ignored" } }); await tick();
      expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: method, error: { code: -32601, message: "Method not found" } });
    }
    expect(refreshes).toBe(1);
    const sent = f.sent.length;
    f.emit({ jsonrpc: "2.0", method: "workspace/diagnostic/refresh" });
    expect(refreshes).toBe(2); expect(f.sent).toHaveLength(sent);
    f.emit({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [item] } });
    expect(f.killed).toBe(1); await c.close();
  });
  test("only full own-document bounded diagnostics projected; terminal text sanitized", async () => {
    const f = fake({}, (m, reply) => {
      if (m.method === "initialize") reply(init);
      if (m.method === "textDocument/diagnostic") reply({ kind: "full", items: [{ ...item, severity: 4,
        message: "\x1b[31mred\x1b[0m\n\u202e🌊" + "🌊".repeat(2000), data: "SECRET", source: "SECRET", relatedInformation: [{ location: "SECRET" }] }] });
      if (m.method === "shutdown") reply(null);
    });
    const c = await f.connected, result = await c.diagnostics(uri, "", 1);
    expect(Object.keys(result[0]!)).toEqual(["line", "character", "severity", "message"]);
    expect(result[0]!.message.startsWith("red  🌊")).toBe(true); expect(result[0]!.message).not.toContain("\ufffd");
    expect(Buffer.byteLength(result[0]!.message)).toBeLessThanOrEqual(LSP_LIMITS.messageBytes); await c.close();
  });
  test("unsupported reports, invalid ranges/severity and result bounds reject atomically", async () => {
    for (const report of [{ kind: "unchanged", resultId: "old" }, { kind: "full", items: [], relatedDocuments: {} },
      { kind: "full", items: Array(LSP_LIMITS.diagnostics + 1).fill(item) },
      ...[{ ...item, severity: 0 }, { ...item, message: null }, { ...item, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } },
        { ...item, range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } } }].map(bad => ({ kind: "full", items: [bad] })),
      { kind: "full", items: Array(50).fill({ ...item, message: "x".repeat(1024) }) }]) {
      const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); if (m.method === "textDocument/diagnostic") reply(report); });
      const c = await f.connected; await expect(c.diagnostics(uri, "", 1)).rejects.toThrow(); expect(f.killed).toBe(1);
    }
  });
  test("byte/message/stderr/write floods are bounded", async () => {
    for (const mode of ["bytes", "messages", "stderr", "writes"]) {
      const f = fake(), c = await f.connected;
      if (mode === "stderr") f.stderr("x".repeat(LSP_LIMITS.stderrBytes + 1));
      else if (mode === "writes") { f.hangWrites(); for (let i = 0; i < 10; i++) f.emit({ jsonrpc: "2.0", id: i, method: "x" }); }
      else {
        const data = frame({ jsonrpc: "2.0", method: "window/logMessage", params: { text: mode === "bytes" ? "x".repeat(240_000) : "" } });
        for (let i = 0; i < (mode === "bytes" ? 72 : LSP_LIMITS.messages + 1); i++) f.raw(data);
      }
      expect(f.killed).toBe(1); await c.close();
    }
  });
  test("timeouts cover startup, stalled document write, pull and shutdown", async () => {
    const timer = shortTimers();
    try {
      const startup = fake({}, () => {}); await expect(startup.connected).rejects.toThrow(); expect(startup.killed).toBe(1);
      for (const mode of ["write", "pull", "shutdown", "response-write"]) {
        const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); }); const c = await f.connected;
        if (mode === "write") f.hangWrites();
        if (mode === "shutdown") await c.close();
        else if (mode === "response-write") {
          f.hangWrites(); f.emit({ jsonrpc: "2.0", id: "request", method: "workspace/applyEdit" });
          await new Promise<void>(resolve => setTimeout(resolve, 100));
        } else await expect(c.diagnostics(uri, "", 1)).rejects.toThrow();
        expect(f.killed).toBe(1);
      }
    } finally { timer.mockRestore(); }
  });
  test("aborts (including post-response microtask), exit and write failures revoke once", async () => {
    for (const mode of ["preabort", "abort", "post", "exit", "crash", "write"]) {
      const signal = new AbortController(); let closed = 0;
      const f = fake({ onClose: () => { closed++; throw new Error("observer"); } }, (m, reply) => {
        if (m.method === "initialize") reply(init);
        if (mode === "post" && m.method === "textDocument/diagnostic") { reply({ kind: "full", items: [] }); signal.abort(); }
      });
      const c = await f.connected;
      if (mode === "preabort") signal.abort();
      if (mode === "write") f.breakWrites();
      const p = c.diagnostics(uri, "", 1, signal.signal); await tick();
      if (mode === "abort") signal.abort();
      if (mode === "exit") f.exit();
      if (mode === "crash") f.crash();
      await expect(p).rejects.toThrow(); await c.close(); expect(f.killed).toBe(1); expect(closed).toBe(1);
    }
  });
  test("startup abort prevents spawn; late spawn completion is disposed", async () => {
    const signal = new AbortController(); signal.abort(); let spawned = 0;
    await expect(LspProtocolClient.connect(() => { spawned++; throw Error(); }, config, { signal: signal.signal })).rejects.toThrow(); expect(spawned).toBe(0);
    const timer = shortTimers(); let resolve!: (handle: any) => void, killed = 0;
    try {
      const p = LspProtocolClient.connect(() => new Promise(r => { resolve = r; }), config);
      await expect(p).rejects.toThrow();
      resolve({ write: async () => {}, close() {}, kill() { killed++; }, completed: Promise.resolve() }); await tick();
      expect(killed).toBe(1);
    } finally { timer.mockRestore(); }
  });
  test("lifetime abort after startup and synchronous spawn failure notify once", async () => {
    const abort = new AbortController(); let notices = 0;
    const f = fake({ signal: abort.signal, onClose: () => { notices++; } }); const c = await f.connected;
    abort.abort(); await c.close(); expect(f.killed).toBe(1); expect(notices).toBe(1);
    notices = 0;
    await expect(LspProtocolClient.connect(() => { throw Error("SECRET"); }, config,
      { onClose: () => { notices++; } })).rejects.toThrow("LSP connection failed");
    expect(notices).toBe(1);
  });
  test("concurrent calls cannot change active document; invalid input/version fails closed", async () => {
    const f = fake({}, (m, reply) => { if (m.method === "initialize") reply(init); }); const c = await f.connected;
    const p = c.diagnostics(uri, "", 1);
    await expect(c.diagnostics(uri, "different", 2)).rejects.toThrow("unavailable");
    await c.close(); await expect(p).rejects.toThrow(); expect(f.killed).toBe(1);
    for (const mode of ["size", "version", "uri"]) {
      const f = fake(), c = await f.connected; await c.diagnostics(uri, "", 1);
      await expect(c.diagnostics(mode === "uri" ? "https://bad" : uri, mode === "size" ? "x".repeat(LSP_LIMITS.documentBytes + 1) : "", mode === "version" ? 1 : 2)).rejects.toThrow();
      expect(f.killed).toBe(1);
    }
  });
});

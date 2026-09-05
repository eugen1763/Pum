/** Deliberately narrow LSP 3.17 stdio client. Reviewed official 3.17 base protocol,
 * initialize/initialized/shutdown/exit, didOpen/didChange/didClose, positions,
 * diagnostics and pullDiagnostics in full. No workspace, push, edits or caching.
 * The controller owns path authorization and snapshot/generation freshness.
 */
import { pathToFileURL } from "node:url";
import type { McpSpawn, McpProcessHandle, McpLaunchConfig } from "./mcp-protocol";

export const LSP_LIMITS = Object.freeze({ headerBytes: 1024, frameBytes: 256 * 1024,
  stdoutBytes: 16 * 1024 * 1024, stderrBytes: 1024 * 1024, messages: 4096,
  documentBytes: 128 * 1024, diagnostics: 100, messageBytes: 1024, resultBytes: 32 * 1024,
  startupMs: 10_000, requestMs: 15_000, shutdownMs: 500, writes: 8 });
export interface LspDiagnostic { line: number; character: number; severity: 1 | 2 | 3 | 4; message: string }
export interface LspProtocolOptions { signal?: AbortSignal; onClose?(reason: string): void; onDiagnosticsRefresh?(): void }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (v: object, k: string) => Object.hasOwn(v, k);
const invalid = () => new Error("LSP data is invalid or unsupported.");
const uint = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;
const safeText = (v: unknown, max: number): v is string => typeof v === "string" && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
function sanitize(text: string): string {
  // Strip complete terminal escapes, then controls, bidi overrides and line breaks.
  const clean = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, " ");
  let result = "", size = 0;
  for (const char of clean) { size += Buffer.byteLength(char); if (size > LSP_LIMITS.messageBytes) break; result += char; }
  return result;
}
function diagnosticsResult(value: unknown): LspDiagnostic[] {
  if (!object(value) || value.kind !== "full" || own(value, "relatedDocuments") || !Array.isArray(value.items) ||
    value.items.length > LSP_LIMITS.diagnostics) throw invalid();
  let size = 0;
  return value.items.map(item => {
    if (!object(item) || !object(item.range) || !object(item.range.start) || !object(item.range.end) || typeof item.message !== "string") throw invalid();
    const start = item.range.start, end = item.range.end;
    if (!uint(start.line) || !uint(start.character) || !uint(end.line) || !uint(end.character) ||
      end.line < start.line || (end.line === start.line && end.character < start.character)) throw invalid();
    const severity = own(item, "severity") ? item.severity : 1;
    if (severity !== 1 && severity !== 2 && severity !== 3 && severity !== 4) throw invalid();
    const result = { line: start.line, character: start.character, severity, message: sanitize(item.message) };
    size += Buffer.byteLength(JSON.stringify(result));
    if (size > LSP_LIMITS.resultBytes) throw invalid();
    return result as LspDiagnostic;
  });
}
interface Pending { id: number; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
export class LspProtocolClient {
  private handle?: McpProcessHandle;
  private closed = false;
  private closing = false;
  private ready = false;
  private notified = false;
  private closePromise?: Promise<void>;
  private lifetime = new AbortController();
  private detach?: () => void;
  private pending?: Pending;
  private nextId = 1;
  private busy = false;
  private document?: { uri: string; version: number };
  private identifier?: string;
  private header: number[] = [];
  private body?: Buffer;
  private bodyOffset = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private messages = 0;
  private writes = 0;
  private constructor(private options: LspProtocolOptions) {}

  static async connect(spawn: McpSpawn, request: McpLaunchConfig, options: LspProtocolOptions = {}): Promise<LspProtocolClient> {
    const client = new LspProtocolClient(options);
    const abort = () => client.fail("LSP connection cancelled.");
    options.signal?.addEventListener("abort", abort, { once: true });
    client.detach = () => options.signal?.removeEventListener("abort", abort);
    try {
      await client.bounded(async () => {
        if (options.signal?.aborted) { abort(); throw invalid(); }
        const handle = await spawn({ ...request, args: [...request.args], signal: client.lifetime.signal,
          onStdout: chunk => client.receive(chunk), onStderr: chunk => {
            if (client.closed) return;
            client.stderrBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
            if (client.stderrBytes > LSP_LIMITS.stderrBytes) client.fail("LSP stderr limit exceeded.");
          } });
        if (client.closed) { client.dispose(handle); throw invalid(); }
        client.handle = handle;
        void handle.completed.then(() => client.fail("LSP server exited."), () => client.fail("LSP server exited."));
        const result = await client.request("initialize", { processId: null, rootUri: pathToFileURL(request.cwd).href,
          clientInfo: { name: "pum" }, capabilities: { general: { positionEncodings: ["utf-16"] },
            workspace: { applyEdit: false, configuration: false, workspaceFolders: false },
            textDocument: { synchronization: { dynamicRegistration: false }, diagnostic: {
              dynamicRegistration: false, relatedDocumentSupport: false, relatedInformation: false } } } });
        if (!object(result) || !object(result.capabilities)) throw invalid();
        const caps = result.capabilities, sync = caps.textDocumentSync, diag = caps.diagnosticProvider;
        if ((own(caps, "positionEncoding") && caps.positionEncoding !== "utf-16") ||
          !(sync === 1 || (object(sync) && sync.change === 1 && sync.openClose === true)) ||
          !object(diag) || diag.interFileDependencies !== false || diag.workspaceDiagnostics !== false ||
          own(diag, "documentSelector") || own(diag, "id")) throw invalid();
        if (own(diag, "identifier")) {
          if (!safeText(diag.identifier, 128)) throw invalid();
          client.identifier = diag.identifier;
        }
        await client.notify("initialized", {});
        client.assertOpen(); client.ready = true;
      }, LSP_LIMITS.startupMs);
      return client;
    } catch { client.fail("LSP connection failed."); throw new Error("LSP connection failed."); }
  }
  private assertOpen(): void { if (this.closed || !this.handle) throw new Error("LSP connection closed."); }
  private notifyClosed(reason: string): void {
    if (this.notified) return;
    this.notified = true;
    try { this.options.onClose?.(reason); } catch { /* observer cannot prevent cleanup */ }
  }
  private dispose(handle: McpProcessHandle): void {
    try { handle.close(); } catch { /* best effort */ }
    try { handle.kill(); } catch { /* best effort */ }
    void handle.completed.catch(() => {});
  }
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.document = undefined; this.body = undefined; this.header = [];
    this.detach?.();
    const pending = this.pending; this.pending = undefined;
    pending?.cleanup(); pending?.reject(new Error(reason));
    this.lifetime.abort();
    if (this.handle) this.dispose(this.handle);
    this.notifyClosed(reason);
  }
  /** Revokes immediately; idle sessions get bounded shutdown/exit before forced cleanup. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed || this.closing) return Promise.resolve();
    this.closing = true; this.notifyClosed("LSP connection closed.");
    if (!this.ready || this.busy || this.pending) { this.fail("LSP connection closed."); return Promise.resolve(); }
    this.closePromise = this.bounded(async () => {
      if (this.document) await this.notify("textDocument/didClose", { textDocument: { uri: this.document.uri } });
      const result = await this.request("shutdown");
      if (result !== null) throw invalid();
      await this.notify("exit");
    }, LSP_LIMITS.shutdownMs).catch(() => {}).finally(() => this.fail("LSP connection closed."));
    return this.closePromise;
  }
  private async bounded<T>(work: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => this.fail("LSP request cancelled.");
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("LSP connection closed."));
      this.lifetime.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(() => this.fail("LSP request timed out."), ms);
    });
    void stopped.catch(() => {}); // pre-abort can reject before the race is installed
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      if (this.closed) throw invalid();
      const value = await Promise.race([work(), stopped]);
      if (signal?.aborted) abort();
      if (this.closed) throw invalid();
      return value;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", stop); }
  }
  private async send(value: unknown): Promise<void> {
    this.assertOpen();
    if (this.writes >= LSP_LIMITS.writes) { this.fail("LSP write limit exceeded."); throw invalid(); }
    this.writes++;
    try {
      const body = JSON.stringify(value), length = Buffer.byteLength(body);
      if (length > LSP_LIMITS.frameBytes) throw invalid();
      await this.bounded(() => this.handle!.write(`Content-Length: ${length}\r\n\r\n${body}`), LSP_LIMITS.requestMs);
      this.assertOpen();
    } catch { this.fail("LSP transport failed."); throw new Error("LSP transport failed."); }
    finally { this.writes--; }
  }
  private notify(method: string, params?: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }
  private request(method: string, params?: unknown): Promise<unknown> {
    this.assertOpen();
    if (this.pending || this.nextId > 0x7fffffff) throw invalid();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("LSP request timed out."), LSP_LIMITS.requestMs);
      this.pending = { id, resolve, reject, cleanup: () => clearTimeout(timer) };
      void this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch(() => {});
    });
  }
  private receive(chunk: Uint8Array | string): void {
    if (this.closed) return;
    try {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.stdoutBytes += data.byteLength;
      if (this.stdoutBytes > LSP_LIMITS.stdoutBytes) throw invalid();
      let offset = 0;
      while (offset < data.length && !this.closed) {
        if (!this.body) {
          const byte = data[offset++]!;
          if (byte > 127 || this.header.length >= LSP_LIMITS.headerBytes) throw invalid();
          this.header.push(byte);
          const n = this.header.length;
          if (n < 4 || this.header[n - 4] !== 13 || this.header[n - 3] !== 10 || this.header[n - 2] !== 13 || byte !== 10) continue;
          const fields = Buffer.from(this.header).toString("ascii").slice(0, -4).split("\r\n");
          let length: number | undefined; let contentType = false;
          for (const field of fields) {
            const match = /^([^:]+):[ \t]*(.+)$/.exec(field);
            if (!match) throw invalid();
            if (match[1]!.toLowerCase() === "content-length") {
              if (length !== undefined || !/^[1-9][0-9]*$/.test(match[2]!)) throw invalid();
              length = Number(match[2]);
              if (!Number.isSafeInteger(length) || length > LSP_LIMITS.frameBytes) throw invalid();
            } else if (match[1]!.toLowerCase() === "content-type") {
              if (contentType || !/^application\/vscode-jsonrpc(?:;[ \t]*charset=utf-?8)?$/i.test(match[2]!)) throw invalid();
              contentType = true;
            } else throw invalid();
          }
          if (length === undefined) throw invalid();
          this.body = Buffer.allocUnsafe(length); this.bodyOffset = 0; this.header = [];
        } else {
          const count = Math.min(this.body.length - this.bodyOffset, data.length - offset);
          this.body.set(data.subarray(offset, offset + count), this.bodyOffset);
          offset += count; this.bodyOffset += count;
          if (this.bodyOffset === this.body.length) {
            const body = this.body; this.body = undefined;
            if (++this.messages > LSP_LIMITS.messages) throw invalid();
            this.message(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
          }
        }
      }
    } catch { this.fail("LSP protocol failed."); }
  }
  private message(value: unknown): void {
    if (!object(value) || value.jsonrpc !== "2.0") throw invalid();
    if (own(value, "method")) {
      if (!safeText(value.method, 256) || own(value, "result") || own(value, "error") ||
        (own(value, "params") && !object(value.params) && !Array.isArray(value.params))) throw invalid();
      if (own(value, "id")) {
        if (!(safeText(value.id, 128) || (typeof value.id === "number" && Number.isInteger(value.id) && value.id >= -0x80000000 && value.id <= 0x7fffffff))) throw invalid();
        void this.send({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Method not found" } }).catch(() => {});
      } else if (value.method === "textDocument/publishDiagnostics") throw invalid();
      // Refresh is not advertised/supported, but is explicit evidence that a
      // cached or pending report may be stale. Invalidate synchronously, before
      // processing another frame (including a late pull result) in this chunk.
      if (value.method === "workspace/diagnostic/refresh") this.options.onDiagnosticsRefresh?.();
      // Logs, telemetry and other unknown notifications are inert, bounded and never retained.
      return;
    }
    if (!uint(value.id) || own(value, "params") || own(value, "result") === own(value, "error") || this.pending?.id !== value.id) throw invalid();
    if (own(value, "error")) throw invalid(); // Never expose server-supplied errors or retry automatically.
    const pending = this.pending; this.pending = undefined;
    pending.cleanup(); pending.resolve(value.result);
  }
  async diagnostics(uri: string, text: string, version: number, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    this.assertOpen();
    if (!this.ready || this.closing || this.busy) throw new Error("LSP diagnostics unavailable.");
    this.busy = true;
    try {
      return await this.bounded(async () => {
        if (!safeText(uri, 8192) || !uri.startsWith("file://") || typeof text !== "string" ||
          Buffer.byteLength(text) > LSP_LIMITS.documentBytes || !uint(version)) throw invalid();
        if (this.document?.uri === uri && version <= this.document.version) throw invalid();
        if (this.document && this.document.uri !== uri) {
          await this.notify("textDocument/didClose", { textDocument: { uri: this.document.uri } });
          this.document = undefined;
        }
        if (!this.document) await this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version, text } });
        else await this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
        this.document = { uri, version };
        const result = await this.request("textDocument/diagnostic", { textDocument: { uri },
          ...(this.identifier === undefined ? {} : { identifier: this.identifier }) });
        return diagnosticsResult(result);
      }, LSP_LIMITS.requestMs, signal);
    } catch { this.fail("LSP diagnostics failed."); throw new Error("LSP diagnostics failed."); }
    finally { this.busy = false; }
  }
}

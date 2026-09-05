/** Bounded, tools-only stdio subset of MCP 2025-11-25. No network or schema code generation.
 * Reviewed: official specification/{2025-11-25}/{basic,basic/transports,
 * basic/lifecycle,basic/utilities/cancellation,server/tools}.
 * This deliberately rejects unsupported JSON Schema keywords rather than claiming full coverage.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_LIMITS = Object.freeze({ frameBytes: 256 * 1024, stdoutBytes: 16 * 1024 * 1024,
  discoveryBytes: 256 * 1024, tools: 32, pages: 4, schemaBytes: 16 * 1024,
  argumentBytes: 16 * 1024, resultBytes: 16 * 1024, resultLines: 200,
  depth: 8, nodes: 256, inFlight: 4, startupMs: 10_000, callMs: 30_000 });
export type McpSchema = { type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string; title?: string; $schema?: string; properties?: Record<string, McpSchema>;
  required?: string[]; additionalProperties?: boolean; items?: McpSchema;
  enum?: (string | number | boolean | null)[]; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number };
export interface McpTool { name: string; description?: string; inputSchema: McpSchema }
export interface McpToolResult { text: string; isError: boolean }
export interface McpProcessHandle { write(data: string): Promise<void>; close(): void; kill(): void; completed: Promise<unknown> }
export interface McpLaunchConfig { executable: string; args: string[]; cwd: string }
export interface McpSpawnRequest extends McpLaunchConfig { onStdout(chunk: Uint8Array | string): void;
  onStderr(chunk: Uint8Array | string): void; signal?: AbortSignal }
export type McpSpawn = (request: McpSpawnRequest) => McpProcessHandle | Promise<McpProcessHandle>;
export interface McpProtocolOptions { signal?: AbortSignal; onClose?(reason: string): void; onToolsChanged?(): void }
const badKeys = new Set(["__proto__", "prototype", "constructor"]);
const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const fail = () => new Error("MCP data is invalid or unsupported.");
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const textField = (value: unknown, max = 2048): value is string => typeof value === "string" && bytes(value) <= max && !controls.test(value);

/** Walk before stringify: excludes cycles, getters, toJSON hooks, non-JSON values and excessive structure. */
function jsonData(value: unknown, maxBytes: number, depthLimit: number = MCP_LIMITS.depth, nodeLimit: number = MCP_LIMITS.nodes): string {
  let nodes = 0;
  let payloadBytes = 0;
  const countText = (text: string): void => {
    payloadBytes += bytes(text);
    if (payloadBytes > maxBytes) throw fail();
  };
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (++nodes > nodeLimit || depth > depthLimit) throw fail();
    if (typeof v === "string") { countText(v); return; }
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || v === null || seen.has(v)) throw fail();
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && !(Array.isArray(v) && proto === Array.prototype)) throw fail();
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v).some(k => typeof k !== "string")) throw fail();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === "length") continue;
      if (badKeys.has(key) || !own(descriptor, "value") || !descriptor.enumerable) throw fail();
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) throw fail();
      if (!Array.isArray(v)) countText(key);
      walk(descriptor.value, depth + 1);
    }
    if (Array.isArray(v) && Object.keys(descriptors).length !== v.length + 1) throw fail();
    seen.delete(v);
  };
  walk(value, 0);
  const serialized = JSON.stringify(value);
  if (bytes(serialized) > maxBytes) throw fail();
  return serialized;
}

/** Returns a detached, validated narrow 2020-12 schema. Unknown keywords fail closed. */
export function validateMcpSchema(value: unknown): McpSchema {
  // Schema syntax has properties-map/required-array containers in addition to schema depth.
  const serialized = jsonData(value, MCP_LIMITS.schemaBytes, 24, 2048);
  let nodes = 0;
  const check = (v: unknown, depth: number): void => {
    if (!record(v) || ++nodes > MCP_LIMITS.nodes || depth > MCP_LIMITS.depth) throw fail();
    const common = ["type", "description", "title", "$schema", "enum"];
    const byType: Record<string, string[]> = { object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"],
      string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] };
    if (typeof v.type !== "string" || !own(byType, v.type)) throw fail();
    if (Object.keys(v).some(key => !common.includes(key) && !byType[v.type as string]!.includes(key))) throw fail();
    for (const field of ["description", "title"]) if (own(v, field) && !textField(v[field])) throw fail();
    if (own(v, "$schema") && (depth !== 0 || v.$schema !== "https://json-schema.org/draft/2020-12/schema")) throw fail();
    if (own(v, "enum")) {
      if (!Array.isArray(v.enum) || !v.enum.length || v.enum.length > 64) throw fail();
      const unique = new Set<string>();
      for (const item of v.enum) {
        if (item !== null && !["string", "number", "boolean"].includes(typeof item)) throw fail();
        if (!matchesType(v.type, item) || unique.has(JSON.stringify(item))) throw fail();
        unique.add(JSON.stringify(item));
      }
    }
    if (v.type === "object") {
      if (own(v, "properties")) {
        if (!record(v.properties)) throw fail();
        for (const [key, child] of Object.entries(v.properties)) {
          if (!textField(key, 128) || !key || badKeys.has(key)) throw fail();
          check(child, depth + 1);
        }
      }
      if (own(v, "required")) {
        if (!Array.isArray(v.required) || new Set(v.required).size !== v.required.length) throw fail();
        for (const key of v.required) if (typeof key !== "string" || !record(v.properties) || !own(v.properties, key)) throw fail();
      }
      if (own(v, "additionalProperties") && typeof v.additionalProperties !== "boolean") throw fail();
    }
    if (v.type === "array") {
      if (!own(v, "items")) throw fail();
      check(v.items, depth + 1);
    }
    for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]] as const) {
      for (const key of [min, max]) if (own(v, key) && (typeof v[key] !== "number" || !Number.isFinite(v[key]) ||
        (key !== "minimum" && key !== "maximum" && (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0)))) throw fail();
      if (own(v, min) && own(v, max) && (v[min] as number) > (v[max] as number)) throw fail();
    }
  };
  check(value, 0);
  if (!record(value) || value.type !== "object") throw fail();
  return JSON.parse(serialized) as McpSchema;
}
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "object": return record(value);
    case "array": return Array.isArray(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    default: return typeof value === type;
  }
}
export function validateMcpArguments(schema: McpSchema, value: unknown): Record<string, unknown> {
  const serialized = jsonData(value, MCP_LIMITS.argumentBytes);
  const check = (s: McpSchema, v: unknown): void => {
    if (!matchesType(s.type, v) || (s.enum && !s.enum.some(item => item === v))) throw fail();
    if (typeof v === "number" && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) throw fail();
    if (typeof v === "string") {
      const length = [...v].length;
      if ((s.minLength !== undefined && length < s.minLength) || (s.maxLength !== undefined && length > s.maxLength)) throw fail();
    }
    if (Array.isArray(v)) {
      if ((s.minItems !== undefined && v.length < s.minItems) || (s.maxItems !== undefined && v.length > s.maxItems)) throw fail();
      for (const item of v) check(s.items!, item);
    } else if (record(v)) {
      for (const key of s.required ?? []) if (!own(v, key)) throw fail();
      for (const [key, item] of Object.entries(v)) {
        if (s.properties && own(s.properties, key)) check(s.properties[key]!, item);
        else if (s.additionalProperties === false) throw fail();
      }
    }
  };
  check(schema, value);
  return JSON.parse(serialized) as Record<string, unknown>;
}
function parseTool(value: unknown): McpTool {
  if (!record(value) || typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.name) || badKeys.has(value.name)) throw fail();
  if (own(value, "description") && !textField(value.description)) throw fail();
  // Required task execution cannot be fulfilled by this tools-only client.
  if (own(value, "execution") && (!record(value.execution) || (value.execution.taskSupport !== undefined &&
    !["optional", "forbidden"].includes(value.execution.taskSupport as string)))) throw fail();
  return { name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}), inputSchema: validateMcpSchema(value.inputSchema) };
}
function resultText(name: string, value: unknown): McpToolResult {
  if (!record(value) || !Array.isArray(value.content) || (own(value, "isError") && typeof value.isError !== "boolean")) throw fail();
  const pieces: string[] = [];
  let omitted = own(value, "structuredContent");
  for (const block of value.content) {
    if (!record(block) || typeof block.type !== "string") throw fail();
    if (block.type !== "text") { omitted = true; continue; }
    if (typeof block.text !== "string") throw fail();
    pieces.push(block.text);
  }
  const prefix = `[MCP tool ${name}: untrusted server output]\n`;
  const marker = "\n[MCP output truncated or unsupported content omitted]";
  const original = pieces.join("\n").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
  const lines = original.split("\n");
  let body = lines.slice(0, MCP_LIMITS.resultLines - 2).join("\n");
  omitted ||= lines.length > MCP_LIMITS.resultLines - 2;
  const budget = MCP_LIMITS.resultBytes - bytes(prefix) - bytes(marker);
  if (bytes(body) > budget) {
    let length = 0;
    const chars: string[] = [];
    for (const char of body) { const size = bytes(char); if (length + size > budget) break; chars.push(char); length += size; }
    body = chars.join(""); omitted = true;
  }
  return { text: prefix + body + (omitted ? marker : ""), isError: value.isError === true };
}
interface Pending { method: string; resolve(value: { result: unknown; size: number }): void; reject(error: Error): void; cleanup(): void }

export class McpProtocolClient {
  private handle?: McpProcessHandle;
  private closed = false;
  private ready = false;
  private buffer = Buffer.alloc(0);
  private bufferLength = 0;
  private stdoutBytes = 0;
  private nextId = 1;
  private writes = 0;
  private pending = new Map<number, Pending>();
  private tools = new Map<string, McpTool>();
  private listing = false;
  private lifetime = new AbortController();
  private detachSignal?: () => void;
  private constructor(private options: McpProtocolOptions) {}

  static async connect(spawn: McpSpawn, config: McpLaunchConfig, options: McpProtocolOptions = {}): Promise<McpProtocolClient> {
    const client = new McpProtocolClient(options);
    let rejectStartup!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStartup = reject; });
    const stop = () => { client.cancelPending(); client.closeWith("MCP connection cancelled."); rejectStartup(new Error("MCP connection cancelled.")); };
    const timer = setTimeout(() => { client.closeWith("MCP startup timed out."); rejectStartup(new Error("MCP startup timed out.")); }, MCP_LIMITS.startupMs);
    const signal = options.signal;
    if (signal) {
      signal.addEventListener("abort", stop, { once: true });
      client.detachSignal = () => signal.removeEventListener("abort", stop);
    }
    // The rejection race is installed even for synchronous spawn failures/early aborts.
    const start = async () => {
      if (signal?.aborted) { stop(); throw new Error("MCP connection cancelled."); }
      const handle = await spawn({ ...config, args: [...config.args], signal: client.lifetime.signal,
        onStdout: chunk => client.receive(chunk), onStderr: () => {} });
      if (client.closed) { client.disposeHandle(handle); throw new Error("MCP connection closed."); }
      client.handle = handle;
      void handle.completed.then(() => client.closeWith("MCP server exited."), () => client.closeWith("MCP server exited."));
      const { result } = await client.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pum", version: "1" } }, MCP_LIMITS.startupMs);
      if (!record(result) || result.protocolVersion !== MCP_PROTOCOL_VERSION || !record(result.capabilities) || !record(result.capabilities.tools) ||
        !record(result.serverInfo) || !textField(result.serverInfo.name) || !textField(result.serverInfo.version)) throw fail();
      await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      client.assertOpen();
      client.ready = true;
      return client;
    };
    try { return await Promise.race([start(), stopped]); }
    catch { client.closeWith("MCP connection failed."); throw new Error("MCP connection failed."); }
    finally { clearTimeout(timer); }
  }
  private assertOpen(): void { if (this.closed || !this.handle) throw new Error("MCP connection closed."); }
  private assertRequestActive(signal?: AbortSignal): void {
    // A response removes its pending listener before the awaiting caller resumes.
    // Abort in that microtask gap still withdraws the connection and its toolset.
    if (signal?.aborted && !this.closed) {
      this.cancelPending();
      this.closeWith("MCP request cancelled.");
    }
    this.assertOpen();
  }
  private disposeHandle(handle: McpProcessHandle): void {
    try { handle.close(); } catch { /* best effort */ }
    try { handle.kill(); } catch { /* best effort */ }
    void handle.completed.catch(() => {});
  }
  close(): void { this.closeWith("MCP connection closed."); }
  private cancelPending(): void {
    if (this.closed) return;
    for (const [id, request] of this.pending) {
      if (request.method !== "initialize") void this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }).catch(() => {});
    }
  }
  private closeWith(reason: string): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.buffer = Buffer.alloc(0); this.bufferLength = 0; this.tools.clear();
    this.detachSignal?.();
    for (const request of this.pending.values()) { request.cleanup(); request.reject(new Error(reason)); }
    this.pending.clear();
    this.lifetime.abort();
    if (this.handle) this.disposeHandle(this.handle);
    try { this.options.onClose?.(reason); } catch { /* observers cannot prevent cleanup */ }
  }
  private send(message: unknown): Promise<void> {
    try {
      this.assertOpen();
      if (++this.writes > 8) { this.writes--; throw fail(); }
      const result = this.handle!.write(JSON.stringify(message) + "\n");
      return Promise.resolve(result).catch(() => { this.closeWith("MCP transport failed."); throw new Error("MCP transport failed."); }).finally(() => { this.writes--; });
    } catch { this.closeWith("MCP transport failed."); return Promise.reject(new Error("MCP transport failed.")); }
  }
  private request(method: string, params: unknown, timeout: number, signal?: AbortSignal): Promise<{ result: unknown; size: number }> {
    this.assertOpen();
    if (signal?.aborted) { this.closeWith("MCP request cancelled."); return Promise.reject(new Error("MCP request cancelled.")); }
    if (this.pending.size >= MCP_LIMITS.inFlight) return Promise.reject(new Error("MCP request limit reached."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (reason: string) => {
        if (!this.pending.has(id)) return;
        this.cancelPending();
        this.closeWith(reason);
      };
      const abort = () => cancel("MCP request cancelled.");
      const timer = setTimeout(() => cancel("MCP request timed out."), timeout);
      this.pending.set(id, { method, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      signal?.addEventListener("abort", abort, { once: true });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch(() => {});
    });
  }
  private receive(chunk: Uint8Array | string): void {
    if (this.closed) return;
    try {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.stdoutBytes += data.byteLength;
      if (this.stdoutBytes > MCP_LIMITS.stdoutBytes) throw fail();
      let start = 0;
      while (start < data.length && !this.closed) {
        const newline = data.indexOf(10, start);
        const end = newline < 0 ? data.length : newline;
        const length = this.bufferLength + end - start;
        if (length > MCP_LIMITS.frameBytes) throw fail();
        // Geometric growth prevents quadratic copying from one-byte stdout chunks.
        if (length > this.buffer.length) {
          const capacity = Math.min(MCP_LIMITS.frameBytes, Math.max(length, 1024, this.buffer.length * 2));
          const grown = Buffer.allocUnsafe(capacity);
          this.buffer.copy(grown, 0, 0, this.bufferLength);
          this.buffer = grown;
        }
        data.copy(this.buffer, this.bufferLength, start, end);
        this.bufferLength = length;
        if (newline < 0) break;
        const frame = this.buffer.subarray(0, this.bufferLength);
        this.bufferLength = 0;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
        this.message(JSON.parse(text), frame.length);
        start = end + 1;
      }
    } catch { this.closeWith("MCP protocol failed."); }
  }
  private message(value: unknown, size: number): void {
    if (!record(value) || value.jsonrpc !== "2.0") throw fail();
    if (own(value, "method")) {
      if (typeof value.method !== "string" || own(value, "result") || own(value, "error") || (own(value, "params") && !record(value.params))) throw fail();
      if (own(value, "id")) {
        if (!((typeof value.id === "string" && bytes(value.id) <= 128) || (typeof value.id === "number" && Number.isSafeInteger(value.id)))) throw fail();
        void this.send(value.method === "ping" ? { jsonrpc: "2.0", id: value.id, result: {} } :
          { jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Method not found" } }).catch(() => {});
      } else if (value.method === "notifications/tools/list_changed") {
        this.closeWith("MCP tool list changed.");
        try { this.options.onToolsChanged?.(); } catch { /* closed already */ }
      }
      return;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || own(value, "result") === own(value, "error")) throw fail();
    const pending = this.pending.get(value.id);
    if (!pending) throw fail(); // unknown, mismatched, duplicate and late responses cannot revive anything
    if (own(value, "error")) {
      if (!record(value.error) || !Number.isInteger(value.error.code) || typeof value.error.message !== "string") throw fail();
      this.closeWith("MCP server request failed."); return;
    }
    if (!record(value.result)) throw fail();
    this.pending.delete(value.id); pending.cleanup(); pending.resolve({ result: value.result, size });
  }
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    this.assertOpen();
    if (!this.ready || this.listing) throw new Error("MCP discovery unavailable.");
    this.listing = true;
    const deadline = Date.now() + MCP_LIMITS.startupMs;
    try {
      const found = new Map<string, McpTool>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let size = 0;
      for (let page = 0; page < MCP_LIMITS.pages; page++) {
        if (Date.now() >= deadline) throw fail();
        const response = await this.request("tools/list", cursor === undefined ? {} : { cursor }, deadline - Date.now(), signal);
        this.assertRequestActive(signal);
        size += response.size;
        const result = response.result;
        if (size > MCP_LIMITS.discoveryBytes || !record(result) || !Array.isArray(result.tools) || result.tools.length + found.size > MCP_LIMITS.tools) throw fail();
        for (const value of result.tools) { const tool = parseTool(value); if (found.has(tool.name)) throw fail(); found.set(tool.name, tool); }
        if (!own(result, "nextCursor")) {
          this.tools = found;
          return structuredClone([...found.values()]);
        }
        if (!textField(result.nextCursor, 1024) || !result.nextCursor || cursors.has(result.nextCursor)) throw fail();
        cursor = result.nextCursor; cursors.add(cursor);
      }
      throw fail();
    } catch { this.closeWith("MCP discovery failed."); throw new Error("MCP discovery failed."); }
    finally { this.listing = false; }
  }
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    this.assertOpen();
    const tool = this.tools.get(name);
    if (!this.ready || !tool) throw new Error("MCP tool unavailable.");
    const argumentsValue = validateMcpArguments(tool.inputSchema, args);
    const response = await this.request("tools/call", { name, arguments: argumentsValue }, MCP_LIMITS.callMs, signal);
    this.assertRequestActive(signal);
    try { return resultText(name, response.result); }
    catch { this.closeWith("MCP result failed."); throw new Error("MCP result failed."); }
  }
}

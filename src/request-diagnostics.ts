import { createHmac, randomBytes } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";

/** Runtime-private observation only: never a session entry, model tool, or file. */
export const REQUEST_DIAGNOSTICS_LIMIT = 64;
const SESSION_LIMIT = 32;
const INPUT_COMPARISON_LIMIT = 2048;
const hashKey = randomBytes(32);
export type DiagnosticRole = "main" | "worker" | "readonly" | "judge" | "afk" | "unknown";
type Fingerprint = { hash: string; bytes: number };
type Prefix = "first" | "unchanged" | "append-only" | "changed" | "unavailable";
type Reason = "first-request" | "instructions-changed" | "tools-changed" | "non-input-changed"
  | "input-prefix-changed" | "input-appended" | "identical-payload" | "comparison-limited" | "after-error";
type Stats = Pick<OpenAICodexWebSocketDebugStats, "requests" | "connectionsCreated" | "connectionsReused"
  | "fullContextRequests" | "deltaRequests" | "websocketFailures" | "sseFallbacks">;
const counters = ["requests", "connectionsCreated", "connectionsReused", "fullContextRequests", "deltaRequests",
  "websocketFailures", "sseFallbacks"] as const;
type Usage = Pick<AssistantMessage["usage"], "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
export type RequestDiagnostic = {
  sequence: number;
  sessionHash: string;
  role: DiagnosticRole;
  stage: "provider-payload-before-transport";
  payload: Fingerprint | null;
  instructions: Fingerprint | null;
  tools: Fingerprint | null;
  nonInput: Fingerprint | null;
  input: (Fingerprint & { items: number; prefix: Prefix }) | null;
  reasons: Reason[];
  memoryRevision: string | "unavailable" | null;
  outcome: "pending" | "stop" | "toolUse" | "length" | "error" | "aborted" | "unknown";
  usage: Usage | null;
  transport: {
    requested: "auto" | "sse" | "websocket" | "websocket-cached" | "unspecified";
    observed: "unobserved" | "websocket-full" | "websocket-delta" | "websocket-mixed" | "sse-fallback";
    /** Deltas of SDK session counters, NOT provider prompt-cache hits. */
    counters: Stats | null;
  };
};
type Previous = { payload: Fingerprint; instructions: Fingerprint; tools: Fingerprint; nonInput: Fingerprint;
  input: Fingerprint; items: string[] | null; count: number };
type State = { previous?: Previous; memoryRevision: string | null; lastOutcome?: RequestDiagnostic["outcome"] };

function fingerprint(value: unknown): Fingerprint {
  const json = JSON.stringify(value ?? null);
  return { hash: createHmac("sha256", hashKey).update(json).digest("hex"), bytes: Buffer.byteLength(json) };
}
function safeRole(role: unknown): DiagnosticRole {
  return role === "main" || role === "worker" || role === "readonly" || role === "judge" || role === "afk" ? role : "unknown";
}
function safeStats(value: OpenAICodexWebSocketDebugStats | undefined): Stats | undefined {
  if (!value) return undefined;
  const result = {} as Stats;
  for (const key of counters) {
    const n = value[key];
    if (!Number.isSafeInteger(n) || n < 0) return undefined;
    result[key] = n;
  }
  return result;
}
function usageOf(value: AssistantMessage["usage"] | undefined): Usage | null {
  if (!value) return null;
  const result = {} as Usage;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const n = value[key];
    if (!Number.isFinite(n) || n < 0) return null;
    result[key] = n;
  }
  // SDKs also initialize this shape before any response usage arrives. An
  // all-zero placeholder is not evidence that a failed call consumed no tokens.
  return Object.values(result).some((n) => n > 0) ? result : null;
}

/** Exported for isolated regression fixtures; the application owns one collector. */
export class RequestDiagnostics {
  private readonly states = new Map<string, State>();
  private records: RequestDiagnostic[] = [];
  private sequence = 0;

  reset(sessionId: string): void {
    this.clear(sessionId);
    if (this.states.size >= SESSION_LIMIT) this.clear(this.states.keys().next().value!);
    this.states.set(sessionId, { memoryRevision: null });
  }
  clear(sessionId?: string): void {
    if (sessionId === undefined) { this.states.clear(); this.records = []; return; }
    this.states.delete(sessionId);
    const hash = fingerprint(sessionId).hash;
    this.records = this.records.filter((record) => record.sessionHash !== hash);
  }
  memory(sessionId: string, revision: string | undefined): void {
    if (!this.states.has(sessionId)) this.reset(sessionId);
    this.states.get(sessionId)!.memoryRevision = revision && /^[a-f0-9]{64}$/.test(revision) ? revision : "unavailable";
  }
  report(sessionId?: string): RequestDiagnostic[] {
    const hash = sessionId === undefined ? undefined : fingerprint(sessionId).hash;
    // Callers cannot mutate the collector or reach any raw session identity.
    return structuredClone(this.records.filter((record) => hash === undefined || record.sessionHash === hash));
  }
  begin(sessionId: string, role: unknown, requested: unknown, before?: OpenAICodexWebSocketDebugStats) {
    if (!this.states.has(sessionId)) this.reset(sessionId);
    const state = this.states.get(sessionId)!;
    const baseline = safeStats(before);
    const record: RequestDiagnostic = {
      sequence: ++this.sequence, sessionHash: fingerprint(sessionId).hash, role: safeRole(role),
      stage: "provider-payload-before-transport", payload: null, instructions: null, tools: null, nonInput: null,
      input: null, reasons: [], memoryRevision: state.memoryRevision, outcome: "pending", usage: null,
      transport: { requested: requested === "auto" || requested === "sse" || requested === "websocket" || requested === "websocket-cached"
        ? requested : "unspecified", observed: "unobserved", counters: null },
    };
    this.records.push(record);
    if (this.records.length > REQUEST_DIAGNOSTICS_LIMIT) this.records.shift();
    let captured = false;
    return {
      payload: (value: unknown) => {
        // One final effective provider body per stream call. Provider-internal
        // retries may reuse it; transport counter deltas include those attempts.
        if (captured) return;
        captured = true;
        try {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          const body = value as Record<string, unknown>;
          const input = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : null;
          const { input: _input, messages: _messages, previous_response_id: _response, ...nonInput } = body;
          const instructions = body.instructions ?? body.system ?? (Array.isArray(body.messages)
            ? body.messages.filter((item) => item?.role === "system" || item?.role === "developer") : null);
          const current: Previous = {
            payload: fingerprint(body), instructions: fingerprint(instructions), tools: fingerprint(body.tools),
            nonInput: fingerprint(nonInput), input: fingerprint(input), count: input?.length ?? 0,
            items: input && input.length <= INPUT_COMPARISON_LIMIT ? input.map((item) => fingerprint(item).hash) : null,
          };
          const previous = state.previous;
          let prefix: Prefix = !input ? "unavailable" : !previous ? "first" : "unavailable";
          if (previous && current.items && previous.items) {
            prefix = current.items.length >= previous.items.length && previous.items.every((hash, i) => current.items![i] === hash)
              ? current.items.length === previous.items.length ? "unchanged" : "append-only" : "changed";
          }
          const reasons: Reason[] = [];
          if (!previous) reasons.push("first-request");
          else {
            if (current.instructions.hash !== previous.instructions.hash) reasons.push("instructions-changed");
            if (current.tools.hash !== previous.tools.hash) reasons.push("tools-changed");
            if (current.nonInput.hash !== previous.nonInput.hash) reasons.push("non-input-changed");
            if (prefix === "changed") reasons.push("input-prefix-changed");
            if (prefix === "append-only") reasons.push("input-appended");
            if (current.payload.hash === previous.payload.hash) reasons.push("identical-payload");
          }
          if (prefix === "unavailable" || !current.items) reasons.push("comparison-limited");
          if (state.lastOutcome === "error" || state.lastOutcome === "aborted") reasons.push("after-error");
          record.payload = current.payload; record.instructions = current.instructions; record.tools = current.tools;
          record.nonInput = current.nonInput; record.input = { ...current.input, items: current.count, prefix };
          record.reasons = reasons;
          state.previous = current;
        } catch {
          record.reasons = ["comparison-limited"];
          state.previous = undefined;
        }
      },
      finish: (message?: AssistantMessage, after?: OpenAICodexWebSocketDebugStats) => {
        if (record.outcome !== "pending") return;
        const reason = message?.stopReason;
        record.outcome = reason === "stop" || reason === "toolUse" || reason === "length" || reason === "error" || reason === "aborted"
          ? reason : "unknown";
        state.lastOutcome = record.outcome;
        record.usage = usageOf(message?.usage);
        if (!captured) record.reasons = ["comparison-limited"];
        const final = safeStats(after);
        if (!final) return;
        const delta = {} as Stats;
        for (const key of counters) {
          const n = final[key] - (baseline?.[key] ?? 0);
          if (n < 0) return; // SDK stats reset while the request was in flight.
          delta[key] = n;
        }
        record.transport.counters = delta;
        record.transport.observed = delta.sseFallbacks > 0 ? "sse-fallback"
          : delta.fullContextRequests > 0 && delta.deltaRequests > 0 ? "websocket-mixed"
          : delta.deltaRequests > 0 ? "websocket-delta" : delta.fullContextRequests > 0 ? "websocket-full" : "unobserved";
      },
    };
  }
}

const collector = new RequestDiagnostics();
export function requestDiagnosticsEnabled(): boolean { return process.env.PUM_REQUEST_DIAGNOSTICS === "1"; }
export function requestDiagnosticsReport(sessionId?: string) {
  return { enabled: requestDiagnosticsEnabled(), version: 1, limit: REQUEST_DIAGNOSTICS_LIMIT,
    hash: "runtime-keyed-hmac-sha256", comparison: "previous-local-payload-not-sdk-response-baseline",
    usageSource: "provider-normalized-usage; all-zero-or-invalid-is-unavailable",
    serverCache: "usage.cacheRead-is-provider-reported; transport-is-not-a-cache-hit-or-miss",
    requests: requestDiagnosticsEnabled() ? collector.report(sessionId) : [] };
}
export function clearRequestDiagnostics(sessionId?: string): void { collector.clear(sessionId); }
export function resetRequestDiagnostics(sessionId: string): void {
  if (requestDiagnosticsEnabled()) collector.reset(sessionId);
}
export function recordDiagnosticMemoryRevision(sessionId: string, revision: string | undefined): void {
  if (requestDiagnosticsEnabled()) collector.memory(sessionId, revision);
}
let statsModule: Promise<typeof import("@earendil-works/pi-ai/api/openai-codex-responses") | undefined> | undefined;
export async function beginRequestDiagnostic(sessionId: string, role: unknown, transport: unknown, api: string) {
  if (!requestDiagnosticsEnabled()) return undefined;
  // Lazy public SDK export, not a source patch or a global socket interceptor.
  const sdk = api === "openai-codex-responses"
    ? await (statsModule ??= import("@earendil-works/pi-ai/api/openai-codex-responses").catch(() => undefined)) : undefined;
  const stats = () => { try { return sdk?.getOpenAICodexWebSocketDebugStats(sessionId); } catch { return undefined; } };
  const request = collector.begin(sessionId, role, transport, stats());
  return { payload: request.payload, finish: (message?: AssistantMessage) => request.finish(message, stats()) };
}

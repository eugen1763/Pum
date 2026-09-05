import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { RequestDiagnostics, REQUEST_DIAGNOSTICS_LIMIT } from "../src/request-diagnostics";

const payload = (text = "PRIVATE_PROMPT", instructions = "PRIVATE_INSTRUCTIONS") => ({
  instructions, tools: [{ name: "PRIVATE_TOOL_NAME", description: "PRIVATE_DESCRIPTION" }],
  input: [{ role: "user", content: text }], metadata: { apiKey: "sk-DO_NOT_RETAIN", oauth: "https://private.invalid/oauth?code=PRIVATE" },
});
const message = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text: "PRIVATE_ANSWER" }], api: "openai-completions",
  provider: "PRIVATE_PROVIDER", model: "PRIVATE_MODEL", timestamp: 0, stopReason, errorMessage: "PRIVATE_ERROR",
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const stats = { requests: 0, connectionsCreated: 0, connectionsReused: 0, fullContextRequests: 0, deltaRequests: 0,
  websocketFailures: 0, sseFallbacks: 0, cachedContextRequests: 0, storeTrueRequests: 0, lastInputItems: 0,
  lastPreviousResponseId: "PRIVATE_RESPONSE_ID", lastWebSocketError: "PRIVATE_SDK_ERROR" };

describe("bounded runtime request diagnostics", () => {
  test("retains only allowlisted metadata, uses runtime-keyed hashes and rejects untrusted revision/role/transport text", () => {
    const h = new RequestDiagnostics();
    h.memory("PRIVATE_SESSION_ID", "PRIVATE_MEMORY");
    const request = h.begin("PRIVATE_SESSION_ID", "PRIVATE_ROLE", "PRIVATE_TRANSPORT", stats);
    request.payload(payload());
    request.finish(message(), { ...stats, requests: 1, fullContextRequests: 1, connectionsCreated: 1 });
    const [record] = h.report();
    const json = JSON.stringify(record);
    for (const forbidden of ["PRIVATE", "sk-", "https://", "apiKey", "oauth", "errorMessage", "lastWebSocketError", "lastPreviousResponseId"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(record!.role).toBe("unknown");
    expect(record!.memoryRevision).toBe("unavailable");
    expect(record!.transport.requested).toBe("unspecified");
    expect(record!.transport.observed).toBe("websocket-full");
    expect(record!.usage).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 });
    expect(record!.payload!.bytes).toBe(Buffer.byteLength(JSON.stringify(payload())));
    record!.reasons.push("after-error");
    expect(h.report()[0]!.reasons).not.toContain("after-error");
  });

  test("records changes independently without claiming an exact SDK continuation reason", () => {
    const h = new RequestDiagnostics();
    let request = h.begin("one", "main", "auto");
    request.payload(payload()); request.finish(message("error"));
    request = h.begin("one", "main", "auto");
    request.payload(payload()); request.finish(message());
    expect(h.report()[1]!.reasons).toEqual(["identical-payload", "after-error"]);
    request = h.begin("one", "main", "auto");
    request.payload({ ...payload("CHANGED", "CHANGED_INSTRUCTION"), tools: [] }); request.finish(message());
    expect(h.report()[2]!.reasons).toEqual(["instructions-changed", "tools-changed", "non-input-changed", "input-prefix-changed"]);
    request = h.begin("one", "main", "auto");
    request.payload({ ...payload("CHANGED", "CHANGED_INSTRUCTION"), tools: [], input: [
      ...payload("CHANGED").input, { role: "user", content: "appended" },
    ] }); request.finish(message());
    expect(h.report()[3]!.reasons).toEqual(["input-appended"]);
  });

  test("global record cap and session cap bound retention; clear and reset discard previous baselines", () => {
    const h = new RequestDiagnostics();
    for (let i = 0; i < REQUEST_DIAGNOSTICS_LIMIT + 10; i++) h.begin("one", "main", "auto").payload(payload(String(i)));
    expect(h.report()).toHaveLength(REQUEST_DIAGNOSTICS_LIMIT);
    expect(h.report()[0]!.sequence).toBe(11);
    h.reset("one");
    h.memory("one", "a".repeat(64));
    h.begin("one", "main", "auto").payload(payload());
    expect(h.report("one")[0]!.reasons).toEqual(["first-request"]);
    expect(h.report("one")[0]!.memoryRevision).toBe("a".repeat(64));
    for (let i = 0; i < 32; i++) h.begin(`peer${i}`, "worker", "auto").payload(payload());
    expect(h.report("one")).toEqual([]);
    expect(h.report()).toHaveLength(32);
    h.clear("peer0");
    // The next trusted memory observation must survive a user clearing the ring.
    h.memory("peer0", "b".repeat(64));
    h.begin("peer0", "worker", "auto").payload(payload());
    expect(h.report("peer0")[0]!.memoryRevision).toBe("b".repeat(64));
    h.clear();
    expect(h.report()).toEqual([]);
  });

  test("malformed payloads, excessive input counts, zero usage and SDK counter resets remain explicitly unavailable", () => {
    const h = new RequestDiagnostics();
    const cyclic: any = {}; cyclic.self = cyclic;
    let request = h.begin("one", "main", "auto");
    request.payload(cyclic); request.finish();
    expect(h.report()[0]!.payload).toBeNull();
    expect(h.report()[0]!.reasons).toEqual(["comparison-limited"]);
    expect(h.report()[0]!.usage).toBeNull();
    request = h.begin("one", "main", "auto", { ...stats, requests: 10 });
    request.payload({ input: Array.from({ length: 2049 }, () => ({ role: "user", content: "small" })) });
    const empty = message("error");
    empty.usage = { ...empty.usage, input: 0, output: 0, totalTokens: 0 };
    request.finish(empty, stats);
    expect(h.report()[1]!.reasons).toContain("comparison-limited");
    expect(h.report()[1]!.transport.counters).toBeNull();
    expect(h.report()[1]!.usage).toBeNull();
    const unsupported = h.begin("two", "worker", "sse");
    unsupported.payload({ contents: [{ text: "private" }] }); unsupported.finish(message());
    expect(h.report("two")[0]!.input!.prefix).toBe("unavailable");
    expect(h.report("two")[0]!.transport.observed).toBe("unobserved");
  });
});

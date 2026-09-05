import { afterEach, describe, expect, test } from "bun:test";
import { diagnosticsCommandText, writeHeadlessRequestDiagnostics } from "../src/request-diagnostics-access";
import { clearRequestDiagnostics, requestDiagnosticsReport } from "../src/request-diagnostics";

const previous = process.env.PUM_REQUEST_DIAGNOSTICS;
afterEach(() => {
  clearRequestDiagnostics();
  if (previous === undefined) delete process.env.PUM_REQUEST_DIAGNOSTICS;
  else process.env.PUM_REQUEST_DIAGNOSTICS = previous;
});

describe("request diagnostics user access", () => {
  test("recognizes only the exact slash command boundary", () => {
    process.env.PUM_REQUEST_DIAGNOSTICS = "1";
    expect(diagnosticsCommandText("/diagnostics-other", "test-session")).toBeUndefined();
    expect(diagnosticsCommandText("ordinary prompt", "test-session")).toBeUndefined();
    expect(diagnosticsCommandText("/diagnostics extra", "test-session")).toBe("Usage: /diagnostics [clear]");
  });

  test("disabled diagnostics explain startup opt-in and never emit headless output", () => {
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) delete process.env.PUM_REQUEST_DIAGNOSTICS;
      else process.env.PUM_REQUEST_DIAGNOSTICS = value;
      expect(diagnosticsCommandText("/diagnostics", "raw-session-secret")).toContain("PUM_REQUEST_DIAGNOSTICS=1 bun run start");
      const output: string[] = [];
      writeHeadlessRequestDiagnostics("raw-session-secret", (text) => output.push(text));
      expect(output).toEqual([]);
    }
  });

  test("enabled TUI and headless outputs are the session's safe JSON report", () => {
    process.env.PUM_REQUEST_DIAGNOSTICS = "1";
    const sessionId = "raw-session-secret";
    const report = diagnosticsCommandText(" /diagnostics ", sessionId)!;
    expect(JSON.parse(report)).toEqual(requestDiagnosticsReport(sessionId));
    expect(report).not.toContain(sessionId);
    const output: string[] = [];
    writeHeadlessRequestDiagnostics(sessionId, (text) => output.push(text));
    expect(output).toHaveLength(1);
    expect(output[0]).toEndWith("\n");
    expect(JSON.parse(output[0]!)).toEqual(JSON.parse(report));
    expect(output[0]).not.toContain(sessionId);
  });

  test("missing child identity fails closed instead of requesting all sessions", () => {
    process.env.PUM_REQUEST_DIAGNOSTICS = "1";
    expect(diagnosticsCommandText("/diagnostics", undefined)).toBe("Request diagnostics are unavailable for this session.");
    expect(diagnosticsCommandText("/diagnostics clear", undefined)).toBe("Request diagnostics are unavailable for this session.");
  });

  test("clear has a finite safe acknowledgement", () => {
    process.env.PUM_REQUEST_DIAGNOSTICS = "1";
    expect(diagnosticsCommandText("/diagnostics clear", "raw-session-secret")).toBe("Request diagnostics cleared for this session.");
  });
});

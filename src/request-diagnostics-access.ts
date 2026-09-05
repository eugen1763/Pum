import { clearRequestDiagnostics, requestDiagnosticsEnabled, requestDiagnosticsReport } from "./request-diagnostics";

/** User-only output; never persist these reports or send them to the model. */
export function diagnosticsCommandText(input: string, sessionId: string | undefined): string | undefined {
  const command = input.trim();
  if (!/^\/diagnostics(?:\s|$)/.test(command)) return undefined;
  if (!requestDiagnosticsEnabled()) {
    return "Request diagnostics are disabled. Restart with PUM_REQUEST_DIAGNOSTICS=1 bun run start, then run /diagnostics.";
  }
  if (command !== "/diagnostics" && command !== "/diagnostics clear") {
    return "Usage: /diagnostics [clear]";
  }
  // Missing child identity must never fall back to the process-wide report.
  if (!sessionId) return "Request diagnostics are unavailable for this session.";
  if (command === "/diagnostics clear") {
    clearRequestDiagnostics(sessionId);
    return "Request diagnostics cleared for this session.";
  }
  return JSON.stringify(requestDiagnosticsReport(sessionId), null, 2);
}

/** Keep headless stdout solely for the assistant answer. */
export function writeHeadlessRequestDiagnostics(sessionId: string, write: (text: string) => void): void {
  if (requestDiagnosticsEnabled()) write(`${JSON.stringify(requestDiagnosticsReport(sessionId))}\n`);
}

import { flushStream, settleTranscriptMessage, type Line, type PendingTranscriptState } from "./transcript";

/** Redact entire header values, not just the scheme or first credential token. */
function redactAuthorization(text: string): string {
  const header = /(["']?\b(?:proxy-)?authorization["']?\s*[:=]\s*)/gi;
  let safe = "";
  let copied = 0;
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const start = header.lastIndex;
    let end = start;
    let quote = "";
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (quote) {
        // JSON-escaped Digest quotes are part of the value, not its boundary.
        if (char === "\\") { end++; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      // Digest commas and arbitrary scheme whitespace/semicolons can contain
      // credentials. Only a structured next field or explicit schema diagnostic
      // is a safe boundary; ambiguous/unclosed values consume the remaining text.
      if (char === "," && /^,\s*["'][^"'\n]+["']\s*:/.test(text.slice(end))) break;
      if (char === ";" && /^;\s*(?:[45]\d\d\s+)?tools\.\d+\.custom\b/.test(text.slice(end))) break;
    }
    safe += text.slice(copied, start) + "[redacted]";
    copied = end;
    header.lastIndex = end;
  }
  return safe + text.slice(copied);
}

/** Provider text is untrusted display data, never a diagnostic or durable rewrite. */
export function providerErrorLine(message: unknown): Line | null {
  const assistant = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | null;
  // An aborted response can also carry errorMessage; cancellation is not failure.
  if (assistant?.role !== "assistant" || assistant.stopReason !== "error") return null;
  const raw = typeof assistant.errorMessage === "string" ? assistant.errorMessage : "";
  // As in login-flow.safeError, redact credential-shaped keys. Provider failures
  // can also echo headers/JSON or an OAuth URL, so remove those before bounding.
  const normalized = raw
    // Normalize control sequences first so they cannot split a credential marker.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  const safe = redactAuthorization(normalized)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [redacted]")
    // Quoted JSON/header values may contain escaped quotes or span whitespace.
    // An unterminated quoted secret is redacted through the end, never partially.
    .replace(/(["']?\b(?:api[_ -]?key|x-api-key|access[_ -]?token|refresh[_ -]?token|password|secret|client[_ -]?secret)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^\s,}\n]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_.-]{8,}\b/gi, "[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .trim();
  const detail = safe ? safe.slice(0, 4000) + (safe.length > 4000 ? "…" : "") : "The request failed without an error description.";
  return { kind: "text", role: "error", text: `Provider error: ${detail}` };
}

/** Finish partial output before its failure, then deliver queued messages. */
export function settleAssistantTranscript<T extends PendingTranscriptState>(value: T, message: unknown): T {
  const error = providerErrorLine(message);
  if (!error) return settleTranscriptMessage(value);
  const flushed = flushStream(value);
  return settleTranscriptMessage({ ...flushed, lines: [...flushed.lines, error] });
}

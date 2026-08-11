import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * PUM identity for the system prompt.
 *
 * pi's default base prompt introduces the agent as "operating inside pi" and
 * routes six lines to pi's own documentation. PUM users ask about PUM, so this
 * extension names PUM in the identity sentence and removes the pi-docs routing
 * section. Both transforms use exact-match guards: when a pi upgrade changes
 * the base prompt, each transform degrades to a safe no-op (the identity is
 * then prepended instead of substituted, and the docs section stays).
 */

/** pi's identity sentence, verbatim. Substitution requires an exact leading match. */
const PI_IDENTITY_SENTENCE =
  "You are an expert coding assistant operating inside pi, a coding agent harness.";

/** PUM's identity sentence. Phrased for main and child sessions alike. */
export const PUM_IDENTITY_SENTENCE =
  "You are an expert coding agent operating inside PUM, a terminal coding agent built on pi, a coding agent harness.";

/** Verbatim leading text of pi's documentation-routing header line. */
const PI_DOCS_HEADER_PREFIX =
  "Pi documentation (read only when the user asks about pi itself";

/** Replace pi's identity sentence when it leads the prompt; otherwise prepend PUM's. */
export function applyPumIdentity(systemPrompt: string): string {
  if (systemPrompt.startsWith(PI_IDENTITY_SENTENCE)) {
    return PUM_IDENTITY_SENTENCE + systemPrompt.slice(PI_IDENTITY_SENTENCE.length);
  }
  return `${PUM_IDENTITY_SENTENCE}\n\n${systemPrompt}`;
}

/**
 * Remove pi's documentation-routing section: the exact header line plus the
 * contiguous "- " bullet lines that follow it. Returns the prompt unchanged
 * when the header line is absent.
 */
export function removePiDocsSection(systemPrompt: string): string {
  const lines = systemPrompt.split("\n");
  const start = lines.findIndex((line) => line.startsWith(PI_DOCS_HEADER_PREFIX));
  if (start === -1) return systemPrompt;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("- ")) end += 1;
  const before = lines.slice(0, start);
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  const after = lines.slice(end);
  while (after.length > 0 && after[0] === "") after.shift();
  if (after.length === 0) return before.join("\n");
  if (before.length === 0) return after.join("\n");
  return [...before, "", ...after].join("\n");
}

/** Applies both prompt transforms on every turn, for main and child sessions. */
export const identityExtension: InlineExtension = {
  name: "pum-identity",
  factory(pi) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: applyPumIdentity(removePiDocsSection(event.systemPrompt)),
    }));
  },
};

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { getCheckModeConfig } from "./check-mode";
import type { CheckModeProfile } from "./settings";
import type { SandboxMode } from "./sandbox/types";

export type CheckModePromptState = {
  profile: CheckModeProfile;
  sandboxMode: SandboxMode;
  additionalPaths: readonly string[];
};

/** Rules that apply to every active profile. Check mode off enforces nothing. */
export const HARD_BLOCKED_RULES = [
  "Access credentials (keys, tokens, .env, auth.json).",
  "Write or execute outside the project and approved roots.",
  "Change the working location outside the project.",
  "Escape links or junctions.",
  "Escalate privileges or change permissions broadly.",
  "Persist across sessions (rc files, autostart, scheduled tasks).",
  "Execute scripts fetched from a remote source.",
  "Delete broadly.",
] as const;

/** What on-mode permits. On-mode runs the former balanced behavior. */
const PERMITTED_RULES: readonly string[] = [
  "Run complete project-local bash calls.",
  "Read project files and explicit external files.",
  "Edit files inside the project.",
  "Deterministic validation must be complete before a call is allowed.",
];

/** Build the concise allowed-and-denied block for one active Check mode state. */
export function buildCheckModePrompt(state: CheckModePromptState): string {
  const roots = state.additionalPaths.length > 0
    ? state.additionalPaths.join(", ")
    : "none";
  // Sandbox enforcement requires Check mode to be on (src/sandbox/index.ts),
  // so the off state reports the resolved state, not the configured mode.
  const sandboxLabel = state.profile === "off"
    ? "not enforced (Check mode off)"
    : state.sandboxMode;
  const header = "## Allowed and denied under Check mode\n\n"
    + `Check mode: ${state.profile}. Sandbox: ${sandboxLabel}. `
    + `Additional approved roots: ${roots}.`;
  if (state.profile === "off") {
    return `${header}\n\nCheck mode is off. Bash and edit run without approval checks.`;
  }
  const lines = [
    header,
    "",
    "Permitted when Check mode is on:",
    ...PERMITTED_RULES.map((rule) => `- ${rule}`),
    "",
    "Hard-blocked when Check mode is on:",
    ...HARD_BLOCKED_RULES.map((rule) => `- ${rule}`),
    "",
    "A verifier UNSAFE result blocks the call. The only exception is a direct npm publish or npm dist-tag add from the main agent, which is allowed.",
    "Do not retry a blocked call.",
  ];
  return lines.join("\n");
}

let sandboxModeSource: () => SandboxMode = () => "off";

/** Bind the live sandbox mode so the block always reflects the current setting. */
export function setSandboxModeSource(source: () => SandboxMode): void {
  sandboxModeSource = source;
}

/**
 * Injects the allowed-and-denied block on every turn. Reads the live Check mode
 * config and sandbox mode, so the block regenerates when the profile or the
 * approved roots change.
 */
export const checkModePromptExtension: InlineExtension = {
  name: "pum-check-mode-rules",
  factory(pi) {
    pi.on("before_agent_start", (event) => {
      const config = getCheckModeConfig();
      const block = buildCheckModePrompt({
        profile: config.profile,
        sandboxMode: sandboxModeSource(),
        additionalPaths: config.additionalPaths ?? [],
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });
  },
};

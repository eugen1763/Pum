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

const PERMITTED_RULES: Record<Exclude<CheckModeProfile, "off">, readonly string[]> = {
  strict: [
    "Run only complete project-local calls.",
    "Read and edit project files, and apply_patch, only after the verifier returns SAFE.",
    "Unclear, error, and unavailable verifier results block.",
  ],
  balanced: [
    "Run complete project-local bash calls.",
    "Read project files and explicit external files.",
    "Edit and apply_patch inside the project.",
    "Deterministic validation must be complete before a call is allowed.",
  ],
  ask: [
    "Nothing is auto-allowed in ask mode.",
    "Every checked bash, edit, and apply_patch call presents a preview for explicit user approval.",
  ],
};

/** Build the concise allowed-and-denied block for one active Check mode state. */
export function buildCheckModePrompt(state: CheckModePromptState): string {
  const roots = state.additionalPaths.length > 0
    ? state.additionalPaths.join(", ")
    : "none";
  const header = "## Allowed and denied under the active Check mode profile\n\n"
    + `Active profile: ${state.profile}. Sandbox: ${state.sandboxMode}. `
    + `Additional approved roots: ${roots}.`;
  if (state.profile === "off") {
    return `${header}\n\nCheck mode is off. Bash, edit, and apply_patch run without approval checks.`;
  }
  const lines = [
    header,
    "",
    `Permitted by ${state.profile}:`,
    ...PERMITTED_RULES[state.profile].map((rule) => `- ${rule}`),
    "",
    "Hard-blocked in every active profile:",
    ...HARD_BLOCKED_RULES.map((rule) => `- ${rule}`),
    "",
    "Ask mode presents each checked call for explicit user approval.",
    "A verifier UNSAFE result blocks without the popup.",
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

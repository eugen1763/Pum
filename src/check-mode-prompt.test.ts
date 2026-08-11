import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCheckModePrompt,
  checkModePromptExtension,
  setSandboxModeSource,
  HARD_BLOCKED_RULES,
} from "./check-mode-prompt";
import { setCheckModeConfig } from "./check-mode";

function beforeAgentStart() {
  let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
  (checkModePromptExtension as any).factory({
    on(event: string, callback: typeof handler) {
      if (event === "before_agent_start") handler = callback;
    },
  } as any);
  return handler!;
}

afterEach(() => {
  setSandboxModeSource(() => "off");
  setCheckModeConfig({ profile: "off", model: "test/verifier" });
});

describe("buildCheckModePrompt", () => {
  test("reports an off profile with no approval checks", () => {
    const block = buildCheckModePrompt({ profile: "off", sandboxMode: "off", additionalPaths: [] });
    expect(block).toContain("Active profile: off");
    expect(block).toContain("run without approval checks");
    expect(block).not.toContain("Hard-blocked");
  });

  test("reports the strict profile and fail-closed verifier gate", () => {
    const block = buildCheckModePrompt({ profile: "strict", sandboxMode: "auto", additionalPaths: [] });
    expect(block).toContain("Active profile: strict");
    expect(block).toContain("Sandbox: auto");
    expect(block).toContain("Permitted by strict");
    expect(block).toContain("after the verifier returns SAFE");
    expect(block).toContain("Hard-blocked in every active profile");
    expect(block).toContain("A verifier UNSAFE result blocks without the popup");
  });

  test("reports the balanced profile and its project-local grants", () => {
    const block = buildCheckModePrompt({ profile: "balanced", sandboxMode: "auto", additionalPaths: [] });
    expect(block).toContain("Active profile: balanced");
    expect(block).toContain("Permitted by balanced");
    expect(block).toContain("complete project-local bash calls");
    expect(block).toContain("Edit and apply_patch inside the project");
    expect(block).toContain("Hard-blocked in every active profile");
    expect(block).not.toMatch(/npm (publish|install|pack)/);
  });

  test("reports the ask profile with explicit approval for every checked call", () => {
    const block = buildCheckModePrompt({ profile: "ask", sandboxMode: "require", additionalPaths: [] });
    expect(block).toContain("Active profile: ask");
    expect(block).toContain("Sandbox: require");
    expect(block).toContain("explicit user approval");
    expect(block).toContain("Ask mode presents each checked call for explicit user approval");
    expect(block).toContain("Hard-blocked in every active profile");
    expect(block).toContain("A verifier UNSAFE result blocks without the popup");
  });

  test("lists every always-blocked rule", () => {
    const block = buildCheckModePrompt({ profile: "strict", sandboxMode: "auto", additionalPaths: [] });
    for (const rule of HARD_BLOCKED_RULES) {
      expect(block).toContain(rule);
    }
  });

  test("lists the additional approved project roots", () => {
    const block = buildCheckModePrompt({
      profile: "balanced",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one", "D:/data/two"],
    });
    expect(block).toContain("Additional approved roots: C:/data/one, D:/data/two.");
  });

  test("regenerates when the profile or roots change", () => {
    const before = buildCheckModePrompt({
      profile: "balanced",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one"],
    });
    const afterProfile = buildCheckModePrompt({
      profile: "ask",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one"],
    });
    const afterRoots = buildCheckModePrompt({
      profile: "balanced",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one", "D:/data/two"],
    });
    expect(afterProfile).not.toBe(before);
    expect(afterProfile).toContain("Active profile: ask");
    expect(afterRoots).not.toBe(before);
    expect(afterRoots).toContain("C:/data/one, D:/data/two");
  });
});

describe("checkModePromptExtension", () => {
  test("appends the block to the system prompt", () => {
    const handler = beforeAgentStart();
    setSandboxModeSource(() => "auto");
    setCheckModeConfig({
      profile: "balanced",
      model: "test/verifier",
      additionalPaths: ["C:/data/one"],
    });
    const result = handler({ systemPrompt: "base" });
    expect(result).toBeDefined();
    expect(result!.systemPrompt.startsWith("base\n\n## Allowed and denied")).toBe(true);
    expect(result!.systemPrompt).toContain("Active profile: balanced");
    expect(result!.systemPrompt).toContain("C:/data/one");
  });

  test("reflects live config so the block follows profile and root changes", () => {
    const handler = beforeAgentStart();
    setSandboxModeSource(() => "require");

    setCheckModeConfig({ profile: "strict", model: "test/verifier", additionalPaths: [] });
    const strict = handler({ systemPrompt: "base" })!;
    expect(strict.systemPrompt).toContain("Active profile: strict");

    setCheckModeConfig({
      profile: "ask",
      model: "test/verifier",
      additionalPaths: ["D:/data/two"],
    });
    const ask = handler({ systemPrompt: "base" })!;
    expect(ask.systemPrompt).toContain("Active profile: ask");
    expect(ask.systemPrompt).toContain("Sandbox: require");
    expect(ask.systemPrompt).toContain("D:/data/two");
  });
});

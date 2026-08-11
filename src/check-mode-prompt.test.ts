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
  test("reports Check mode off with no approval checks", () => {
    const block = buildCheckModePrompt({ profile: "off", sandboxMode: "off", additionalPaths: [] });
    expect(block).toContain("Check mode: off");
    expect(block).toContain("run without approval checks");
    expect(block).not.toContain("Hard-blocked");
  });

  test("reports the sandbox as not enforced while Check mode is off", () => {
    // Sandbox enforcement requires Check mode to be on, so the configured mode
    // must not suggest an active sandbox when Check mode is off.
    const block = buildCheckModePrompt({ profile: "off", sandboxMode: "auto", additionalPaths: [] });
    expect(block).toContain("Sandbox: not enforced (Check mode off)");
    expect(block).not.toContain("Sandbox: auto");
  });

  test("reports Check mode on with its project-local grants and hard blocks", () => {
    const block = buildCheckModePrompt({ profile: "on", sandboxMode: "auto", additionalPaths: [] });
    expect(block).toContain("Check mode: on");
    expect(block).toContain("Sandbox: auto");
    expect(block).toContain("Permitted when Check mode is on:");
    expect(block).toContain("complete project-local bash calls");
    expect(block).toContain("Edit and apply_patch inside the project");
    expect(block).toContain("Hard-blocked when Check mode is on:");
    // The narrow npm pack/install rules stay out of the prompt. The npm publish
    // sentence is the documented UNSAFE allow exception.
    expect(block).not.toMatch(/npm (install|pack)/);
  });

  test("states the UNSAFE block and the main npm publish allow exception", () => {
    const block = buildCheckModePrompt({ profile: "on", sandboxMode: "require", additionalPaths: [] });
    expect(block).toContain("A verifier UNSAFE result blocks the call.");
    expect(block).toContain("npm publish or npm dist-tag add from the main agent, which is allowed");
    expect(block).toContain("Do not retry a blocked call.");
  });

  test("lists every always-blocked rule", () => {
    const block = buildCheckModePrompt({ profile: "on", sandboxMode: "auto", additionalPaths: [] });
    for (const rule of HARD_BLOCKED_RULES) {
      expect(block).toContain(rule);
    }
  });

  test("lists the additional approved project roots", () => {
    const block = buildCheckModePrompt({
      profile: "on",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one", "D:/data/two"],
    });
    expect(block).toContain("Additional approved roots: C:/data/one, D:/data/two.");
  });

  test("regenerates when the toggle or roots change", () => {
    const on = buildCheckModePrompt({
      profile: "on",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one"],
    });
    const off = buildCheckModePrompt({
      profile: "off",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one"],
    });
    const onMoreRoots = buildCheckModePrompt({
      profile: "on",
      sandboxMode: "auto",
      additionalPaths: ["C:/data/one", "D:/data/two"],
    });
    expect(off).not.toBe(on);
    expect(off).toContain("Check mode: off");
    expect(onMoreRoots).not.toBe(on);
    expect(onMoreRoots).toContain("C:/data/one, D:/data/two");
  });
});

describe("checkModePromptExtension", () => {
  test("appends the block to the system prompt", () => {
    const handler = beforeAgentStart();
    setSandboxModeSource(() => "auto");
    setCheckModeConfig({
      profile: "on",
      model: "test/verifier",
      additionalPaths: ["C:/data/one"],
    });
    const result = handler({ systemPrompt: "base" });
    expect(result).toBeDefined();
    expect(result!.systemPrompt.startsWith("base\n\n## Allowed and denied")).toBe(true);
    expect(result!.systemPrompt).toContain("Check mode: on");
    expect(result!.systemPrompt).toContain("C:/data/one");
  });

  test("reflects live config so the block follows the toggle and root changes", () => {
    const handler = beforeAgentStart();
    setSandboxModeSource(() => "require");

    setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [] });
    const on = handler({ systemPrompt: "base" })!;
    expect(on.systemPrompt).toContain("Check mode: on");

    setCheckModeConfig({
      profile: "on",
      model: "test/verifier",
      additionalPaths: ["D:/data/two"],
    });
    const withRoot = handler({ systemPrompt: "base" })!;
    expect(withRoot.systemPrompt).toContain("Check mode: on");
    expect(withRoot.systemPrompt).toContain("Sandbox: require");
    expect(withRoot.systemPrompt).toContain("D:/data/two");
  });
});

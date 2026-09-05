import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCheckModePrompt,
  checkModePromptExtension,
  setSandboxModeSource,
  HARD_BLOCKED_RULES,
} from "../src/check-mode-prompt";
import { setCheckModeConfig } from "../src/check-mode";

function contextObserver() {
  const handlers = new Map<string, Function>();
  (checkModePromptExtension as any).factory({
    on(event: string, callback: Function) { handlers.set(event, callback); },
  });
  expect(handlers.has("before_agent_start")).toBe(false);
  const messages = [{ role: "user", content: "inspect", timestamp: 1 }];
  const ctx = { cwd: "/project", sessionManager: { getSessionId: () => "test", getBranch: () => [] } };
  return () => handlers.get("context")!({ messages }, ctx).messages;
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
    expect(block).toContain("Edit files inside the project");
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
  test("projects the block without changing the system prefix", () => {
    const handler = contextObserver();
    setSandboxModeSource(() => "auto");
    setCheckModeConfig({
      profile: "on",
      model: "test/verifier",
      additionalPaths: ["C:/data/one"],
    });
    const result = handler();
    expect(result[0].customType).toBe("pum.check_policy");
    expect(result[0].content).toContain("Check mode: on");
    expect(result[0].content).toContain("C:/data/one");
    expect(handler()).toEqual(result);
  });

  test("appends live changes while retaining earlier observations", () => {
    const handler = contextObserver();
    setSandboxModeSource(() => "require");

    setCheckModeConfig({ profile: "on", model: "test/verifier", additionalPaths: [] });
    const on = handler();
    expect(on[0].content).toContain("Check mode: on");

    setCheckModeConfig({
      profile: "on",
      model: "test/verifier",
      additionalPaths: ["D:/data/two"],
    });
    const withRoot = handler();
    expect(withRoot.slice(0, on.length)).toEqual(on);
    expect(withRoot.at(-1).content).toContain("Check mode: on");
    expect(withRoot.at(-1).content).toContain("Sandbox: require");
    expect(withRoot.at(-1).content).toContain("D:/data/two");
  });
});

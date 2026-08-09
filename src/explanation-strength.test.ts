import { afterEach, describe, expect, test } from "bun:test";
import {
  EXPLANATION_STRENGTHS,
  explanationStrengthExtension,
  setExplanationStrength,
} from "./explanation-strength";

function beforeAgentStart() {
  let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
  (explanationStrengthExtension as any).factory({
    on(event: string, callback: typeof handler) {
      if (event === "before_agent_start") handler = callback;
    },
  } as any);
  return handler!;
}

afterEach(() => setExplanationStrength("simple"));

describe("explanation strength", () => {
  test("offers none, simple, and detailed levels", () => {
    expect(EXPLANATION_STRENGTHS).toEqual(["none", "simple", "detailed"]);
  });

  test("adds regular-output guidance for simple and detailed levels", () => {
    const handler = beforeAgentStart();

    setExplanationStrength("simple");
    const simple = handler({ systemPrompt: "base" });
    expect(simple?.systemPrompt).toContain("state briefly what you are doing and why");
    expect(simple?.systemPrompt).toContain("regular assistant output");

    setExplanationStrength("detailed");
    const detailed = handler({ systemPrompt: "base" });
    expect(detailed?.systemPrompt).toContain("actions, decisions, tradeoffs, and validation");
    expect(detailed?.systemPrompt).toContain("Do not reveal private chain-of-thought");
  });

  test("adds no explanation guidance when disabled", () => {
    setExplanationStrength("none");
    expect(beforeAgentStart()({ systemPrompt: "base" })).toBeUndefined();
  });
});

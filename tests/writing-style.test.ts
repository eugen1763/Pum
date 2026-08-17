import { afterEach, describe, expect, test } from "bun:test";
import {
  STE_SYSTEM_PROMPT,
  setWritingStyle,
  writingStyleExtension,
} from "../src/writing-style";

function beforeAgentStart() {
  let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
  (writingStyleExtension as any).factory({
    on(event: string, callback: typeof handler) {
      if (event === "before_agent_start") handler = callback;
    },
  } as any);
  return handler!;
}

afterEach(() => setWritingStyle("none"));

describe("STE writing style", () => {
  test("keeps the required explicit constraints in the concise prompt", () => {
    expect(STE_SYSTEM_PROMPT).toContain("Do not omit necessary articles, subjects, or verbs.");
    expect(STE_SYSTEM_PROMPT).toContain("other technical nouns and verbs unchanged.");
    expect(STE_SYSTEM_PROMPT).toContain("Accuracy has priority over simplification.");
    expect(STE_SYSTEM_PROMPT).not.toContain("Accuracy wins");
    expect(STE_SYSTEM_PROMPT).not.toContain(";");
  });

  test("appends the prompt only when STE is active", () => {
    const handler = beforeAgentStart();

    setWritingStyle("none");
    expect(handler({ systemPrompt: "base" })).toBeUndefined();

    setWritingStyle("STE");
    expect(handler({ systemPrompt: "base" })).toEqual({
      systemPrompt: `base\n\n${STE_SYSTEM_PROMPT}`,
    });
  });
});

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const EXPLANATION_STRENGTHS = ["none", "simple", "detailed"] as const;
export type ExplanationStrength = (typeof EXPLANATION_STRENGTHS)[number];

let currentStrength: ExplanationStrength = "simple";

export const EXPLANATION_PROMPTS: Record<Exclude<ExplanationStrength, "none">, string> = {
  simple: `## Explanation strength: simple

For small tasks, avoid progress narration.
For complex or multi-step tasks, state the plan and important milestones briefly.
Put these updates in regular assistant output.
Use short bullets for the result and validation when coding work is complete.
Do not put these explanations only in hidden reasoning.`,
  detailed: `## Explanation strength: detailed

For explanations, this section takes precedence over the general "Be concise" guideline.
Use regular assistant output to explain what you are doing and why.
Explain the plan before implementation.
Report important actions, decisions, tradeoffs, and validation as the work proceeds.
Summarize the result and any remaining concerns when the work is complete.
Do not put these explanations only in hidden reasoning.
Do not reveal private chain-of-thought. Give useful rationale summaries instead.`,
};

export function isExplanationStrength(value: unknown): value is ExplanationStrength {
  return EXPLANATION_STRENGTHS.includes(value as ExplanationStrength);
}

export function setExplanationStrength(strength: ExplanationStrength): void {
  currentStrength = strength;
}

export function getExplanationStrength(): ExplanationStrength {
  return currentStrength;
}

export const explanationStrengthExtension: InlineExtension = {
  name: "pum-explanation-strength",
  factory(pi) {
    pi.on("before_agent_start", (event) => {
      if (currentStrength === "none") return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${EXPLANATION_PROMPTS[currentStrength]}`,
      };
    });
  },
};

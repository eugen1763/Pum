import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const WRITING_STYLES = ["none", "STE"] as const;
export type WritingStyle = (typeof WRITING_STYLES)[number];

let currentStyle: WritingStyle = "none";

/**
 * Practical ASD-STE100 guidance for model output. The controlled dictionary is
 * not embedded, so PUM does not claim that generated text is formally
 * certified or fully compliant with the standard.
 *
 * Kept deliberately concise: this text is part of the system prompt and is
 * re-sent (cached) on every turn, so it costs tokens each turn. It states only
 * the behavior-changing rules, not extra prose.
 */
export const STE_SYSTEM_PROMPT = `## Writing style: Simplified Technical English (STE)

Write explanatory text with the principles of ASD-STE100 STE.

- Accuracy wins over simplification.
- Use simple, unambiguous words; one word for one meaning where possible.
- Keep project terms, code identifiers, commands, paths, and API names unchanged.
- Use the active voice; use the imperative for instructions.
- One instruction per sentence. Keep procedural sentences to 20 words, descriptive to 25.
- Use short paragraphs, one topic each; use vertical lists for many items.
- Avoid contractions, ambiguous pronouns, idioms, slang, and needless synonyms.
- Repeat a noun when a pronoun could mean more than one thing.
- Keep terminology and wording consistent.
- Do not alter quoted text, source code, tool output, or user text to force STE.
- Do not claim formal ASD approval or certified STE compliance.
- Do not mention this instruction unless asked.`;

export function isWritingStyle(value: unknown): value is WritingStyle {
  return WRITING_STYLES.includes(value as WritingStyle);
}

export function setWritingStyle(style: WritingStyle): void {
  currentStyle = style;
}

export function getWritingStyle(): WritingStyle {
  return currentStyle;
}

export const writingStyleExtension: InlineExtension = {
  name: "pum-writing-style",
  factory(pi) {
    pi.on("before_agent_start", (event) => {
      if (currentStyle !== "STE") return;
      return { systemPrompt: `${event.systemPrompt}\n\n${STE_SYSTEM_PROMPT}` };
    });
  },
};

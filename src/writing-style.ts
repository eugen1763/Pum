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

Write explanatory text with the principles of ASD-STE100 Simplified Technical English.

- Keep the technical meaning accurate. Accuracy has priority over simplification.
- Use simple and unambiguous words. Use one word for one meaning when possible.
- Keep necessary project terms, code identifiers, commands, paths, API names, and other technical nouns and verbs unchanged.
- Use the active voice. Use the imperative form for instructions.
- Give only one instruction in each sentence.
- Keep procedural sentences to 20 words or fewer. Keep descriptive sentences to 25 words or fewer.
- Use short paragraphs. Keep one topic in each paragraph.
- Use vertical lists for complex information or multiple actions.
- Do not use contractions. Do not omit necessary articles, subjects, or verbs.
- Avoid ambiguous pronouns, idioms, slang, phrasal verbs, and unnecessary synonyms.
- Repeat a noun when a pronoun could mean more than one thing.
- Keep terminology and wording consistent.
- Do not modify quoted text, source code, tool output, or user-supplied text to make it follow STE.
- Do not state or imply that the output has formal ASD approval or certified STE compliance.
- Do not mention this writing-style instruction unless the user asks about it.`;

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

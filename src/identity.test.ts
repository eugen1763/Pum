import { describe, expect, test } from "bun:test";
import {
  PUM_IDENTITY_SENTENCE,
  applyPumIdentity,
  identityExtension,
  removePiDocsSection,
} from "./identity";

const PI_BASE_HEAD =
  "You are an expert coding assistant operating inside pi, a coding agent harness. "
  + "You help users by reading files, executing commands, editing code, and writing new files.";

const PI_DOCS_SECTION = [
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: /pi/README.md",
  "- Additional docs: /pi/docs",
  "- Examples: /pi/examples (extensions, custom tools, SDK)",
].join("\n");

describe("applyPumIdentity", () => {
  test("replaces pi's identity sentence at the start of the prompt", () => {
    const result = applyPumIdentity(PI_BASE_HEAD);
    expect(result.startsWith(PUM_IDENTITY_SENTENCE)).toBe(true);
    expect(result).toContain("You help users by reading files");
    expect(result).not.toContain("expert coding assistant operating inside pi,");
  });

  test("prepends the PUM identity when pi's sentence is absent or changed", () => {
    const changed = "You are a different base prompt.";
    const result = applyPumIdentity(changed);
    expect(result.startsWith(`${PUM_IDENTITY_SENTENCE}\n\n`)).toBe(true);
    expect(result).toContain(changed);
  });
});

describe("removePiDocsSection", () => {
  test("removes the header line and its contiguous bullet lines", () => {
    const prompt = `${PI_BASE_HEAD}\n\nGuidelines:\n- Be concise\n\n${PI_DOCS_SECTION}\n\nCurrent working directory: /work`;
    const result = removePiDocsSection(prompt);
    expect(result).not.toContain("Pi documentation");
    expect(result).not.toContain("/pi/README.md");
    expect(result).toContain("Guidelines:\n- Be concise\n\nCurrent working directory: /work");
  });

  test("stops at the first non-bullet line after the header", () => {
    const prompt = `${PI_DOCS_SECTION}\n\n<project_context>\nkeep me\n</project_context>`;
    const result = removePiDocsSection(prompt);
    expect(result).toContain("<project_context>\nkeep me\n</project_context>");
    expect(result).not.toContain("Pi documentation");
  });

  test("returns the prompt unchanged when the header is absent", () => {
    const prompt = "No docs section here.\n- a bullet that must stay";
    expect(removePiDocsSection(prompt)).toBe(prompt);
  });
});

describe("identityExtension", () => {
  test("applies both transforms through before_agent_start", () => {
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
    (identityExtension as any).factory({
      on(event: string, callback: typeof handler) {
        if (event === "before_agent_start") handler = callback;
      },
    });
    expect(handler).toBeDefined();
    const result = handler!({ systemPrompt: `${PI_BASE_HEAD}\n\n${PI_DOCS_SECTION}\n\nCurrent working directory: /work` });
    expect(result.systemPrompt.startsWith(PUM_IDENTITY_SENTENCE)).toBe(true);
    expect(result.systemPrompt).not.toContain("Pi documentation");
    expect(result.systemPrompt).toContain("Current working directory: /work");
  });
});

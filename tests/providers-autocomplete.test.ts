import { describe, expect, test } from "bun:test";
import { providersCompletions } from "../src/providers-autocomplete";
import type { ProviderEntry } from "../src/providers-command";

const entries: ProviderEntry[] = [
  { id: "anthropic", name: "Anthropic", kind: "builtin", configured: true },
  { id: "custom-a", name: "Custom (a)", kind: "custom", configured: false },
  { id: "openai", name: "OpenAI", kind: "builtin", configured: true },
  { id: "openrouter", name: "OpenRouter", kind: "builtin", configured: false },
];

function replacements(input: string, cursor = input.length) {
  return providersCompletions(input, cursor, entries).map((completion) => completion.replacement);
}

describe("providersCompletions", () => {
  test("ignores input for another command", () => {
    expect(providersCompletions("/login ", 7, entries)).toEqual([]);
  });

  test("ignores the command name itself", () => {
    expect(providersCompletions("/provider", 9, entries)).toEqual([]);
    expect(providersCompletions("/providers", 10, entries)).toEqual([]);
  });

  test("offers every subcommand once the command is complete", () => {
    expect(replacements("/providers ")).toEqual(["add", "edit", "delete"]);
  });

  test("filters subcommands by prefix", () => {
    expect(replacements("/providers e")).toEqual(["edit"]);
    expect(replacements("/providers d")).toEqual(["delete"]);
  });

  test("offers nothing for an unknown subcommand prefix", () => {
    expect(replacements("/providers x")).toEqual([]);
  });

  test("replaces only the subcommand token", () => {
    const [completion] = providersCompletions("/providers e", 12, entries);

    expect(completion).toEqual({ start: 11, end: 12, replacement: "edit" });
  });

  test("offers every provider after add", () => {
    expect(replacements("/providers add ")).toEqual([
      "Anthropic",
      "Custom (a)",
      "OpenAI",
      "OpenRouter",
    ]);
  });

  test("offers only manageable providers after delete", () => {
    // OpenRouter holds no credential and is not custom, so there is nothing to
    // delete. A custom provider stays offered even without a credential,
    // because its models.json entry can still be removed.
    expect(replacements("/providers delete ")).toEqual(["Anthropic", "Custom (a)", "OpenAI"]);
  });

  test("filters provider names by prefix, ignoring case", () => {
    expect(replacements("/providers add open")).toEqual(["OpenAI", "OpenRouter"]);
  });

  test("replaces the whole name token, which may hold spaces", () => {
    const input = "/providers delete Custom (";
    const [completion] = providersCompletions(input, input.length, entries);

    expect(completion).toEqual({ start: 18, end: 26, replacement: "Custom (a)" });
  });

  test("completes from the text before the cursor only", () => {
    const input = "/providers add openXXX";

    expect(providersCompletions(input, 19, entries).map((c) => c.replacement)).toEqual([
      "OpenAI",
      "OpenRouter",
    ]);
  });

  test("offers nothing when no provider name matches", () => {
    expect(replacements("/providers add zzz")).toEqual([]);
  });
});

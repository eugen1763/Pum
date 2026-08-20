import { describe, expect, test } from "bun:test";
import {
  parseProvidersCommand,
  resolveProvider,
  type ProviderEntry,
} from "../src/providers-command";

const entries: ProviderEntry[] = [
  { id: "openai", name: "OpenAI", kind: "builtin", configured: true },
  { id: "openrouter", name: "OpenRouter", kind: "builtin", configured: false },
  { id: "anthropic", name: "Anthropic", kind: "builtin", configured: true },
  { id: "custom-localhost-1234", name: "Custom (localhost:1234)", kind: "custom", configured: true },
];

describe("parseProvidersCommand", () => {
  test("ignores text that is not the providers command", () => {
    expect(parseProvidersCommand("/login")).toBeNull();
    expect(parseProvidersCommand("hello")).toBeNull();
  });

  test("ignores a command that only starts with the same letters", () => {
    expect(parseProvidersCommand("/providersfoo")).toBeNull();
  });

  test("reads the bare command as a list request", () => {
    expect(parseProvidersCommand("/providers")).toEqual({ action: "list" });
  });

  test("ignores surrounding whitespace", () => {
    expect(parseProvidersCommand("  /providers   ")).toEqual({ action: "list" });
  });

  test("reads a subcommand without a name", () => {
    expect(parseProvidersCommand("/providers add")).toEqual({ action: "add" });
  });

  test("reads a subcommand with a name", () => {
    expect(parseProvidersCommand("/providers edit openai")).toEqual({ action: "edit", name: "openai" });
  });

  test("keeps spaces and punctuation inside a provider name", () => {
    expect(parseProvidersCommand("/providers delete Custom (localhost:1234)")).toEqual({
      action: "delete",
      name: "Custom (localhost:1234)",
    });
  });

  test("accepts a subcommand in any case", () => {
    expect(parseProvidersCommand("/providers DELETE openai")).toEqual({ action: "delete", name: "openai" });
  });

  test("reports usage for an unknown subcommand", () => {
    const parsed = parseProvidersCommand("/providers frobnicate");
    expect(parsed?.action).toBe("usage");
    expect(parsed && "message" in parsed ? parsed.message : "").toContain("add");
  });
});

describe("resolveProvider", () => {
  test("finds a provider by exact id", () => {
    expect(resolveProvider(entries, "anthropic")).toEqual({ status: "found", entry: entries[2]! });
  });

  test("finds a provider by name, ignoring case", () => {
    expect(resolveProvider(entries, "openai")).toEqual({ status: "found", entry: entries[0]! });
  });

  test("finds a provider by a unique prefix", () => {
    expect(resolveProvider(entries, "anth")).toEqual({ status: "found", entry: entries[2]! });
  });

  test("reports every match when a prefix is ambiguous", () => {
    const result = resolveProvider(entries, "open");
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" ? result.matches.map((entry) => entry.id) : []).toEqual([
      "openai",
      "openrouter",
    ]);
  });

  test("prefers an exact match over a longer prefix match", () => {
    const shadowed: ProviderEntry[] = [
      { id: "open", name: "Open", kind: "builtin", configured: true },
      { id: "openai", name: "OpenAI", kind: "builtin", configured: true },
    ];
    expect(resolveProvider(shadowed, "open")).toEqual({ status: "found", entry: shadowed[0]! });
  });

  test("reports a missing provider", () => {
    expect(resolveProvider(entries, "nope")).toEqual({ status: "not-found" });
  });

  test("treats an empty query as missing", () => {
    expect(resolveProvider(entries, "   ")).toEqual({ status: "not-found" });
  });
});

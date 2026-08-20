/**
 * Parsing for /providers. This module stays free of IO so the command surface
 * can be tested without a runtime, a popup, or a models.json on disk.
 */

export type ProviderKind = "builtin" | "custom";

/** One manageable provider, as the command surface sees it. */
export type ProviderEntry = {
  id: string;
  name: string;
  kind: ProviderKind;
  /** True when a credential for this provider is stored. */
  configured: boolean;
};

export type ProvidersRequest =
  | { action: "list" }
  | { action: "add" | "edit" | "delete"; name?: string }
  | { action: "usage"; message: string };

export type ProviderMatch =
  | { status: "found"; entry: ProviderEntry }
  | { status: "ambiguous"; matches: ProviderEntry[] }
  | { status: "not-found" };

export const PROVIDERS_USAGE = "Usage: /providers [add|edit|delete] [name]";

/** The subcommands, in the order the help text and the completions show them. */
export const PROVIDER_ACTIONS = ["add", "edit", "delete"] as const;

export type ProviderAction = typeof PROVIDER_ACTIONS[number];

function isAction(value: string): value is ProviderAction {
  return (PROVIDER_ACTIONS as readonly string[]).includes(value);
}

/**
 * Read a /providers command. Returns null when the text is another command, so
 * the caller can fall through to its other handlers.
 */
export function parseProvidersCommand(text: string): ProvidersRequest | null {
  const match = /^\/providers(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { action: "list" };
  // Split once only. A provider name can hold spaces, as "Custom (host)" does.
  const boundary = rest.search(/\s/);
  const verb = (boundary === -1 ? rest : rest.slice(0, boundary)).toLowerCase();
  if (!isAction(verb)) return { action: "usage", message: PROVIDERS_USAGE };
  const name = boundary === -1 ? "" : rest.slice(boundary + 1).trim();
  return name ? { action: verb, name } : { action: verb };
}

/**
 * Find the provider a name refers to. An exact id or name wins over a prefix,
 * so a short id stays reachable when a longer id starts with the same letters.
 */
export function resolveProvider(
  entries: readonly ProviderEntry[],
  query: string,
): ProviderMatch {
  const needle = query.trim().toLowerCase();
  if (!needle) return { status: "not-found" };
  const exact = entries.filter(
    (entry) => entry.id.toLowerCase() === needle || entry.name.toLowerCase() === needle,
  );
  const matches = exact.length > 0
    ? exact
    : entries.filter(
      (entry) =>
        entry.id.toLowerCase().startsWith(needle) || entry.name.toLowerCase().startsWith(needle),
    );
  if (matches.length === 1) return { status: "found", entry: matches[0]! };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "not-found" };
}

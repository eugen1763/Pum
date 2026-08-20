/**
 * Provider management effects. Credentials live in auth.json, which pi owns
 * through ModelRuntime. Custom provider definitions live in models.json, which
 * PUM writes itself. Deleting a custom provider must clear both.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MODELS_PATH } from "./config";
import type { ProviderEntry } from "./providers-command";

type ModelsFile = { providers?: Record<string, unknown>; [key: string]: unknown };

/** The part of ModelRuntime provider management needs. */
export type ProviderRuntime = {
  logout(providerId: string): Promise<void>;
  unregisterProvider?(providerId: string): void;
};

async function readModelsFile(path: string): Promise<ModelsFile | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ModelsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeModelsFile(path: string, data: ModelsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** Ids of the providers defined in models.json. These are the custom ones. */
export async function readCustomProviderIds(path = MODELS_PATH): Promise<ReadonlySet<string>> {
  const current = await readModelsFile(path);
  return new Set(Object.keys(current?.providers ?? {}));
}

/**
 * Drop a custom provider definition from models.json. Returns false when there
 * was nothing to remove, so the caller can report that instead of claiming
 * success.
 */
export async function removeCustomProvider(
  providerId: string,
  path = MODELS_PATH,
): Promise<boolean> {
  const current = await readModelsFile(path);
  const providers = current?.providers;
  if (!current || !providers || !(providerId in providers)) return false;
  const { [providerId]: _removed, ...remaining } = providers;
  await writeModelsFile(path, { ...current, providers: remaining });
  return true;
}

/** Build the management list. Kept free of IO so the sorting stays testable. */
export function providerEntries(
  providers: readonly { id: string; name: string }[],
  options: { configured: (id: string) => boolean; custom: ReadonlySet<string> },
): ProviderEntry[] {
  return providers
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: options.custom.has(provider.id) ? ("custom" as const) : ("builtin" as const),
      configured: options.configured(provider.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Pick the model to move to after a provider was removed. Returns nothing when
 * the active model still works, or when no other model is available.
 */
export function modelAfterRemoval<T extends { provider: string }>(
  active: T | undefined,
  available: readonly T[],
  removedProviderId: string,
): T | undefined {
  if (!active || active.provider !== removedProviderId) return undefined;
  return available.find((model) => model.provider !== removedProviderId);
}

/**
 * Remove a provider. A built-in provider only loses its credential and stays
 * available to add again. A custom provider also loses its definition, so it
 * disappears from the list.
 */
export async function deleteProvider(
  runtime: ProviderRuntime,
  entry: ProviderEntry,
  path = MODELS_PATH,
): Promise<void> {
  await runtime.logout(entry.id);
  if (entry.kind !== "custom") return;
  runtime.unregisterProvider?.(entry.id);
  await removeCustomProvider(entry.id, path);
}

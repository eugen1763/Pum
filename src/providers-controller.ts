/**
 * Key handling and page state for the /providers popup.
 *
 * The controller owns no IO. Its dependencies do the work, so the whole surface
 * can be driven in tests without a runtime, a renderer, or a models.json.
 */
import type { LoginKey } from "./login-controller";
import {
  PROVIDERS_USAGE,
  resolveProvider,
  type ProviderEntry,
  type ProvidersRequest,
} from "./providers-command";
import type { ProvidersPage } from "./providers-popup";

export type ProvidersDeps = {
  /** Read the current providers, including their credential state. */
  loadEntries: () => Promise<ProviderEntry[]>;
  show: (page: ProvidersPage) => void;
  close: () => void;
  /** Hand over to the login flow. Without an entry, open its provider picker. */
  startLogin: (entry: ProviderEntry | undefined) => void;
  remove: (entry: ProviderEntry) => Promise<void>;
};

/** A provider can be deleted when it holds a credential or a custom definition. */
function deletable(entry: ProviderEntry): boolean {
  return entry.configured || entry.kind === "custom";
}

function matches(entry: ProviderEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle);
}

export class ProvidersController {
  private entries: ProviderEntry[] = [];
  private cursor = 0;
  private query = "";
  private searchFocused = false;
  private page: ProvidersPage = { kind: "working", message: "Loading providers…" };
  private pending: Promise<void> = Promise.resolve();

  constructor(private deps: ProvidersDeps) {}

  private visible(): ProviderEntry[] {
    return this.entries.filter((entry) => matches(entry, this.query));
  }

  private setPage(page: ProvidersPage) {
    this.page = page;
    this.deps.show(page);
  }

  private showList() {
    const entries = this.visible();
    this.cursor = entries.length > 0 ? Math.min(this.cursor, entries.length - 1) : 0;
    this.setPage({
      kind: "list",
      entries,
      cursor: this.cursor,
      query: this.query,
      searchFocused: this.searchFocused,
    });
  }

  private showError(title: string, message: string) {
    this.setPage({ kind: "error", title, message });
  }

  /** Queue asynchronous work so tests can await it through handleKeyAsync. */
  private run(work: () => Promise<void>) {
    this.pending = this.pending.then(work).catch(() => {});
  }

  async settled(): Promise<void> {
    await this.pending;
  }

  private async reload(): Promise<void> {
    this.entries = await this.deps.loadEntries();
  }

  private delegateLogin(entry: ProviderEntry | undefined) {
    this.deps.startLogin(entry);
    this.deps.close();
  }

  /** Resolve a name, or show why it could not be resolved. */
  private lookup(name: string): ProviderEntry | undefined {
    const result = resolveProvider(this.entries, name);
    if (result.status === "found") return result.entry;
    if (result.status === "ambiguous") {
      const names = result.matches.map((entry) => entry.name).join(", ");
      this.showError("Which provider?", `"${name}" matches ${names}. Use the full name.`);
      return undefined;
    }
    this.showError("No such provider", `PUM knows no provider called "${name}".`);
    return undefined;
  }

  async open(request: ProvidersRequest = { action: "list" }): Promise<void> {
    this.cursor = 0;
    this.query = "";
    this.searchFocused = false;
    if (request.action === "usage") {
      this.showError("Providers", request.message || PROVIDERS_USAGE);
      return;
    }
    await this.reload();
    if (request.action === "list") return this.showList();
    if (!request.name) {
      // Add without a name goes to the login picker. Edit and delete need a
      // choice, so they show the list instead.
      if (request.action === "add") return this.delegateLogin(undefined);
      return this.showList();
    }
    const entry = this.lookup(request.name);
    if (!entry) return;
    if (request.action === "delete") return this.confirmDelete(entry);
    this.delegateLogin(entry);
  }

  private confirmDelete(entry: ProviderEntry) {
    if (!deletable(entry)) {
      this.showError(
        "Nothing to delete",
        `${entry.name} holds no credential and has no custom definition.`,
      );
      return;
    }
    this.setPage({ kind: "confirm-delete", entry });
  }

  setQuery(query: string) {
    if (this.page.kind !== "list") return;
    this.query = query;
    this.cursor = 0;
    this.showList();
  }

  handleKey(key: LoginKey): boolean {
    const page = this.page;
    if (page.kind === "confirm-delete") {
      if (key.name === "y") {
        const entry = page.entry;
        this.setPage({ kind: "working", message: `Deleting ${entry.name}…` });
        this.run(async () => {
          try {
            await this.deps.remove(entry);
            await this.reload();
            this.showList();
          } catch (error) {
            this.showError(
              "Delete failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        });
        return true;
      }
      if (key.name === "n" || key.name === "escape") {
        this.showList();
        return true;
      }
      return false;
    }

    if (page.kind === "error" || page.kind === "success") {
      if (key.name === "escape" || key.name === "return") {
        this.deps.close();
        return true;
      }
      return false;
    }

    if (page.kind !== "list") return false;

    if (key.name === "escape") {
      if (this.searchFocused) {
        this.searchFocused = false;
        this.showList();
        return true;
      }
      this.deps.close();
      return true;
    }
    if (this.searchFocused) return false;
    if (key.name === "/") {
      this.searchFocused = true;
      this.showList();
      return true;
    }
    if (key.name === "down" || key.name === "up") {
      const count = page.entries.length;
      if (count === 0) return true;
      const step = key.name === "down" ? 1 : -1;
      this.cursor = Math.max(0, Math.min(count - 1, this.cursor + step));
      this.showList();
      return true;
    }
    const selected = page.entries[this.cursor];
    if (!selected) return false;
    if (key.name === "return") {
      this.delegateLogin(selected);
      return true;
    }
    if (key.name === "d") {
      this.confirmDelete(selected);
      return true;
    }
    return false;
  }

  /** Handle a key and wait for any work it started. For tests. */
  async handleKeyAsync(key: LoginKey): Promise<boolean> {
    const handled = this.handleKey(key);
    await this.settled();
    return handled;
  }
}

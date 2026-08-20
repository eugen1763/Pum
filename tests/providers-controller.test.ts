import { describe, expect, test } from "bun:test";
import { ProvidersController } from "../src/providers-controller";
import type { ProviderEntry } from "../src/providers-command";
import type { ProvidersPage } from "../src/providers-popup";

const anthropic: ProviderEntry = {
  id: "anthropic",
  name: "Anthropic",
  kind: "builtin",
  configured: true,
};
const openai: ProviderEntry = { id: "openai", name: "OpenAI", kind: "builtin", configured: true };
const openrouter: ProviderEntry = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "builtin",
  configured: false,
};
const custom: ProviderEntry = {
  id: "custom-a",
  name: "Custom (a)",
  kind: "custom",
  configured: false,
};

function harness(options: { entries?: ProviderEntry[]; removeError?: Error } = {}) {
  const entries = options.entries ?? [anthropic, custom, openai, openrouter];
  const pages: ProvidersPage[] = [];
  const removed: string[] = [];
  const loginRequests: (string | undefined)[] = [];
  let closed = false;
  const controller = new ProvidersController({
    loadEntries: async () => entries.filter((entry) => !removed.includes(entry.id)),
    show: (page) => pages.push(page),
    close: () => {
      closed = true;
    },
    startLogin: (entry) => loginRequests.push(entry?.id),
    remove: async (entry) => {
      if (options.removeError) throw options.removeError;
      removed.push(entry.id);
    },
  });
  return {
    controller,
    pages,
    removed,
    loginRequests,
    isClosed: () => closed,
    last: () => pages[pages.length - 1]!,
  };
}

function listOf(page: ProvidersPage): string[] {
  return page.kind === "list" ? page.entries.map((entry) => entry.id) : [];
}

function cursorOf(page: ProvidersPage): number {
  return page.kind === "list" ? page.cursor : -1;
}

function messageOf(page: ProvidersPage): string {
  return "message" in page ? page.message : "";
}

function entryIdOf(page: ProvidersPage): string {
  return page.kind === "confirm-delete" ? page.entry.id : "";
}

describe("opening the list", () => {
  test("shows every provider", async () => {
    const h = harness();

    await h.controller.open();

    expect(h.last().kind).toBe("list");
    expect(listOf(h.last())).toEqual(["anthropic", "custom-a", "openai", "openrouter"]);
  });

  test("starts with the first row selected", async () => {
    const h = harness();

    await h.controller.open();

    expect(cursorOf(h.last())).toBe(0);
  });
});

describe("moving through the list", () => {
  test("moves the cursor down", async () => {
    const h = harness();
    await h.controller.open();

    h.controller.handleKey({ name: "down" });

    expect(cursorOf(h.last())).toBe(1);
  });

  test("stops at the last row", async () => {
    const h = harness({ entries: [anthropic, openai] });
    await h.controller.open();

    h.controller.handleKey({ name: "down" });
    h.controller.handleKey({ name: "down" });
    h.controller.handleKey({ name: "down" });

    expect(cursorOf(h.last())).toBe(1);
  });

  test("stops at the first row", async () => {
    const h = harness();
    await h.controller.open();

    h.controller.handleKey({ name: "up" });

    expect(cursorOf(h.last())).toBe(0);
  });
});

describe("filtering", () => {
  test("keeps only the providers that match the query", async () => {
    const h = harness();
    await h.controller.open();

    h.controller.setQuery("open");

    expect(listOf(h.last())).toEqual(["openai", "openrouter"]);
  });

  test("pulls the cursor back inside the shortened list", async () => {
    const h = harness();
    await h.controller.open();
    h.controller.handleKey({ name: "down" });
    h.controller.handleKey({ name: "down" });
    h.controller.handleKey({ name: "down" });

    h.controller.setQuery("anthropic");

    expect(cursorOf(h.last())).toBe(0);
  });
});

describe("adding and editing", () => {
  test("hands the selected provider to the login flow", async () => {
    const h = harness();
    await h.controller.open();
    h.controller.handleKey({ name: "down" });

    h.controller.handleKey({ name: "return" });

    expect(h.loginRequests).toEqual(["custom-a"]);
  });

  test("opens the login picker for add without a name", async () => {
    const h = harness();

    await h.controller.open({ action: "add" });

    expect(h.loginRequests).toEqual([undefined]);
  });

  test("goes straight to a named provider", async () => {
    const h = harness();

    await h.controller.open({ action: "edit", name: "anthropic" });

    expect(h.loginRequests).toEqual(["anthropic"]);
  });

  test("reports an ambiguous name instead of guessing", async () => {
    const h = harness();

    await h.controller.open({ action: "edit", name: "open" });

    expect(h.last().kind).toBe("error");
    expect(messageOf(h.last())).toContain("OpenAI");
    expect(h.loginRequests).toEqual([]);
  });

  test("reports an unknown name", async () => {
    const h = harness();

    await h.controller.open({ action: "edit", name: "nope" });

    expect(h.last().kind).toBe("error");
    expect(h.loginRequests).toEqual([]);
  });
});

describe("deleting", () => {
  test("asks before it removes anything", async () => {
    const h = harness();
    await h.controller.open();

    h.controller.handleKey({ name: "d" });

    expect(h.last().kind).toBe("confirm-delete");
    expect(h.removed).toEqual([]);
  });

  test("removes the provider once confirmed", async () => {
    const h = harness();
    await h.controller.open();
    h.controller.handleKey({ name: "d" });

    await h.controller.handleKeyAsync({ name: "y" });

    expect(h.removed).toEqual(["anthropic"]);
  });

  test("returns to a refreshed list after deleting", async () => {
    const h = harness();
    await h.controller.open();
    h.controller.handleKey({ name: "d" });

    await h.controller.handleKeyAsync({ name: "y" });

    expect(h.last().kind).toBe("list");
    expect(listOf(h.last())).toEqual(["custom-a", "openai", "openrouter"]);
  });

  test("keeps the provider when the answer is no", async () => {
    const h = harness();
    await h.controller.open();
    h.controller.handleKey({ name: "d" });

    await h.controller.handleKeyAsync({ name: "n" });

    expect(h.removed).toEqual([]);
    expect(h.last().kind).toBe("list");
  });

  test("keeps the provider when the confirmation is cancelled", async () => {
    const h = harness();
    await h.controller.open();
    h.controller.handleKey({ name: "d" });

    await h.controller.handleKeyAsync({ name: "escape" });

    expect(h.removed).toEqual([]);
    expect(h.last().kind).toBe("list");
  });

  test("refuses a provider that has nothing to delete", async () => {
    const h = harness({ entries: [openrouter] });
    await h.controller.open();

    h.controller.handleKey({ name: "d" });

    expect(h.last().kind).toBe("error");
    expect(h.removed).toEqual([]);
  });

  test("confirms a named provider straight from the command", async () => {
    const h = harness();

    await h.controller.open({ action: "delete", name: "anthropic" });

    expect(h.last().kind).toBe("confirm-delete");
    expect(entryIdOf(h.last())).toBe("anthropic");
  });

  test("reports a failure instead of claiming success", async () => {
    const h = harness({ removeError: new Error("disk is full") });
    await h.controller.open();
    h.controller.handleKey({ name: "d" });

    await h.controller.handleKeyAsync({ name: "y" });

    expect(h.last().kind).toBe("error");
    expect(messageOf(h.last())).toContain("disk is full");
  });
});

describe("closing", () => {
  test("closes on escape from the list", async () => {
    const h = harness();
    await h.controller.open();

    h.controller.handleKey({ name: "escape" });

    expect(h.isClosed()).toBe(true);
  });

  test("shows usage for an unknown subcommand", async () => {
    const h = harness();

    await h.controller.open({ action: "usage", message: "Usage: /providers ..." });

    expect(h.last().kind).toBe("error");
    expect(messageOf(h.last())).toContain("Usage");
  });
});

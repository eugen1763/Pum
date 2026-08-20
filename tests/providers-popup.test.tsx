import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ProviderEntry } from "../src/providers-command";
import {
  deleteConfirmMessage,
  providerRowLabel,
  ProvidersPopup,
  type ProvidersPage,
} from "../src/providers-popup";
import { loadTheme } from "../src/theme";

const theme = loadTheme("tokyonight");
let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

const builtinIn: ProviderEntry = {
  id: "openai",
  name: "OpenAI",
  kind: "builtin",
  configured: true,
};
const builtinOut: ProviderEntry = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "builtin",
  configured: false,
};
const custom: ProviderEntry = {
  id: "custom-a",
  name: "Custom (a)",
  kind: "custom",
  configured: true,
};

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function frameFor(page: ProvidersPage, width = 64, height = 16) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <ProvidersPopup theme={theme} terminalWidth={width} terminalHeight={height} page={page} />
    </box>,
  );
  await settle(setup);
  return setup.captureCharFrame();
}

function listPage(entries: ProviderEntry[], cursor = 0): ProvidersPage {
  return { kind: "list", entries, cursor, query: "", searchFocused: true };
}

describe("providerRowLabel", () => {
  test("marks a built-in provider that holds a credential", () => {
    expect(providerRowLabel(builtinIn)).toBe("OpenAI — logged in");
  });

  test("marks a built-in provider without a credential", () => {
    expect(providerRowLabel(builtinOut)).toBe("OpenRouter — not logged in");
  });

  test("marks a custom provider as custom", () => {
    expect(providerRowLabel(custom)).toBe("Custom (a) — custom, logged in");
  });
});

describe("deleteConfirmMessage", () => {
  test("says a built-in provider can be added again", () => {
    const message = deleteConfirmMessage(builtinIn);

    expect(message).toContain("OpenAI");
    expect(message).toContain("add it again");
    expect(message).not.toContain("models.json");
  });

  test("warns that a custom provider loses its definition", () => {
    const message = deleteConfirmMessage(custom);

    expect(message).toContain("Custom (a)");
    expect(message).toContain("models.json");
  });
});

describe("ProvidersPopup", () => {
  test("lists every provider with its status", async () => {
    const frame = await frameFor(listPage([builtinIn, builtinOut, custom]));

    expect(frame).toContain("OpenAI");
    expect(frame).toContain("not logged in");
    expect(frame).toContain("custom");
  });

  test("marks the selected row", async () => {
    const frame = await frameFor(listPage([builtinIn, builtinOut], 1));

    expect(frame).toContain("› OpenRouter");
  });

  test("tells the user when the filter matches nothing", async () => {
    const frame = await frameFor({
      kind: "list",
      entries: [],
      cursor: 0,
      query: "zzz",
      searchFocused: true,
    });

    expect(frame).toContain("No matching providers");
  });

  test("asks before it deletes", async () => {
    const frame = await frameFor({ kind: "confirm-delete", entry: custom });

    expect(frame).toContain("Custom (a)");
    expect(frame).toContain("models.json");
  });

  test("shows an error with its title", async () => {
    const frame = await frameFor({ kind: "error", title: "Delete failed", message: "disk is full" });

    expect(frame).toContain("Delete failed");
    expect(frame).toContain("disk is full");
  });
});

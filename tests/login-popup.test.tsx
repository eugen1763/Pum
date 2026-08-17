import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { LoginMethod } from "../src/login-flow";
import { loginTextFooter, LoginPopup, type LoginPage } from "../src/login-popup";
import { loadTheme } from "../src/theme";

const theme = loadTheme("tokyonight");
let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function providerMethods(count = 12): LoginMethod[] {
  return Array.from({ length: count }, (_, index) => ({
    providerId: `provider-${index}`,
    providerName: `Provider ${String(index).padStart(2, "0")}`,
    authType: "api_key" as const,
    methodName: "API key",
    canLogin: true,
  }));
}

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
}

async function frameFor(page: LoginPage, width: number, height = 16) {
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <LoginPopup theme={theme} terminalWidth={width} terminalHeight={height} page={page} />
    </box>,
  );
  await settle(setup);
  return setup.captureCharFrame();
}

async function providerHarness(width = 60, height = 12) {
  const methods = providerMethods();
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  const root = createRoot(setup.renderer);
  const render = async (page: LoginPage) => {
    root.render(
      <box style={{ width, height }}>
        <LoginPopup theme={theme} terminalWidth={width} terminalHeight={height} page={page} />
      </box>,
    );
    await settle(setup);
  };
  const providerPage = (cursor: number, query = "", searchFocused = false): LoginPage => ({
    kind: "providers",
    methods,
    cursor,
    query,
    searchFocused,
    customVisible: true,
  });
  const selectedText = () => setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .filter((span) => span.bg.equals(parseColor(theme.selectionBg)))
    .map((span) => span.text)
    .join("");
  return { setup, render, providerPage, selectedText, methods };
}

describe("login popup", () => {
  test("shows concise paste guidance for wide and narrow login fields", async () => {
    expect(loginTextFooter(60, "continue", "back")).toBe(
      "enter continue   paste / ctrl+v local   esc back",
    );
    expect(loginTextFooter(34, "discover", "back")).toBe(
      "enter local ctrl+v/paste esc",
    );

    const frame = await frameFor({
      kind: "custom-endpoint",
      endpoint: "",
      cursor: 0,
    }, 34, 10);
    expect(frame).toContain("local ctrl+v");
    expect(frame.split("\n").every((line) => Array.from(line).length <= 34)).toBe(true);
  });

  test("keeps provider setup usable in a narrow terminal", async () => {
    const frame = await frameFor({
      kind: "providers",
      methods: [],
      cursor: 0,
      query: "",
      searchFocused: true,
      customVisible: true,
    }, 42);
    expect(frame).toContain("Custom OpenAI-compatible provider");
    expect(frame).toContain("esc");
  });

  test("renders search, empty results, and footer in a short narrow terminal", async () => {
    const frame = await frameFor({
      kind: "providers",
      methods: [],
      cursor: 0,
      query: "missing",
      searchFocused: true,
      customVisible: false,
    }, 34, 10);
    expect(frame).toContain("Search");
    expect(frame).toContain("No matching providers");
    expect(frame).toContain("/ search");
    expect(frame.split("\n").every((line) => Array.from(line).length <= 34)).toBe(true);
  });

  test("renders only a mask for submitted secret input", async () => {
    const frame = await frameFor({
      kind: "prompt",
      providerName: "Provider",
      prompt: { type: "secret", message: "Enter API key" },
      cursor: 0,
      value: "",
      secretLength: 12,
    }, 60);
    expect(frame).toContain("••••••••••••");
    expect(frame).not.toContain("secret-value");
  });

  test("renders the caret at the actual public and secret cursor positions", async () => {
    const endpoint = await frameFor({
      kind: "custom-endpoint",
      endpoint: "abcd",
      cursor: 2,
    }, 60);
    expect(endpoint).toContain("ab▌cd");

    const secret = await frameFor({
      kind: "custom-key",
      endpoint: "https://example.test/v1",
      secretLength: 4,
      cursor: 2,
    }, 60);
    expect(secret).toContain("••▌••");
    expect(secret).not.toContain("secret-value");
  });

  test("keeps an auth URL visible on the immediate manual-code prompt", async () => {
    const frame = await frameFor({
      kind: "prompt",
      providerName: "OpenAI Codex",
      prompt: { type: "manual_code", message: "Paste the authorization code" },
      event: {
        type: "auth_url",
        url: "https://login.example.test/oauth?state=abc",
        instructions: "Open this URL in a browser:",
      },
      cursor: 0,
      value: "",
      secretLength: 0,
    }, 72);
    expect(frame).toContain("https://login.example.test/oauth?state=abc");
    expect(frame).toContain("Paste the authorization code");
  });

  test("scrolls downward to keep a later provider selected and visible", async () => {
    const harness = await providerHarness();
    await harness.render(harness.providerPage(0));
    await harness.render(harness.providerPage(10));

    const frame = harness.setup.captureCharFrame();
    expect(frame).toContain("Provider 10");
    expect(frame).not.toContain("Provider 00");
    expect(harness.selectedText()).toContain("Provider 10");
  });

  test("scrolls upward to keep an earlier provider selected and visible", async () => {
    const harness = await providerHarness();
    await harness.render(harness.providerPage(10));
    await harness.render(harness.providerPage(1));

    const frame = harness.setup.captureCharFrame();
    expect(frame).toContain("Provider 01");
    expect(frame).not.toContain("Provider 10");
    expect(harness.selectedText()).toContain("Provider 01");
  });

  test("keeps both wrapped provider-list endpoints visible", async () => {
    const harness = await providerHarness();
    await harness.render(harness.providerPage(harness.methods.length));
    expect(harness.setup.captureCharFrame()).toContain("Custom OpenAI-compatible provider");
    expect(harness.selectedText()).toContain("Custom OpenAI-compatible provider");

    await harness.render(harness.providerPage(0));
    expect(harness.setup.captureCharFrame()).toContain("Provider 00");
    expect(harness.selectedText()).toContain("Provider 00");

    await harness.render(harness.providerPage(harness.methods.length));
    expect(harness.selectedText()).toContain("Custom OpenAI-compatible provider");
  });

  test("restores the selected row after custom-provider and auth-flow pages", async () => {
    const harness = await providerHarness();
    await harness.render(harness.providerPage(9));
    await harness.render({ kind: "custom-endpoint", endpoint: "", cursor: 0 });
    await harness.render(harness.providerPage(9));
    expect(harness.selectedText()).toContain("Provider 09");

    await harness.render({ kind: "working", providerName: "Provider 09" });
    await harness.render(harness.providerPage(9));
    expect(harness.selectedText()).toContain("Provider 09");
  });

  test("keeps an overflow selection visible in a narrow and short terminal", async () => {
    const harness = await providerHarness(34, 10);
    await harness.render(harness.providerPage(11));

    const frame = harness.setup.captureCharFrame();
    expect(frame).toContain("Provider 11");
    expect(frame).toContain("↑↓ move");
    expect(harness.selectedText()).toContain("Provider 11");
    expect(frame.split("\n").every((line) => line.length <= 34)).toBe(true);
  });
});

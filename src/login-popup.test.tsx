import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { LoginMethod } from "./login-flow";
import { LoginPopup, type LoginPage } from "./login-popup";
import { loadTheme } from "./theme";

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
  const providerPage = (cursor: number): LoginPage => ({ kind: "providers", methods, cursor });
  const selectedText = () => setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .filter((span) => span.bg.equals(parseColor(theme.selectionBg)))
    .map((span) => span.text)
    .join("");
  return { setup, render, providerPage, selectedText, methods };
}

describe("login popup", () => {
  test("keeps provider setup usable in a narrow terminal", async () => {
    const frame = await frameFor({ kind: "providers", methods: [], cursor: 0 }, 42);
    expect(frame).toContain("Custom OpenAI-compatible provider");
    expect(frame).toContain("esc close");
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
    await harness.render({ kind: "custom-endpoint", endpoint: "" });
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

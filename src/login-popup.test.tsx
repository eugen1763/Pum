import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { LoginPopup } from "./login-popup";
import { loadTheme } from "./theme";

const theme = loadTheme("tokyonight");

async function frameFor(page: Parameters<typeof LoginPopup>[0]["page"], width: number) {
  const setup = await createTestRenderer({ width, height: 16 });
  createRoot(setup.renderer).render(
    <box style={{ width, height: 16 }}>
      <LoginPopup theme={theme} terminalWidth={width} terminalHeight={16} page={page} />
    </box>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
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
});

import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { PopupFrame, popupShadowVisible } from "./popup-frame";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

describe("popup frame", () => {
  test("shows a shadow only when the offset rectangle stays inside the terminal", () => {
    expect(popupShadowVisible({ top: 1, left: 1, width: 20, height: 8 }, 40, 20)).toBe(true);
    expect(popupShadowVisible({ top: 0, left: 0, width: 40, height: 20 }, 40, 20)).toBe(false);
    expect(popupShadowVisible({ top: 1, left: 1, width: 39, height: 8 }, 40, 20)).toBe(false);
  });

  test("renders the semantic shadow behind the popup without covering content", async () => {
    const theme = loadTheme("tokyonight");
    const setup = await createTestRenderer({ width: 32, height: 12 });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <box style={{ width: 32, height: 12, backgroundColor: theme.bg }}>
        <box style={{ position: "absolute", top: 0, left: 0, width: 32, height: 12, flexDirection: "column" }}>
          {Array.from({ length: 12 }, (_, row) => (
            <text key={row} content={".".repeat(32)} fg={theme.dim} bg={theme.bg} wrapMode="none" />
          ))}
        </box>
        <PopupFrame
          theme={theme}
          terminalWidth={32}
          terminalHeight={12}
          geometry={{ top: 1, left: 2, width: 24, height: 8 }}
          zIndex={100}
          title=" Test "
        >
          <text content="popup content" fg={theme.fg} bg={theme.popupBg} />
        </PopupFrame>
      </box>,
    );
    await setup.renderOnce();
    await setup.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.flush();
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.some((span) => span.fg.equals(parseColor(theme.popupShadow)))).toBe(true);
    const content = spans.find((span) => span.text.includes("popup content"));
    expect(content?.bg.equals(parseColor(theme.popupBg))).toBe(true);
    expect(setup.captureCharFrame().split("\n").every((line) => Array.from(line).length <= 32)).toBe(true);
  });
});

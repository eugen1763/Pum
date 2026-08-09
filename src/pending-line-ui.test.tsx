import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { PendingMessageLine } from "./transcript";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

describe("pending transcript messages", () => {
  test("renders queued steering at the transcript bottom style", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <PendingMessageLine
        theme={loadTheme("tokyonight")}
        pending={{
          id: "pending-1",
          deliveryText: "steer after tools",
          line: { kind: "text", role: "user", text: "steer after tools" },
        }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("○ steer after tools");
  });

  test("labels queued inter-agent messages", async () => {
    const setup = await createTestRenderer({ width: 60, height: 4 });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <PendingMessageLine
        theme={loadTheme("tokyonight")}
        pending={{
          id: "pending-2",
          line: {
            kind: "agent-message",
            sender: "alpha",
            recipient: "beta",
            text: "review this change",
          },
        }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("alpha → beta · queued");
    expect(frame).toContain("review this change");
  });
});

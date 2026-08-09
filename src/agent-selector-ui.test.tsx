import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { AgentSelectorPopup } from "./agent-selector";
import { loadTheme } from "./theme";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

describe("agent selector layout", () => {
  test("wraps deep tree labels inside a narrow popup", async () => {
    const setup = await createTestRenderer({ width: 24, height: 16 });
    destroy = () => setup.renderer.destroy();
    createRoot(setup.renderer).render(
      <AgentSelectorPopup
        theme={loadTheme("tokyonight")}
        cursor={1}
        rows={[
          { id: null, name: "main", depth: 0 },
          { id: "deep", name: "very-long-agent-label-suffix", status: "running", depth: 6 },
        ]}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const compact = frame.replace(/[\s█▀│┌┐└┘─]/g, "");
    expect(compact).toContain("very-long-agent-label-suffix");
    expect(frame.split("\n").every((line) => line.length <= 24)).toBe(true);
  });
});

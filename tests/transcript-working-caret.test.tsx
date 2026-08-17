import { afterEach, describe, expect, test } from "bun:test";
import { useEffect, useState } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { TextLine, ToolLine, type Role } from "../src/transcript";
import { loadTheme } from "../src/theme";
import type { ToolCall } from "../src/tool-line";
import type { SyntaxStyle } from "@opentui/core";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.renderOnce();
  await setup.flush();
}

/**
 * Change the `workingCaret` prop on a mounted line in place. This reproduces
 * the `/check-path` flow: the line first renders as a plain row, then the app
 * becomes busy and the same row gains a working caret. OpenTUI 0.5.1 crashes
 * when a `<text>` element receives `content={undefined}` from React on an
 * update, so the row must keep a defined content value while the caret hooks
 * own the renderable.
 */
function TextLineHarness({ role, text }: { role: Role; text: string }) {
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWorking(true), 5);
    return () => clearTimeout(timer);
  }, []);
  const style = {} as SyntaxStyle;
  return (
    <TextLine
      theme={loadTheme("tokyonight")}
      syntaxStyle={style}
      role={role}
      text={text}
      workingCaret={working}
    />
  );
}

function ToolLineHarness() {
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWorking(true), 5);
    return () => clearTimeout(timer);
  }, []);
  const call: ToolCall = { id: "tool", name: "bash", args: ["ls"], state: "running" };
  return <ToolLine theme={loadTheme("tokyonight")} call={call} workingCaret={working} />;
}

describe("working caret does not clear text content", () => {
  test("text row survives an in-place workingCaret transition", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    destroy = () => setup.renderer.destroy();
    const message = "allowed Check mode path: D:\\dev\\local-ai-server";

    const root = createRoot(setup.renderer);
    root.render(<TextLineHarness role="system" text={message} />);
    await settle(setup);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.renderOnce();
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain(message);
    expect(frame).toContain("\u258A");
  });

  test("tool row survives an in-place workingCaret transition", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    destroy = () => setup.renderer.destroy();

    const root = createRoot(setup.renderer);
    root.render(<ToolLineHarness />);
    await settle(setup);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.renderOnce();
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("bash");
    expect(frame).toContain("ls");
  });
});

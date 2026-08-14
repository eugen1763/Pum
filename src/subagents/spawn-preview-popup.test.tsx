import { afterEach, describe, expect, test } from "bun:test";
import { MarkdownRenderable, type BaseRenderable, type TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { createRef } from "react";
import { buildSyntaxStyle } from "../syntax";
import { loadTheme } from "../theme";
import { SpawnPreviewPopup, spawnPreviewPopupGeometry } from "./spawn-preview-popup";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

function markdownContent(root: BaseRenderable): string[] {
  const content: string[] = [];
  const visit = (node: BaseRenderable) => {
    if (node instanceof MarkdownRenderable) content.push(node.content);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return content;
}

const request: any = {
  id: "spawn-preview-1",
  requester: { sessionId: "child-session", agentId: "child", name: "worker" },
  options: {
    task: "# Exact child task\n\nUse `src/app.tsx` and keep **Markdown** static.",
    name: "worker",
    modelId: "mock/model",
    thinkingLevel: "off",
  },
};

async function render(width: number, height: number) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  destroy = () => setup.renderer.destroy();
  const theme = loadTheme("tokyonight");
  const inputRef = createRef<TextareaRenderable>();
  flushSync(() => createRoot(setup.renderer).render(
    <SpawnPreviewPopup
      theme={theme}
      syntaxStyle={buildSyntaxStyle(theme)}
      request={request}
      terminalWidth={width}
      terminalHeight={height}
      inputRef={inputRef}
    />,
  ));
  await setup.renderOnce();
  await setup.flush();
  return { setup, inputRef };
}

describe("spawn preview popup", () => {
  test("keeps responsive geometry inside narrow and short terminals", () => {
    for (const [width, height] of [[80, 24], [32, 8], [3, 4]] as const) {
      const geometry = spawnPreviewPopupGeometry(width, height);
      expect(geometry.left + geometry.width).toBeLessThanOrEqual(width);
      expect(geometry.top + geometry.height).toBeLessThanOrEqual(height);
    }
  });

  test("renders exact static Markdown and focuses the optional note", async () => {
    const { setup, inputRef } = await render(64, 16);
    const frame = setup.captureCharFrame();
    expect(markdownContent(setup.renderer.root)).toContain(request.options.task);
    expect(frame).toContain("Optional note");
    expect(frame).toContain("Context · fresh");
    expect(frame).toContain("Source · none");
    expect(frame).toContain("Enter approve");
    expect(inputRef.current?.focused).toBe(true);
  });

  test("shows fork context and the immediate requester source", async () => {
    request.options.context = "fork";
    const { setup } = await render(72, 18);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Context · fork");
    expect(frame).toContain("Source · worker · session child-session");
    delete request.options.context;
  });

  test("remains usable without a frame in a short terminal", async () => {
    const { setup } = await render(32, 6);
    const frame = setup.captureCharFrame();
    expect(markdownContent(setup.renderer.root)).toContain(request.options.task);
    expect(frame).toContain("Add");
  });
});

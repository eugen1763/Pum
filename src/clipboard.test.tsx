import { afterEach, describe, expect, test } from "bun:test";
import { CliRenderEvents, MarkdownRenderable, type BaseRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { copySelectionText, installSelectionClipboard } from "./clipboard";
import { buildSyntaxStyle } from "./syntax";
import { loadTheme } from "./theme";
import { TextLine } from "./transcript";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
});

function descendants<T extends BaseRenderable>(
  root: BaseRenderable,
  type: abstract new (...args: any[]) => T,
): T[] {
  const found: T[] = [];
  const visit = (node: BaseRenderable) => {
    if (node instanceof type) found.push(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return found;
}

describe("selection clipboard routes", () => {
  test("uses the native clipboard for local Windows selections", async () => {
    const copied: string[] = [];
    const route = await copySelectionText("native Windows text", {
      platform: "win32",
      env: {},
      nativeClipboard: { setText: async (text) => { copied.push(text); } },
      runner: async () => { throw new Error("must not run"); },
      osc52: () => false,
    });

    expect(route).toBe("native");
    expect(copied).toEqual(["native Windows text"]);
  });

  test("falls back to clip.exe before OSC 52 on local Windows", async () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];
    const route = await copySelectionText("command text", {
      platform: "win32",
      env: {},
      nativeClipboard: null,
      runner: async (command, args, input) => { calls.push({ command, args, input }); },
      osc52: () => false,
    });

    expect(route).toBe("command");
    expect(calls).toEqual([{ command: "clip.exe", args: [], input: "command text" }]);
  });

  test("uses OSC 52 instead of a remote Linux clipboard", async () => {
    const payloads: string[] = [];
    const route = await copySelectionText("remote tmux text", {
      platform: "linux",
      env: { SSH_CONNECTION: "client server", TMUX: "/tmp/tmux" },
      runner: async () => { throw new Error("must not run"); },
      osc52: (text) => { payloads.push(text); return true; },
    });

    expect(route).toBe("osc52");
    expect(payloads).toEqual(["remote tmux text"]);
  });

  test("rejects oversized OSC 52 output before writing it", async () => {
    let writes = 0;
    await expect(copySelectionText("x".repeat(75_001), {
      platform: "linux",
      env: { SSH_CLIENT: "client" },
      osc52: () => { writes++; return true; },
    })).rejects.toThrow("OSC 52");
    expect(writes).toBe(0);
  });
});

describe("transcript selection", () => {
  test("copies selected transcript Markdown from the completed selection event", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    destroy = () => setup.renderer.destroy();
    const copied: string[] = [];
    const binding = installSelectionClipboard(setup.renderer, {
      platform: "win32",
      env: {},
      nativeClipboard: { setText: async (text) => { copied.push(text); } },
    });
    const theme = loadTheme("tokyonight");
    createRoot(setup.renderer).render(
      <TextLine
        theme={theme}
        syntaxStyle={buildSyntaxStyle(theme)}
        role="assistant"
        text="select this transcript text"
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setup.renderOnce();
    await setup.flush();

    const markdown = descendants(setup.renderer.root, MarkdownRenderable)[0]!;
    setup.renderer.startSelection(markdown, markdown.x, markdown.y);
    setup.renderer.updateSelection(markdown, markdown.x + markdown.width - 1, markdown.y, {
      finishDragging: true,
    });
    setup.renderer.emit(CliRenderEvents.SELECTION, setup.renderer.getSelection()!);
    await binding.flush();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("select this transcript text");
    binding.dispose();
  });
});

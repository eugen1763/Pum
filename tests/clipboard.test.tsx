import { afterEach, describe, expect, test } from "bun:test";
import {
  CliRenderEvents,
  MarkdownRenderable,
  TextRenderable,
  type BaseRenderable,
  type Renderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { copySelectionText, installSelectionClipboard } from "../src/clipboard";
import { buildSyntaxStyle } from "../src/syntax";
import { loadTheme } from "../src/theme";
import {
  AgentMessageLine,
  PendingMessageLine,
  StreamLine,
  TextLine,
  ToolLine,
} from "../src/transcript";

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

async function settle(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await setup.renderOnce();
  await setup.flush();
}

function completeSelection(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  renderable: Renderable,
) {
  setup.renderer.startSelection(renderable, renderable.x, renderable.y);
  setup.renderer.updateSelection(
    renderable,
    renderable.x + renderable.width - 1,
    renderable.y + renderable.height - 1,
    { finishDragging: true },
  );
  setup.renderer.emit(CliRenderEvents.SELECTION, setup.renderer.getSelection()!);
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
    await settle(setup);

    const markdown = descendants(setup.renderer.root, MarkdownRenderable)[0]!;
    completeSelection(setup, markdown);
    await binding.flush();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("select this transcript text");
    binding.dispose();
  });

  test("copies selectable thinking, system, and error plain text", async () => {
    const setup = await createTestRenderer({ width: 48, height: 8 });
    destroy = () => setup.renderer.destroy();
    const copied: string[] = [];
    const binding = installSelectionClipboard(setup.renderer, {
      platform: "win32",
      env: {},
      nativeClipboard: { setText: async (text) => { copied.push(text); } },
    });
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="thinking" text="plain thinking text" />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="system" text="plain system text" />
        <TextLine theme={theme} syntaxStyle={syntaxStyle} role="error" text="plain error text" />
      </box>,
    );
    await settle(setup);

    const textRows = descendants(setup.renderer.root, TextRenderable);
    expect(textRows).toHaveLength(3);
    expect(textRows.every((renderable) => renderable.selectable)).toBe(true);
    for (const text of textRows) completeSelection(setup, text);
    await binding.flush();

    expect(copied).toHaveLength(3);
    expect(copied[0]).toContain("plain thinking text");
    expect(copied[1]).toContain("plain system text");
    expect(copied[2]).toContain("plain error text");
    binding.dispose();
  });

  test("copies selectable tool name, argument, and detail renderables", async () => {
    const setup = await createTestRenderer({ width: 52, height: 8 });
    destroy = () => setup.renderer.destroy();
    const copied: string[] = [];
    const binding = installSelectionClipboard(setup.renderer, {
      platform: "win32",
      env: {},
      nativeClipboard: { setText: async (text) => { copied.push(text); } },
    });
    const theme = loadTheme("tokyonight");
    createRoot(setup.renderer).render(
      <ToolLine
        theme={theme}
        call={{ id: "edit", name: "edit", args: ["src/file.ts"], detail: "+2 −1", state: "running" }}
        workingCaret
      />,
    );
    await settle(setup);

    const textRows = descendants(setup.renderer.root, TextRenderable);
    const [prefix, body] = textRows;
    expect(prefix?.selectable).toBe(true);
    expect(body?.selectable).toBe(true);
    expect(prefix?.plainText).toContain("edit(");
    expect(body?.plainText).toContain("src/file.ts)  +2 −1");

    completeSelection(setup, body!);
    await binding.flush();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("src/file.ts)  +2 −1");
    binding.dispose();
  });

  test("marks streaming thinking and agent headers as selectable", async () => {
    const setup = await createTestRenderer({ width: 52, height: 12 });
    destroy = () => setup.renderer.destroy();
    const theme = loadTheme("tokyonight");
    const syntaxStyle = buildSyntaxStyle(theme);
    createRoot(setup.renderer).render(
      <box style={{ flexDirection: "column", width: "100%" }}>
        <StreamLine theme={theme} syntaxStyle={syntaxStyle} role="thinking" text="streaming trace" />
        <AgentMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          line={{ kind: "agent-message", sender: "main", recipient: "worker", text: "message" }}
        />
        <PendingMessageLine
          theme={theme}
          syntaxStyle={syntaxStyle}
          pending={{
            id: "pending",
            line: { kind: "agent-message", sender: "worker", recipient: "main", text: "reply" },
          }}
        />
      </box>,
    );
    await settle(setup);

    const textRows = descendants(setup.renderer.root, TextRenderable);
    const contentRows = textRows.filter((renderable) => renderable.x > 0);
    expect(contentRows).toHaveLength(3);
    expect(contentRows.every((renderable) => renderable.selectable)).toBe(true);
  });
});

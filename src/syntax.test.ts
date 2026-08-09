import { describe, expect, test } from "bun:test";
import { CodeRenderable, type BaseRenderable } from "@opentui/core";
import { settleSyntaxHighlighting } from "./syntax";

function codeRenderable(highlightingDone: Promise<void>): CodeRenderable {
  const renderable = Object.create(CodeRenderable.prototype) as CodeRenderable;
  Object.defineProperty(renderable, "highlightingDone", { value: highlightingDone });
  renderable.getChildren = () => [];
  return renderable;
}

describe("syntax highlighting teardown", () => {
  test("waits for nested highlight requests", async () => {
    let settled = false;
    const highlight = Promise.resolve().then(() => { settled = true; });
    const root = { getChildren: () => [codeRenderable(highlight)] } as unknown as BaseRenderable;

    await settleSyntaxHighlighting(root);

    expect(settled).toBe(true);
  });

  test("propagates genuine highlighting failures", async () => {
    const failure = new Error("highlight failed");
    const root = {
      getChildren: () => [codeRenderable(Promise.reject(failure))],
    } as unknown as BaseRenderable;

    await expect(settleSyntaxHighlighting(root)).rejects.toBe(failure);
  });
});

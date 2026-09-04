import { TextRenderable } from "@opentui/core";
import { extend } from "@opentui/react";

/** A fixed tail viewport: wheel events belong to the enclosing transcript. */
export class BashTailTextRenderable extends TextRenderable {
  protected override handleScroll(): void {}
}

extend({ bash_tail_text: BashTailTextRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    bash_tail_text: typeof BashTailTextRenderable;
  }
}

import { CodeRenderable, SyntaxStyle, type BaseRenderable } from "@opentui/core";
import type { Theme } from "./theme";
import { registerVendoredGrammars } from "./syntax-grammars";

// Every path that highlights anything comes through here for its SyntaxStyle,
// so this is the one place that can guarantee the extra grammars are declared
// before a client starts. Declaring costs nothing until a buffer needs one.
registerVendoredGrammars();

/** Wait for every highlight request that belongs to a renderable tree. */
export async function settleSyntaxHighlighting(root: BaseRenderable): Promise<void> {
  const pending: Promise<void>[] = [];
  const visit = (renderable: BaseRenderable) => {
    if (renderable instanceof CodeRenderable) pending.push(renderable.highlightingDone);
    for (const child of renderable.getChildren()) visit(child);
  };
  visit(root);

  const results = await Promise.allSettled(pending);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

/**
 * OpenTUI's <markdown> and <code> need a SyntaxStyle and ship no default. The
 * keys are tree-sitter capture names from the bundled highlight queries;
 * lookup falls back along the dots, so "markup.heading" covers
 * "markup.heading.1" and friends.
 */
export function buildSyntaxStyle(t: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: t.assistant },
    conceal: { fg: t.dim },

    // markdown. Headings are only ever captured numbered (markup.heading.1…6)
    // and the tree-sitter path does not fall back along the dots, so each
    // level has to be registered.
    "markup.heading": { fg: t.accent, bold: true },
    "markup.heading.1": { fg: t.accent, bold: true },
    "markup.heading.2": { fg: t.accent, bold: true },
    "markup.heading.3": { fg: t.accent, bold: true },
    "markup.heading.4": { fg: t.accent },
    "markup.heading.5": { fg: t.accent },
    "markup.heading.6": { fg: t.accent },
    "markup.list": { fg: t.tool },
    "markup.list.checked": { fg: t.success },
    "markup.list.unchecked": { fg: t.dim },
    "markup.quote": { fg: t.dim, italic: true },
    "markup.raw": { fg: t.toolArg },
    "markup.raw.block": { fg: t.toolArg },
    "markup.strong": { fg: t.fg, bold: true },
    "markup.italic": { fg: t.fg, italic: true },
    "markup.strikethrough": { fg: t.dim, dim: true },
    "markup.link": { fg: t.accent, underline: true },
    "markup.link.label": { fg: t.accent },
    "markup.link.url": { fg: t.dim, underline: true },
    label: { fg: t.accent },
    "character.special": { fg: t.tool },

    // code
    keyword: { fg: t.codeKeyword },
    operator: { fg: t.codeKeyword },
    string: { fg: t.codeString },
    "string.escape": { fg: t.codeNumber },
    number: { fg: t.codeNumber },
    boolean: { fg: t.codeNumber },
    constant: { fg: t.codeNumber },
    comment: { fg: t.codeComment, italic: true },
    function: { fg: t.codeFunction },
    constructor: { fg: t.codeFunction },
    type: { fg: t.codeType },
    attribute: { fg: t.codeType },
    module: { fg: t.codeType },
    variable: { fg: t.fg },
    property: { fg: t.fg },
    "punctuation.delimiter": { fg: t.dim },
    "punctuation.bracket": { fg: t.dim },
    "punctuation.special": { fg: t.dim },
  });
}

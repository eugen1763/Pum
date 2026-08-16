import { addDefaultParsers } from "@opentui/core";
import { join } from "node:path";

/**
 * Extra tree-sitter grammars vendored beside PUM's source.
 *
 * OpenTUI ships JavaScript, TypeScript, Markdown and Zig and nothing else, so
 * a diff in any other language rendered as flat text. These five cover what a
 * coding agent actually edits most often after those four. The grammars are
 * vendored rather than downloaded: a diff has to highlight offline, inside a
 * sandbox, and on the very first run, with no latency and nothing to fail.
 */
export const VENDORED_GRAMMARS = [
  { filetype: "python", aliases: ["py"] },
  { filetype: "json", aliases: ["jsonc"] },
  { filetype: "bash", aliases: ["sh", "shell", "zsh"] },
  { filetype: "rust", aliases: ["rs"] },
  { filetype: "go", aliases: [] },
] as const;

export const GRAMMAR_ROOT = join(import.meta.dir, "..", "assets", "tree-sitter");

export function grammarAssetPaths(filetype: string): { wasm: string; highlights: string } {
  return {
    wasm: join(GRAMMAR_ROOT, filetype, `tree-sitter-${filetype}.wasm`),
    highlights: join(GRAMMAR_ROOT, filetype, "highlights.scm"),
  };
}

let registered = false;

/**
 * Register the vendored grammars once, before any renderable asks to
 * highlight. Registration is a declaration, not a load: nothing is read from
 * disk until a buffer of that filetype appears.
 */
export function registerVendoredGrammars(): void {
  if (registered) return;
  registered = true;
  addDefaultParsers(VENDORED_GRAMMARS.map(({ filetype, aliases }) => {
    const paths = grammarAssetPaths(filetype);
    return {
      filetype,
      ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
      wasm: paths.wasm,
      queries: { highlights: [paths.highlights] },
    };
  }));
}

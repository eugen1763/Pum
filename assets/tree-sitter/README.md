# Vendored tree-sitter grammars

OpenTUI ships parsers for JavaScript, TypeScript, Markdown and Zig only. These
five cover the next most common languages a diff in the transcript carries.
They are committed rather than downloaded so that a diff highlights offline,
inside a sandbox, and on the first run.

`src/syntax-grammars.ts` declares them; `src/syntax.ts` registers them once.

| Language | `.wasm` from | `highlights.scm` from |
|---|---|---|
| python | npm `tree-sitter-wasms@0.1.13`, `out/` | `tree-sitter/tree-sitter-python`, `queries/highlights.scm` |
| json | npm `tree-sitter-wasms@0.1.13`, `out/` | `tree-sitter/tree-sitter-json`, `queries/highlights.scm` |
| bash | npm `tree-sitter-wasms@0.1.13`, `out/` | `tree-sitter/tree-sitter-bash`, `queries/highlights.scm` |
| rust | npm `@repomix/tree-sitter-wasms@0.1.17`, `out/` | `tree-sitter/tree-sitter-rust`, `queries/highlights.scm` |
| go | npm `tree-sitter-wasms@0.1.13`, `out/` | `tree-sitter/tree-sitter-go`, `queries/highlights.scm` |

Rust comes from a different build on purpose. The `tree-sitter-wasms` rust
binary still exports `tree_sitter_rust_external_scanner_reset`, dropped from
the external-scanner ABI after version 13, and web-tree-sitter 0.25 refuses to
load it — `preloadParser` returns false and every rust diff renders flat.

`syntax-grammars.test.ts` highlights a sample of each language and asserts the
captures are ones `buildSyntaxStyle` colours. Run it after replacing any file
here: a grammar that loads but produces unmapped captures looks identical to
no grammar at all.

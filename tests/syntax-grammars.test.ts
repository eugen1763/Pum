import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { getTreeSitterClient } from "@opentui/core";
import "../src/syntax";
import { previewLanguage } from "../src/tool-preview";
import { VENDORED_GRAMMARS, grammarAssetPaths } from "../src/syntax-grammars";

const SAMPLES: Record<string, string> = {
  python: "def total(items):\n    # add them up\n    return sum(x for x in items)\n",
  json: '{"name": "pum", "version": 2, "beta": true}\n',
  bash: "set -euo pipefail\n# run it\nfor f in *.ts; do echo \"$f\"; done\n",
  rust: "fn main() {\n    // greet\n    let name: String = String::from(\"pum\");\n}\n",
  go: "package main\n\n// greet\nfunc main() {\n\ts := \"pum\"\n\t_ = s\n}\n",
};

describe("vendored tree-sitter grammars", () => {
  test("ships a wasm and a highlight query for every declared grammar", () => {
    for (const { filetype } of VENDORED_GRAMMARS) {
      const paths = grammarAssetPaths(filetype);
      expect(`${filetype}: ${existsSync(paths.wasm)}`).toBe(`${filetype}: true`);
      expect(`${filetype}: ${existsSync(paths.highlights)}`).toBe(`${filetype}: true`);
      expect(statSync(paths.wasm).size).toBeGreaterThan(1000);
      expect(statSync(paths.highlights).size).toBeGreaterThan(100);
    }
  });

  test("maps the file extensions a diff will carry", () => {
    expect(previewLanguage("src/main.py")).toBe("python");
    expect(previewLanguage("tsconfig.json")).toBe("json");
    expect(previewLanguage("scripts/deploy.sh")).toBe("bash");
    expect(previewLanguage("src/main.rs")).toBe("rust");
    expect(previewLanguage("cmd/main.go")).toBe("go");
    expect(previewLanguage("notes.rst")).toBeUndefined();
  });

  test("highlights every vendored language with captures the theme styles", async () => {
    // buildSyntaxStyle keys these names; a grammar whose captures fall outside
    // them parses fine and still renders as flat text.
    const styled = new Set([
      "keyword", "operator", "string", "number", "boolean", "constant", "comment",
      "function", "constructor", "type", "attribute", "module", "variable", "property",
    ]);
    const client = getTreeSitterClient();
    await client.initialize();
    try {
      for (const { filetype } of VENDORED_GRAMMARS) {
        const result = await client.highlightOnce(SAMPLES[filetype]!, filetype);
        expect(`${filetype}: ${result.error ?? "none"}`).toBe(`${filetype}: none`);
        const groups = new Set((result.highlights ?? []).map(([, , group]) => group));
        expect(`${filetype}: ${groups.size > 0}`).toBe(`${filetype}: true`);
        const known = [...groups].filter((group) => styled.has(group.split(".")[0]!));
        expect(`${filetype}: ${known.length > 0}`).toBe(`${filetype}: true`);
      }
    } finally {
      await client.destroy();
    }
  }, 60_000);
});

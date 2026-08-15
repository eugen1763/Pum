import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPathCompletion, pathCompletions } from "./path-autocomplete";

let cwd: string | undefined;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
});

function project() {
  cwd = mkdtempSync(join(tmpdir(), "pum-path-completion-"));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "docs with spaces"));
  writeFileSync(join(cwd, "src", "agent.ts"), "");
  writeFileSync(join(cwd, "src", "app.tsx"), "");
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "auth.json"), "secret");
  writeFileSync(join(cwd, ".env.local"), "secret");
  mkdirSync(join(cwd, ".ssh"));
  writeFileSync(join(cwd, ".ssh", "config"), "secret");
  return cwd;
}

describe("path autocomplete", () => {
  test("completes the path token under the cursor", () => {
    const root = project();
    const input = "review src/app.t please";
    const completions = pathCompletions(input, "review src/app.t".length, root);

    expect(completions).toEqual([{
      start: "review ".length,
      end: "review src/app.t".length,
      replacement: "src/app.tsx",
    }]);
    expect(applyPathCompletion(input, completions[0]!)).toEqual({
      value: "review src/app.tsx please",
      cursorOffset: "review src/app.tsx".length,
    });
  });

  test("sorts matches and appends a separator to directories", () => {
    const root = project();
    expect(pathCompletions("src/a", 5, root).map((item) => item.replacement)).toEqual([
      "src/agent.ts",
      "src/app.tsx",
    ]);
    expect(pathCompletions("doc", 3, root).map((item) => item.replacement)).toEqual([
      "docs with spaces/",
    ]);
  });

  test("preserves @ references and supports quoted paths with spaces", () => {
    const root = project();
    expect(pathCompletions("inspect @src/app", 16, root)[0]?.replacement).toBe("@src/app.tsx");
    expect(pathCompletions('inspect "docs w', 15, root)[0]?.replacement).toBe("docs with spaces/");
    expect(pathCompletions("don't skip src/app", 18, root)[0]?.replacement).toBe("src/app.tsx");
  });

  test("does not expose credentials, project escapes, or symbolic links", () => {
    const root = project();
    expect(pathCompletions("auth", 4, root)).toEqual([]);
    expect(pathCompletions(".env", 4, root)).toEqual([]);
    expect(pathCompletions(".ssh/", 5, root)).toEqual([]);
    expect(pathCompletions("../", 3, root)).toEqual([]);

    if (process.platform !== "win32") {
      symlinkSync(join(root, "src"), join(root, "linked-src"));
      expect(pathCompletions("linked-src/", 11, root)).toEqual([]);
    }
  });
});

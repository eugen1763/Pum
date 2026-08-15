import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { applyPathCompletion, pathCompletions } from "./path-autocomplete";

let cwd: string | undefined;
let home: string | undefined;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
  cwd = undefined;
  home = undefined;
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

/**
 * os.homedir() answers from the account, not from $HOME, so a home test needs a
 * throwaway directory in the real home; afterEach removes it. Returns its name
 * for `~/<name>/` fragments.
 */
function homeSandbox() {
  home = mkdtempSync(join(homedir(), ".pum-path-"));
  mkdirSync(join(home, "notes"));
  mkdirSync(join(home, "my papers"));
  writeFileSync(join(home, "todo.md"), "");
  mkdirSync(join(home, ".ssh"));
  return { directory: home, name: basename(home) };
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

  test("completes an absolute fragment outside the project", () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), "pum-path-outside-"));
    try {
      mkdirSync(join(outside, "reports"));
      writeFileSync(join(outside, "readme.md"), "");
      const typed = `read ${outside}/re`;
      expect(pathCompletions(typed, typed.length, root).map((item) => item.replacement)).toEqual([
        `${outside}/readme.md`,
        `${outside}/reports/`,
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("expands a home fragment and keeps the ~ in the replacement", () => {
    const root = project();
    const { name } = homeSandbox();
    const typed = `open ~/${name}/no`;
    expect(pathCompletions(typed, typed.length, root).map((item) => item.replacement)).toEqual([
      `~/${name}/notes/`,
    ]);
    const reference = `open @~/${name}/todo`;
    expect(pathCompletions(reference, reference.length, root)[0]?.replacement)
      .toBe(`@~/${name}/todo.md`);
    const quoted = `open "~/${name}/my p`;
    expect(pathCompletions(quoted, quoted.length, root)[0]?.replacement)
      .toBe(`~/${name}/my papers/`);
  });

  test("lists the home directory for a bare ~", () => {
    const root = project();
    const { name } = homeSandbox();
    const replacements = pathCompletions("~", 1, root).map((item) => item.replacement);

    expect(replacements).toContain(`~/${name}/`);
    // A bare `~` must list exactly what `~/` lists.
    expect(replacements).toEqual(pathCompletions("~/", 2, root).map((item) => item.replacement));
  });

  test("treats ~user as a relative fragment", () => {
    const root = project();
    mkdirSync(join(root, "~alice"));
    expect(pathCompletions("~a", 2, root).map((item) => item.replacement)).toEqual(["~alice/"]);
  });

  test("hides credentials and symbolic links outside the project", () => {
    const root = project();
    const { directory, name } = homeSandbox();
    const partial = `~/${name}/.ss`;
    expect(pathCompletions(partial, partial.length, root)).toEqual([]);
    const inside = `~/${name}/.ssh/`;
    expect(pathCompletions(inside, inside.length, root)).toEqual([]);
    const absolute = `${directory}/.ssh/id`;
    expect(pathCompletions(absolute, absolute.length, root)).toEqual([]);
    // An empty basename lists everything, so the filter is the only thing hiding .ssh.
    const listing = `~/${name}/`;
    expect(pathCompletions(listing, listing.length, root).map((item) => item.replacement)).toEqual([
      `~/${name}/my papers/`,
      `~/${name}/notes/`,
      `~/${name}/todo.md`,
    ]);

    if (process.platform !== "win32") {
      symlinkSync(join(directory, "notes"), join(directory, "linked-notes"));
      const linked = `~/${name}/linked`;
      expect(pathCompletions(linked, linked.length, root)).toEqual([]);
    }
  });

  test("returns nothing for a directory it cannot read", () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), "pum-path-locked-"));
    // Root ignores the permission bits, so only test the denial as a normal user.
    const canDeny = process.platform !== "win32" && process.getuid?.() !== 0;
    if (canDeny) {
      mkdirSync(join(outside, "locked"));
      writeFileSync(join(outside, "locked", "note.txt"), "");
      chmodSync(join(outside, "locked"), 0o000);
    }
    try {
      const missing = `${outside}/gone/x`;
      expect(pathCompletions(missing, missing.length, root)).toEqual([]);

      if (canDeny) {
        const locked = `${outside}/locked/n`;
        expect(pathCompletions(locked, locked.length, root)).toEqual([]);
      }
    } finally {
      if (canDeny) chmodSync(join(outside, "locked"), 0o700);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("ignores URL-looking fragments", () => {
    const root = project();
    expect(pathCompletions("see https://example.com/sr", 26, root)).toEqual([]);
    expect(pathCompletions("see file:///etc/ho", 18, root)).toEqual([]);
  });
});

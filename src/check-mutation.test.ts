import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathSensitivity, previewMutation } from "./check-mutation";

const directories: string[] = [];
function project(): string {
  const path = mkdtempSync(join(tmpdir(), "pum-mutation-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("mutation previews", () => {
  test("computes a complete edit diff before mutation", async () => {
    const cwd = project();
    const path = join(cwd, "src.ts");
    writeFileSync(path, "const one = 1;\nconst two = 2;\n");
    const preview = await previewMutation("edit", cwd, {
      path: "src.ts",
      edits: [{ oldText: "const two = 2;", newText: "const two = 3;" }],
    });
    expect(preview).toMatchObject({ changedPaths: ["src.ts"], additions: 1, removals: 1, projectContained: true });
    expect(preview!.unifiedDiff).toContain("-const two = 2;");
    expect(preview!.unifiedDiff).toContain("+const two = 3;");
    expect(await Bun.file(path).text()).toContain("const two = 2;");
  });

  test("fails closed on stale, ambiguous, overlapping, and outside edit context", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "a.txt"), "same same\n");
    await expect(previewMutation("edit", cwd, { path: "a.txt", edits: [{ oldText: "missing", newText: "x" }] })).rejects.toThrow("stale");
    await expect(previewMutation("edit", cwd, { path: "a.txt", edits: [{ oldText: "same", newText: "x" }] })).rejects.toThrow("ambiguous");
    await expect(previewMutation("edit", cwd, { path: "../outside", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside");
    await expect(previewMutation("edit", cwd, { path: "C:\\outside\\secret", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside");
    await expect(previewMutation("edit", cwd, { path: "\\\\server\\share\\secret", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside");
  });

  test("rejects symbolic-link targets before approval", async () => {
    if (process.platform === "win32") return;
    const cwd = project();
    const outside = project();
    writeFileSync(join(outside, "secret"), "value\n");
    symlinkSync(outside, join(cwd, "link"));
    await expect(previewMutation("edit", cwd, {
      path: "link/secret",
      edits: [{ oldText: "value", newText: "changed" }],
    })).rejects.toThrow("link or junction");
  });

  test("previews apply_patch without weakening atomic validation", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "a.txt"), "old\n");
    const preview = await previewMutation("apply_patch", cwd, {
      patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch",
    });
    expect(preview).toMatchObject({ changedPaths: ["a.txt"], additions: 1, removals: 1 });
    expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("old\n");
  });

  test("marks executable, config, and credential-sensitive paths", () => {
    const cwd = project();
    const script = join(cwd, "deploy.sh");
    writeFileSync(script, "#!/bin/sh\n");
    chmodSync(script, 0o755);
    expect(pathSensitivity("deploy.sh", 0o755).executable).toBe(true);
    expect(pathSensitivity("package.json").config).toBe(true);
    expect(pathSensitivity(".env.local").credential).toBe(true);
  });
});

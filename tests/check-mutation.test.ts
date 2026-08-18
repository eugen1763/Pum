import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathSensitivity, previewMutation } from "../src/check-mutation";

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

  test("fails closed on stale edit context", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "a.txt"), "same same\n");
    await expect(previewMutation("edit", cwd, { path: "a.txt", edits: [{ oldText: "missing", newText: "x" }] })).rejects.toThrow("stale");
  });

  test("fails closed on ambiguous edit context", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "a.txt"), "same same\n");
    await expect(previewMutation("edit", cwd, { path: "a.txt", edits: [{ oldText: "same", newText: "x" }] })).rejects.toThrow("ambiguous");
  });

  test("fails closed on overlapping edit context", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "a.txt"), "abcdef\n");
    await expect(previewMutation("edit", cwd, {
      path: "a.txt",
      edits: [
        { oldText: "abcde", newText: "x" },
        { oldText: "cdef", newText: "y" },
      ],
    })).rejects.toThrow("overlap");
  });

  test("fails closed on a relative path outside the project", async () => {
    const cwd = project();
    await expect(previewMutation("edit", cwd, { path: "../outside", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside");
  });

  test("fails closed on a Windows drive path outside the project", async () => {
    const cwd = project();
    await expect(previewMutation("edit", cwd, { path: "C:\\outside\\secret", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside");
  });

  test("fails closed on a UNC path outside the project without probing the share", async () => {
    const cwd = project();
    await expect(previewMutation("edit", cwd, { path: "\\\\server\\share\\secret", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("outside");
  });

  test.skipIf(process.platform === "win32")("rejects symbolic-link targets before approval", async () => {
    const cwd = project();
    const outside = project();
    writeFileSync(join(outside, "secret"), "value\n");
    symlinkSync(outside, join(cwd, "link"));
    await expect(previewMutation("edit", cwd, {
      path: "link/secret",
      edits: [{ oldText: "value", newText: "changed" }],
    })).rejects.toThrow("link or junction");
  });

  test("previews edits in an explicit additional root", async () => {
    const cwd = project();
    const shared = project();
    const path = join(shared, "shared.ts");
    writeFileSync(path, "export const value = 1;\n");

    const preview = await previewMutation("edit", cwd, {
      path,
      edits: [{ oldText: "value = 1", newText: "value = 2" }],
    }, [shared]);
    expect(preview?.changedPaths).toEqual([path]);
    expect(preview?.unifiedDiff).toContain("value = 2");
    expect(await Bun.file(path).text()).toContain("value = 1");
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
describe("PUM settings-file edits", () => {
  test("previews an exact settings-file edit under the agent directory", async () => {
    const cwd = project();
    const settingsDir = project();
    writeFileSync(join(settingsDir, "settings.json"), "{\"model\":\"one\"}\n");
    const settingsFiles = ["settings.json", "pum.json", "theme.json"].map((name) => join(settingsDir, name));
    const path = join(settingsDir, "settings.json");

    const preview = await previewMutation("edit", cwd, {
      path,
      edits: [{ oldText: "one", newText: "two" }],
    }, [], settingsFiles);
    expect(preview?.settingsFile).toBe(path);
    expect(preview?.changedPaths).toEqual([path]);
    expect(preview?.projectContained).toBe(true);
    expect(preview?.unifiedDiff).toContain("+{\"model\":\"two\"}");
  });

  test("rejects auth.json and session edits even with the settings list", async () => {
    const cwd = project();
    const settingsDir = project();
    writeFileSync(join(settingsDir, "auth.json"), "{}\n");
    const settingsFiles = ["settings.json", "pum.json", "theme.json"].map((name) => join(settingsDir, name));

    await expect(previewMutation("edit", cwd, {
      path: join(settingsDir, "auth.json"),
      edits: [{ oldText: "{}", newText: "{\"x\":1}" }],
    }, [], settingsFiles)).rejects.toThrow("outside");
    await expect(previewMutation("edit", cwd, {
      path: join(settingsDir, "sessions", "s.jsonl"),
      edits: [{ oldText: "{}", newText: "{\"x\":1}" }],
    }, [], settingsFiles)).rejects.toThrow("outside");
  });

  test("rejects a settings-file edit when no settings list is provided", async () => {
    const cwd = project();
    const settingsDir = project();
    writeFileSync(join(settingsDir, "settings.json"), "{}\n");

    await expect(previewMutation("edit", cwd, {
      path: join(settingsDir, "settings.json"),
      edits: [{ oldText: "{}", newText: "{\"x\":1}" }],
    })).rejects.toThrow("outside");
  });
});

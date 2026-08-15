import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setCheckModeConfig } from "./check-mode";
import {
  createFilesystemSandboxExtension,
  filesystemSandboxExtension,
  registerSandboxTempReadRoot,
  unregisterSandboxTempReadRoot,
  validateSandboxPatch,
  validateSandboxPath,
} from "./filesystem-sandbox";
import { pathsHaveSameIdentity } from "./platform";

const directories: string[] = [];

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("filesystem sandbox", () => {
  test("allows project files and configured roots", async () => {
    const project = directory("pum-sandbox-project-");
    const shared = directory("pum-sandbox-shared-");
    writeFileSync(join(project, "source.ts"), "export const value = 1;\n");
    writeFileSync(join(shared, "shared.ts"), "export const shared = true;\n");

    const projectResult = await validateSandboxPath(project, "source.ts");
    const sharedResult = await validateSandboxPath(project, join(shared, "shared.ts"), [shared]);
    expect(await pathsHaveSameIdentity(projectResult.root, project)).toBe(true);
    expect(await pathsHaveSameIdentity(sharedResult.root, shared)).toBe(true);
  });

  test("blocks outside paths and credential-sensitive files", async () => {
    const project = directory("pum-sandbox-boundary-");
    const outside = directory("pum-sandbox-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    writeFileSync(join(project, ".env"), "TOKEN=secret\n");

    await expect(validateSandboxPath(project, join(outside, "secret.txt"))).rejects.toThrow("outside the sandbox");
    await expect(validateSandboxPath(project, ".env")).rejects.toThrow("credential-sensitive");
  });

  test.skipIf(process.platform === "win32")("blocks escaping symbolic links", async () => {
    const project = directory("pum-sandbox-link-project-");
    const outside = directory("pum-sandbox-link-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(project, "link"));

    await expect(validateSandboxPath(project, "link/secret.txt")).rejects.toThrow("symbolic link");
  });

  test("validates all apply_patch paths before execution", async () => {
    const project = directory("pum-sandbox-patch-");
    writeFileSync(join(project, "old.txt"), "old\n");

    await expect(validateSandboxPatch(project, "*** Begin Patch\n"
      + "*** Update File: old.txt\n@@\n-old\n+new\n"
      + "*** Add File: new.txt\n+new\n"
      + "*** End Patch")).resolves.toBeUndefined();
    await expect(validateSandboxPatch(project, "*** Begin Patch\n"
      + "*** Add File: ../outside.txt\n+no\n"
      + "*** End Patch")).rejects.toThrow("parent traversal");
  });

  test.skipIf(process.platform === "win32")("validates the curly-apostrophe variant a read actually opens", async () => {
    const project = directory("pum-sandbox-curly-project-");
    const outside = directory("pum-sandbox-curly-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    // pi's read tool retries a U+2019 spelling when the straight apostrophe is
    // missing, so the literal path must not be the one the sandbox checks.
    symlinkSync(join(outside, "secret.txt"), join(project, "notes\u2019draft.md"));

    await expect(validateSandboxPath(project, "notes'draft.md", [], "read"))
      .rejects.toThrow("symbolic link");
  });

  test.skipIf(process.platform === "win32")("validates the NFD variant a read actually opens", async () => {
    const project = directory("pum-sandbox-nfd-project-");
    const outside = directory("pum-sandbox-nfd-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(project, "caf\u0065\u0301.md"));

    await expect(validateSandboxPath(project, "caf\u00e9.md", [], "read"))
      .rejects.toThrow("symbolic link");
  });

  test("keeps ordinary reads and missing write targets working", async () => {
    const project = directory("pum-sandbox-plain-read-");
    writeFileSync(join(project, "source.ts"), "export const value = 1;\n");

    const read = await validateSandboxPath(project, "source.ts", [], "read");
    expect(read.absolute).toBe(join(project, "source.ts"));
    const missing = await validateSandboxPath(project, "nested/new.ts", [], "write");
    expect(missing.absolute).toBe(join(project, "nested", "new.ts"));
    await expect(validateSandboxPath(project, "missing.ts", [], "read")).resolves.toBeDefined();
  });

  test("allows registered temp read roots but not arbitrary temp paths", async () => {
    const project = directory("pum-sandbox-temp-project-");
    const staged = directory("pum-pasted-text-");
    const unrelated = directory("pum-sandbox-unrelated-temp-");
    writeFileSync(join(staged, "pasted-1.txt"), "pasted\n");
    writeFileSync(join(staged, ".env"), "TOKEN=secret\n");
    writeFileSync(join(unrelated, "other.txt"), "other\n");
    registerSandboxTempReadRoot(staged);

    try {
      await expect(validateSandboxPath(project, join(staged, "pasted-1.txt"), [], "read")).resolves.toBeDefined();
      await expect(validateSandboxPath(project, join(unrelated, "other.txt"), [], "read"))
        .rejects.toThrow("outside the sandbox");
      await expect(validateSandboxPath(project, join(staged, ".env"), [], "read"))
        .rejects.toThrow("credential-sensitive");
      await expect(validateSandboxPath(project, join(staged, "pasted-1.txt"), [], "write"))
        .rejects.toThrow("outside the sandbox");
    } finally {
      unregisterSandboxTempReadRoot(staged);
    }
    await expect(validateSandboxPath(project, join(staged, "pasted-1.txt"), [], "read"))
      .rejects.toThrow("outside the sandbox");
  });

  test.skipIf(process.platform === "win32")("blocks mutations of hard-linked files but still reads them", async () => {
    const project = directory("pum-sandbox-hardlink-project-");
    const outside = directory("pum-sandbox-hardlink-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret\n");
    linkSync(secret, join(project, "hard.txt"));

    await expect(validateSandboxPath(project, "hard.txt", [], "write")).rejects.toThrow("hard link");
    await expect(validateSandboxPath(project, "hard.txt", [], "read")).resolves.toBeDefined();
    await expect(validateSandboxPatch(project, "*** Begin Patch\n"
      + "*** Update File: hard.txt\n@@\n-secret\n+leaked\n"
      + "*** End Patch")).rejects.toThrow("hard link");
  });

  test("blocks write, edit, and apply_patch for readonly children but preserves reads", async () => {
    const project = directory("pum-readonly-sandbox-hook-");
    const source = join(project, "source.ts");
    writeFileSync(source, "export const value = 1;\n");
    setCheckModeConfig({ profile: "off", model: "test/model" });

    const handlers = new Map<string, Function>();
    (createFilesystemSandboxExtension({ readonly: true }) as any).factory({
      on(name: string, handler: Function) { handlers.set(name, handler); },
    });
    const context = { cwd: project };

    await expect(handlers.get("tool_call")?.({ toolName: "read", input: { path: source } }, context))
      .resolves.toBeUndefined();
    for (const [toolName, input] of [
      ["write", { path: source, content: "changed" }],
      ["edit", { path: source, edits: [{ oldText: "value", newText: "changed" }] }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Delete File: source.ts\n*** End Patch" }],
    ] as const) {
      const result = await handlers.get("tool_call")?.({ toolName, input }, context);
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain(`readonly child cannot use ${toolName}`);
    }
  });

  test("blocks read, edit, and apply_patch tool calls before execution", async () => {
    const project = directory("pum-sandbox-hook-project-");
    const outside = directory("pum-sandbox-hook-outside-");
    const outsideFile = join(outside, "outside.ts");
    writeFileSync(outsideFile, "export const outside = true;\n");
    setCheckModeConfig({ profile: "off", model: "test/model" });

    const handlers = new Map<string, Function>();
    (filesystemSandboxExtension as { factory: (pi: any) => void }).factory({
      on(name: string, handler: Function) { handlers.set(name, handler); },
    });
    const context = { cwd: project };

    for (const [toolName, input] of [
      ["read", { path: outsideFile }],
      ["edit", { path: outsideFile, edits: [{ oldText: "outside", newText: "inside" }] }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Add File: ../outside.ts\n+no\n*** End Patch" }],
    ] as const) {
      const result = await handlers.get("tool_call")?.({ toolName, input }, context);
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain(`Filesystem sandbox blocked ${toolName}`);
    }
  });
});

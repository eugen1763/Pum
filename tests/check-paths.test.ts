import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { applyCheckPathCommand, parseCheckPathCommand } from "../src/check-paths";
import { pathsHaveSameIdentity } from "../src/platform";
import { checkPathsForProject, normalizeSettings } from "../src/settings";

const directories: string[] = [];

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Check mode path commands", () => {
  test("parses list, add, remove, clear, and paths with spaces", () => {
    expect(parseCheckPathCommand("/check-path")).toEqual({ action: "list" });
    expect(parseCheckPathCommand("/check-path list")).toEqual({ action: "list" });
    expect(parseCheckPathCommand("/check-path add '../shared files'")).toEqual({
      action: "add",
      path: "../shared files",
    });
    expect(parseCheckPathCommand("/check-path remove ../shared files")).toEqual({
      action: "remove",
      path: "../shared files",
    });
    expect(parseCheckPathCommand("/check-path clear")).toEqual({ action: "clear" });
    expect(() => parseCheckPathCommand("/check-path add")).toThrow("usage");
  });

  test("adds, lists, removes, and clears canonical project-scoped paths", async () => {
    const parent = directory("pum-check-paths-");
    const project = join(parent, "project");
    const shared = join(parent, "shared");
    mkdirSync(project);
    mkdirSync(shared);
    let settings = normalizeSettings({});

    const added = await applyCheckPathCommand(settings, project, { action: "add", path: "../shared" });
    settings = added.settings;
    const configured = checkPathsForProject(settings, project);
    expect(configured).toHaveLength(1);
    expect(await pathsHaveSameIdentity(configured[0]!, shared)).toBe(true);
    expect(added.message).toContain(configured[0]!);

    const listed = await applyCheckPathCommand(settings, project, { action: "list" });
    expect(listed.message).toContain(`- ${configured[0]}`);

    rmSync(shared, { recursive: true });
    const removed = await applyCheckPathCommand(settings, project, { action: "remove", path: "../shared" });
    expect(checkPathsForProject(removed.settings, project)).toEqual([]);

    mkdirSync(shared);
    settings = (await applyCheckPathCommand(removed.settings, project, { action: "add", path: shared })).settings;
    const cleared = await applyCheckPathCommand(settings, project, { action: "clear" });
    expect(checkPathsForProject(cleared.settings, project)).toEqual([]);
  });

  test("rejects redundant, missing, credential-sensitive, and filesystem-root paths", async () => {
    const parent = directory("pum-check-path-validation-");
    const project = join(parent, "project");
    mkdirSync(project);
    mkdirSync(join(project, "nested"));
    mkdirSync(join(parent, ".ssh"));
    const settings = normalizeSettings({});

    await expect(applyCheckPathCommand(settings, project, { action: "add", path: "nested" }))
      .rejects.toThrow("already inside");
    await expect(applyCheckPathCommand(settings, project, { action: "add", path: "missing" }))
      .rejects.toThrow();
    await expect(applyCheckPathCommand(settings, project, { action: "add", path: "../.ssh" }))
      .rejects.toThrow("credential-sensitive");
    await expect(applyCheckPathCommand(settings, project, { action: "add", path: parse(project).root }))
      .rejects.toThrow("filesystem root");
  });
});

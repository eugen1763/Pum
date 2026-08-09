import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  canonicalPathIdentity,
  defaultAgentDir,
  isPathInside,
  pathsHaveSameIdentity,
  projectStorageKey,
  sessionDirectoryName,
  shutdownSignals,
} from "./platform";

describe("Windows platform paths", () => {
  test("uses LOCALAPPDATA by default and honors PUM_DIR", () => {
    expect(defaultAgentDir("win32", { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "C:\\Users\\Ada"))
      .toBe("C:\\Users\\Ada\\AppData\\Local\\pum");
    expect(defaultAgentDir("win32", { PUM_DIR: "D:\\PumData" }, "C:\\Users\\Ada"))
      .toBe("D:\\PumData");
  });

  test("keeps the Linux config layout", () => {
    expect(defaultAgentDir("linux", { XDG_CONFIG_HOME: "/config" }, "/home/ada"))
      .toBe("/config/pum");
    expect(defaultAgentDir("linux", {}, "/home/ada")).toBe("/home/ada/.config/pum");
  });

  test("normalizes Windows project keys without changing Linux keys", () => {
    expect(projectStorageKey("C:\\Users\\Ada\\Project", "win32"))
      .toBe("c:\\users\\ada\\project");
    expect(projectStorageKey("/Work/Project", "linux")).toBe("/Work/Project");
  });

  test("creates bounded and distinct Windows session directory names", () => {
    const first = sessionDirectoryName("C:\\Users\\Ada\\Project", "win32");
    const same = sessionDirectoryName("c:\\users\\ADA\\project", "win32");
    const other = sessionDirectoryName("D:\\Users\\Ada\\Project", "win32");
    expect(first).toBe(same);
    expect(first).not.toBe(other);
    expect(first.length).toBeLessThanOrEqual(90);
    expect(first).not.toContain(":");
    expect(first).not.toContain("\\");
  });

  test("checks containment with Windows separators and drive rules", () => {
    const root = "C:\\repo\\.pum\\worktrees";
    expect(isPathInside(root, win32.join(root, "agent"), "win32")).toBe(true);
    expect(isPathInside(root, "C:\\repo\\.pum\\worktrees-other\\agent", "win32")).toBe(false);
    expect(isPathInside(root, "D:\\repo\\agent", "win32")).toBe(false);
    expect(isPathInside(root, root, "win32")).toBe(false);
  });

  test("compares canonical Windows identities instead of short-path spelling", async () => {
    const resolvePath = async (path: string) => path.replace("RUNNER~1", "runneradmin");
    expect(await canonicalPathIdentity("C:\\Users\\RUNNER~1\\project", "win32", resolvePath))
      .toBe("c:\\users\\runneradmin\\project");
    expect(await pathsHaveSameIdentity(
      "C:\\Users\\RUNNER~1\\project",
      "c:\\users\\runneradmin\\PROJECT",
      "win32",
      resolvePath,
    )).toBe(true);
  });

  test("uses only signals supported by normal Windows console processes", () => {
    expect(shutdownSignals("win32")).toEqual(["SIGINT", "SIGBREAK"]);
    expect(shutdownSignals("linux")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });
});

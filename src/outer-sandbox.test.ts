import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOuterSandboxLaunchPlan,
  OUTER_SANDBOX_ENV,
  OUTER_SANDBOX_MARKER,
  parseOuterSandboxMountArgument,
} from "./outer-sandbox";

const temporaryDirectories: string[] = [];

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("outer sandbox mount parsing", () => {
  test("parses only final read-only and read-write suffixes", () => {
    expect(parseOuterSandboxMountArgument("/work/shared:ro")).toEqual({
      path: "/work/shared",
      mode: "ro",
    });
    expect(parseOuterSandboxMountArgument("/work/shared:rw")).toEqual({
      path: "/work/shared",
      mode: "rw",
    });
    expect(parseOuterSandboxMountArgument("/work/name:cache")).toEqual({
      path: "/work/name:cache",
    });
    expect(parseOuterSandboxMountArgument("/work/name:ro:cache")).toEqual({
      path: "/work/name:ro:cache",
    });
  });

  test("rejects empty and NUL mount arguments", () => {
    expect(() => parseOuterSandboxMountArgument("")).toThrow("invalid");
    expect(() => parseOuterSandboxMountArgument(":rw")).toThrow("path is empty");
    expect(() => parseOuterSandboxMountArgument("/work\0other")).toThrow("invalid");
  });
});

describe("outer sandbox launch planning", () => {
  test("builds a deterministic writable claudebox command", async () => {
    const project = directory("pum-outer-project-");
    const first = directory("pum-outer-first-");
    const second = directory("pum-outer-second-");
    const plan = await buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: [second, `${first}:ro`],
      command: ["/usr/bin/bun", "/opt/pum/src/index.tsx", "-r", ""],
      environment: { ZED: "last", ALPHA: "first" },
      executable: "/usr/bin/claudebox",
    });

    const mounts = [
      { path: project, mode: "rw" as const },
      { path: first, mode: "ro" as const },
      { path: second, mode: "rw" as const },
    ].sort((left, right) => left.path.localeCompare(right.path));
    expect(plan).toMatchObject({
      executable: "/usr/bin/claudebox",
      cwd: project,
      mounts,
      environment: {
        ALPHA: "first",
        [OUTER_SANDBOX_ENV]: OUTER_SANDBOX_MARKER,
        ZED: "last",
      },
      command: ["/usr/bin/bun", "/opt/pum/src/index.tsx", "-r", ""],
    });

    const expectedArgs = ["--no-mount-home", "--cwd", project];
    for (const mount of mounts) expectedArgs.push("--mount", `${mount.path}:${mount.mode}`);
    expectedArgs.push(
      "--env", "ALPHA=first",
      "--env", `${OUTER_SANDBOX_ENV}=${OUTER_SANDBOX_MARKER}`,
      "--env", "ZED=last",
      "--exec", "--",
      "/usr/bin/bun", "/opt/pum/src/index.tsx", "-r", "",
    );
    expect(plan.args).toEqual(expectedArgs);
  });

  test("defaults read mode mounts to ro and permits an explicit rw extra", async () => {
    const project = directory("pum-outer-read-project-");
    const readonly = directory("pum-outer-readonly-");
    const writable = directory("pum-outer-writable-");
    const plan = await buildOuterSandboxLaunchPlan({
      mode: "read",
      cwd: project,
      mounts: [readonly, `${writable}:rw`],
      command: ["pum"],
    });

    expect(plan.mounts).toEqual([
      { path: project, mode: "ro" },
      { path: readonly, mode: "ro" },
      { path: writable, mode: "rw" },
    ].sort((left, right) => left.path.localeCompare(right.path)));
  });

  test("resolves relative extras against the canonical working directory", async () => {
    const project = directory("pum-outer-relative-");
    const shared = join(project, "shared");
    mkdirSync(shared);
    const plan = await buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: ["shared:ro"],
      command: ["pum"],
    });

    expect(plan.mounts).toContainEqual({ path: realpathSync(shared), mode: "ro" });
  });

  test("deduplicates extras permissively without overriding the launch cwd mode", async () => {
    const project = directory("pum-outer-deduplicate-");
    const shared = directory("pum-outer-deduplicate-shared-");
    const readPlan = await buildOuterSandboxLaunchPlan({
      mode: "read",
      cwd: project,
      mounts: [`${shared}:ro`, `${shared}:rw`, `${shared}:ro`, `${project}:rw`],
      command: ["pum"],
    });

    expect(readPlan.mounts.filter((mount) => mount.path === shared)).toEqual([
      { path: shared, mode: "rw" },
    ]);
    expect(readPlan.mounts.filter((mount) => mount.path === project)).toEqual([
      { path: project, mode: "ro" },
    ]);

    const writePlan = await buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: [`${project}:ro`],
      command: ["pum"],
    });
    expect(writePlan.mounts.filter((mount) => mount.path === project)).toEqual([
      { path: project, mode: "rw" },
    ]);
  });

  test("rejects missing paths and files", async () => {
    const project = directory("pum-outer-invalid-");
    const file = join(project, "file.txt");
    writeFileSync(file, "not a directory\n");

    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: [join(project, "missing")],
      command: ["pum"],
    })).rejects.toThrow("does not exist");
    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: [file],
      command: ["pum"],
    })).rejects.toThrow("not a directory");
  });

  test("rejects symbolic-link path components and boundaries", async () => {
    if (process.platform === "win32") return;
    const project = directory("pum-outer-link-project-");
    const target = directory("pum-outer-link-target-");
    const nested = join(target, "nested");
    mkdirSync(nested);
    const link = join(project, "linked");
    symlinkSync(target, link);

    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: [link],
      command: ["pum"],
    })).rejects.toThrow("symbolic link or junction");
    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      mounts: [join(link, "nested")],
      command: ["pum"],
    })).rejects.toThrow("symbolic link or junction");
    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: link,
      command: ["pum"],
    })).rejects.toThrow("symbolic link or junction");
  });

  test("rejects nested launches and invalid command data", async () => {
    const project = directory("pum-outer-nested-");
    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      command: ["pum"],
      environment: { [OUTER_SANDBOX_ENV]: OUTER_SANDBOX_MARKER },
    })).rejects.toThrow("already runs inside");
    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      command: [],
    })).rejects.toThrow("command is required");
    await expect(buildOuterSandboxLaunchPlan({
      mode: "write",
      cwd: project,
      command: ["pum", "bad\0argument"],
    })).rejects.toThrow("command argument is invalid");
  });
});

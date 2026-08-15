import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRealpathSync, pathIdentity } from "./platform";
import { OUTER_SANDBOX_ENV, OUTER_SANDBOX_MARKER } from "./outer-sandbox";
import {
  buildPumOuterSandboxPlan,
  outerSandboxAdditionalRoots,
  outerSandboxContext,
  OUTER_SANDBOX_MODE_ENV,
  OUTER_SANDBOX_ROOTS_ENV,
} from "./outer-sandbox-launch";

const temporaryDirectories: string[] = [];

function directory(prefix: string): string {
  const path = canonicalRealpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("PUM outer sandbox launch", () => {
  test("adds runtime and state mounts without exposing the complete environment", async () => {
    const project = directory("pum-launch-project-");
    const extra = directory("pum-launch-extra-");
    const agentDir = directory("pum-launch-agent-");
    const runtime = directory("pum-launch-runtime-");
    const packageRoot = directory("pum-launch-package-");
    const runtimeBin = join(runtime, "bin");
    const runtimeExecutable = join(runtimeBin, "bun");
    const entrypoint = join(packageRoot, "src", "index.tsx");
    mkdirSync(runtimeBin);
    mkdirSync(join(packageRoot, "src"));
    writeFileSync(runtimeExecutable, "runtime\n");
    writeFileSync(entrypoint, "entrypoint\n");

    const plan = await buildPumOuterSandboxPlan({
      mode: "write",
      cwd: project,
      mounts: [`${extra}:ro`],
      childArgs: ["-r"],
      environment: {
        LANG: "en_US.UTF-8",
        API_TOKEN: "must-not-enter",
      },
      executable: "/usr/bin/claudebox",
      runtimeExecutable,
      entrypoint,
      agentDir,
      packageRoot,
    });

    expect(plan.mounts).toContainEqual({ path: project, mode: "rw" });
    expect(plan.mounts).toContainEqual({ path: extra, mode: "ro" });
    expect(plan.mounts).toContainEqual({ path: agentDir, mode: "rw" });
    expect(plan.mounts).toContainEqual({ path: runtimeBin, mode: "ro" });
    expect(plan.mounts).toContainEqual({ path: packageRoot, mode: "ro" });
    expect(plan.environment.API_TOKEN).toBeUndefined();
    expect(plan.environment.LANG).toBe("en_US.UTF-8");
    expect(plan.environment.PUM_DIR).toBe(agentDir);
    expect(plan.environment[OUTER_SANDBOX_ENV]).toBe(OUTER_SANDBOX_MARKER);
    expect(plan.command).toEqual([
      runtimeExecutable,
      entrypoint,
      "-r",
    ]);
  });

  test("rejects PUM state inside a read-only project", async () => {
    const project = directory("pum-launch-read-project-");
    const runtime = directory("pum-launch-read-runtime-");
    const packageRoot = directory("pum-launch-read-package-");
    const runtimeExecutable = join(runtime, "bun");
    const entrypoint = join(packageRoot, "index.tsx");
    writeFileSync(runtimeExecutable, "runtime\n");
    writeFileSync(entrypoint, "entrypoint\n");

    await expect(buildPumOuterSandboxPlan({
      mode: "read",
      cwd: project,
      mounts: [],
      childArgs: [],
      environment: {},
      executable: "/usr/bin/claudebox",
      runtimeExecutable,
      entrypoint,
      agentDir: join(project, ".pum-state"),
      packageRoot,
    })).rejects.toThrow("PUM_DIR outside");
  });

  test("parses child context and returns only external tool roots", () => {
    const project = "/work/project";
    const environment = {
      [OUTER_SANDBOX_ENV]: OUTER_SANDBOX_MARKER,
      [OUTER_SANDBOX_MODE_ENV]: "read",
      [OUTER_SANDBOX_ROOTS_ENV]: JSON.stringify([
        { path: project, mode: "ro" },
        { path: "/work/shared", mode: "rw" },
      ]),
    };
    const context = outerSandboxContext(environment);
    expect(context).toEqual({
      mode: "read",
      roots: [
        { path: project, mode: "ro" },
        { path: "/work/shared", mode: "rw" },
      ],
    });
    // The roots come back as canonical identities, and a rooted POSIX path
    // resolves against the current drive on Windows, so compare the same way
    // the code does rather than against the literal spelling.
    expect(outerSandboxAdditionalRoots(context!, project)).toEqual([pathIdentity("/work/shared")]);
  });

  test("rejects invalid and nested child context", async () => {
    expect(() => outerSandboxContext({
      [OUTER_SANDBOX_ENV]: OUTER_SANDBOX_MARKER,
      [OUTER_SANDBOX_MODE_ENV]: "bad",
    })).toThrow("mode");

    const project = directory("pum-launch-nested-");
    await expect(buildPumOuterSandboxPlan({
      mode: "write",
      cwd: project,
      mounts: [],
      childArgs: [],
      environment: { [OUTER_SANDBOX_ENV]: OUTER_SANDBOX_MARKER },
    })).rejects.toThrow("already runs");
  });
});

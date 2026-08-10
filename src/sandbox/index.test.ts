import { describe, expect, test } from "bun:test";
import type { SandboxBackend, SandboxCapability, SandboxPolicy } from "./types";
import { SandboxController } from "./index";
import { setCheckModeConfig } from "../check-mode";
import { DEFAULT_CHECK_MODEL } from "../check-mode";

function context(cwd: string) {
  return {
    cwd,
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-secret-id",
      getSessionFile: () => "C:\\private\\session.jsonl",
    },
  } as any;
}

function backend(capability: SandboxCapability) {
  const policies: SandboxPolicy[] = [];
  let probes = 0;
  const value: SandboxBackend = {
    id: capability.backend,
    probe: async () => {
      probes += 1;
      return capability;
    },
    spawn(policy, options) {
      policies.push(policy);
      queueMicrotask(() => options.onStdout(Buffer.from("sandboxed output")));
      return {
        completed: Promise.resolve({ exitCode: 0, signal: null }),
        kill() {},
      };
    },
  };
  return { value, policies, probeCount: () => probes };
}

function registeredBash(controller: SandboxController) {
  let tool: any;
  (controller.extension() as { factory: (pi: any) => void }).factory({
    registerTool(value: any) { tool = value; },
  } as any);
  return tool;
}

describe("sandbox Bash override", () => {
  test("recomputes a canonical policy and preserves pi output and safe PI environment", async () => {
    setCheckModeConfig({ profile: "balanced", model: DEFAULT_CHECK_MODEL, additionalPaths: [] });
    const mock = backend({ state: "enforced", backend: process.platform === "win32" ? "mxc" : "bubblewrap" });
    const controller = new SandboxController({ backend: mock.value, mode: "auto", platform: process.platform });
    const result = await registeredBash(controller).execute(
      "call",
      { command: "printf sandbox" },
      undefined,
      undefined,
      context(process.cwd()),
    );

    expect(result.content[0].text).toContain("sandboxed output");
    expect(mock.policies).toHaveLength(1);
    const policy = mock.policies[0]!;
    expect(policy.exactCommand).toBe("printf sandbox");
    expect(policy.cwd.toLowerCase()).toBe(process.cwd().toLowerCase());
    expect(policy.readWritePaths.map((path) => path.toLowerCase())).toContain(process.cwd().toLowerCase());
    expect(policy.network).toBe("deny");
    expect(policy.environment.PI_PROVIDER).toBe("test-provider");
    expect(policy.environment.PI_MODEL).toBe("test-model");
    expect(policy.environment.PI_REASONING_LEVEL).toBe("high");
    expect(policy.environment.PI_SESSION_ID).toBeUndefined();
    expect(policy.environment.PI_SESSION_FILE).toBeUndefined();
  });

  test("blocks checked Bash in require mode when enforcement is unavailable", async () => {
    setCheckModeConfig({ profile: "balanced", model: DEFAULT_CHECK_MODEL, additionalPaths: [] });
    const mock = backend({ state: "unavailable", backend: "mxc", reason: "CreateProcessInSandbox unavailable" });
    const controller = new SandboxController({ backend: mock.value, mode: "require", platform: "win32" });
    await expect(registeredBash(controller).execute(
      "call",
      { command: "printf blocked" },
      undefined,
      undefined,
      context(process.cwd()),
    )).rejects.toThrow("Sandbox enforcement is required");
    expect(mock.policies).toHaveLength(0);
  });

  test("emits one late automatic fallback warning after Sandbox changes from off", async () => {
    setCheckModeConfig({ profile: "balanced", model: DEFAULT_CHECK_MODEL, additionalPaths: [] });
    const mock = backend({ state: "unavailable", backend: "bubblewrap", reason: "bwrap was not found" });
    const controller = new SandboxController({ backend: mock.value, mode: "off", platform: "linux" });
    const warnings: string[] = [];
    controller.subscribeWarnings((warning) => warnings.push(warning));
    controller.setMode("auto");
    await registeredBash(controller).execute(
      "call",
      { command: "printf fallback" },
      undefined,
      undefined,
      context(process.cwd()),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deterministic Check mode only");
  });

  test("uses one concise automatic fallback warning", async () => {
    const mock = backend({ state: "unavailable", backend: "bubblewrap", reason: "bwrap was not found" });
    const controller = new SandboxController({ backend: mock.value, mode: "auto", platform: "linux" });
    const first = await controller.startupWarning("balanced");
    const second = await controller.startupWarning("balanced");
    expect(first).toBe(second);
    expect(first).toContain("deterministic Check mode only");
    expect(first).toContain("bwrap was not found");
  });

  test("does not probe or warn at startup while Check mode is off", async () => {
    const mock = backend({ state: "unavailable", backend: "bubblewrap", reason: "bwrap was not found" });
    const controller = new SandboxController({ backend: mock.value, mode: "auto", platform: "linux" });
    expect(await controller.startupWarning("off")).toBeUndefined();
    expect(mock.probeCount()).toBe(0);
  });
});

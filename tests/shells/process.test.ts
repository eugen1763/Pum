import { describe, expect, test } from "bun:test";
import { sanitizeShellEnvironment, sanitizeShellEnvironmentAdditions } from "../../src/shells/process";

describe("managed shell environment", () => {
  test("inherits a small allowlist and refuses behavior-altering additions", () => {
    expect(sanitizeShellEnvironment(
      { PATH: "/bin", HOME: "/home/test", NODE_OPTIONS: "--require evil", SECRET: "value" },
      { CUSTOM_OK: "yes" },
    )).toEqual({ PATH: "/bin", HOME: "/home/test", CUSTOM_OK: "yes" });

    for (const key of ["GIT_SSH_COMMAND", "GIT_CONFIG_KEY_0", "LD_PRELOAD", "BASH_ENV", "PAGER"]) {
      expect(() => sanitizeShellEnvironment({ PATH: "/bin" }, { [key]: "planted" }))
        .toThrow("Unsafe trigger environment variable");
    }
    // A supplied PATH would repoint every executable name at a planted binary.
    expect(() => sanitizeShellEnvironment({ PATH: "/bin" }, { PATH: "/attacker/bin" }))
      .toThrow("Trigger environment variable cannot be supplied");
  });

  test("validates the model-supplied additions on their own", () => {
    expect(sanitizeShellEnvironmentAdditions({ CUSTOM_OK: "yes" })).toEqual({ CUSTOM_OK: "yes" });
    expect(sanitizeShellEnvironmentAdditions()).toEqual({});
    expect(() => sanitizeShellEnvironmentAdditions({ "BAD NAME": "x" }))
      .toThrow("Unsafe trigger environment variable");
    expect(() => sanitizeShellEnvironmentAdditions({ CUSTOM_OK: "a\0b" }))
      .toThrow("contains NUL");
  });
});

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  claudeboxExecutable,
  probeOuterSandboxRuntime,
  runOuterSandbox,
} from "../src/outer-sandbox-process";

describe("claudebox process integration", () => {
  test("uses a configured executable or the PATH default", () => {
    expect(claudeboxExecutable({})).toBe("claudebox");
    expect(claudeboxExecutable({ PUM_CLAUDEBOX: " /opt/pum/claudebox " })).toBe("/opt/pum/claudebox");
    expect(() => claudeboxExecutable({ PUM_CLAUDEBOX: "bad\0path" })).toThrow("NUL");
  });

  test("probes claudebox without a shell", () => {
    const calls: unknown[][] = [];
    const probe = ((...args: unknown[]) => {
      calls.push(args);
      const commandArgs = args[1] as string[];
      return {
        status: 0,
        signal: null,
        error: undefined,
        stdout: Buffer.from(commandArgs[0] === "--pum-protocol-version" ? "1\n" : "ok\n"),
        stderr: Buffer.alloc(0),
      };
    }) as any;
    expect(probeOuterSandboxRuntime({
      environment: { PUM_CLAUDEBOX: "/opt/claudebox" },
      probe,
    })).toEqual({ available: true, executable: "/opt/claudebox" });
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["/opt/claudebox", ["--pum-protocol-version"]],
      ["/opt/claudebox", ["--pum-runtime-check"]],
    ]);
  });

  test("rejects an older claudebox protocol", () => {
    const result = probeOuterSandboxRuntime({
      probe: (() => ({
        status: 0,
        signal: null,
        error: undefined,
        stdout: Buffer.from(""),
      })) as any,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("unsupported");
  });

  test("reports missing claudebox runtime commands", () => {
    let call = 0;
    const result = probeOuterSandboxRuntime({
      probe: (() => {
        call += 1;
        return call === 1
          ? { status: 0, signal: null, error: undefined, stdout: Buffer.from("1\n"), stderr: Buffer.alloc(0) }
          : { status: 1, signal: null, error: undefined, stdout: Buffer.alloc(0), stderr: Buffer.from("missing runtime commands: runsc") };
      }) as any,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("runsc");
  });

  test("reports a missing runtime", () => {
    const result = probeOuterSandboxRuntime({
      probe: (() => ({ status: null, signal: null, error: new Error("ENOENT") })) as any,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("ENOENT");
  });

  test("returns the child exit status with inherited stdio", async () => {
    const emitter = new EventEmitter();
    const calls: unknown[][] = [];
    const spawnProcess = ((...args: unknown[]) => {
      calls.push(args);
      queueMicrotask(() => emitter.emit("close", 7, null));
      return emitter;
    }) as any;
    await expect(runOuterSandbox({ executable: "claudebox", args: ["--help"] }, spawnProcess)).resolves.toBe(7);
    expect(calls[0]).toEqual([
      "claudebox",
      ["--help"],
      { stdio: "inherit", windowsHide: true },
    ]);
  });
});

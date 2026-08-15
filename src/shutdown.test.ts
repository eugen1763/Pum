import { describe, expect, test } from "bun:test";
import { createShutdown } from "./shutdown";
import { shutdownSignals, signalExitCode } from "./platform";

describe("graceful shutdown", () => {
  test("cleans temporary files and disposes the session before exit", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => { calls.push("unmount"); },
      cleanup: () => calls.push("cleanup"),
      shutdownTriggers: async () => { calls.push("triggers"); },
      dispose: async () => { calls.push("dispose"); },
      destroy: () => { calls.push("destroy"); },
      exit: (code) => calls.push(`exit:${code}`),
    });

    await shutdown(0);
    await shutdown(1);
    expect(calls).toEqual(["unmount", "cleanup", "triggers", "dispose", "destroy", "exit:0"]);
  });

  test("still disposes the session when trigger cleanup fails", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => { calls.push("unmount"); },
      cleanup: () => calls.push("cleanup"),
      shutdownTriggers: async () => { calls.push("triggers"); throw new Error("trigger cleanup failed"); },
      dispose: async () => { calls.push("dispose"); },
      destroy: () => { calls.push("destroy"); },
      exit: () => calls.push("exit"),
    });

    await expect(shutdown(1)).rejects.toThrow("trigger cleanup failed");
    expect(calls).toEqual(["unmount", "cleanup", "triggers", "dispose", "destroy", "exit"]);
  });

  test("restores the terminal and exits when session disposal fails", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => { calls.push("unmount"); },
      cleanup: () => calls.push("cleanup"),
      dispose: async () => { throw new Error("dispose failed"); },
      destroy: () => { calls.push("destroy"); },
      exit: () => calls.push("exit"),
    });

    await expect(shutdown(1)).rejects.toThrow("dispose failed");
    expect(calls).toEqual(["unmount", "cleanup", "destroy", "exit"]);
  });

  test("waits for asynchronous unmount and renderer destruction", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: async () => {
        calls.push("unmount:start");
        await Promise.resolve();
        calls.push("unmount:end");
      },
      cleanup: () => calls.push("cleanup"),
      dispose: async () => { calls.push("dispose"); },
      destroy: async () => {
        calls.push("destroy:start");
        await Promise.resolve();
        calls.push("destroy:end");
      },
      exit: () => calls.push("exit"),
    });

    await shutdown(0);
    expect(calls).toEqual([
      "unmount:start",
      "unmount:end",
      "cleanup",
      "dispose",
      "destroy:start",
      "destroy:end",
      "exit",
    ]);
  });

  test("still cleans up and disposes when asynchronous unmount fails", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: async () => {
        calls.push("unmount");
        throw new Error("highlight failed");
      },
      cleanup: () => calls.push("cleanup"),
      shutdownTriggers: async () => { calls.push("triggers"); },
      dispose: async () => { calls.push("dispose"); },
      destroy: async () => { calls.push("destroy"); },
      exit: () => calls.push("exit"),
    });

    await expect(shutdown(1)).rejects.toThrow("highlight failed");
    expect(calls).toEqual([
      "unmount",
      "cleanup",
      "triggers",
      "dispose",
      "destroy",
      "exit",
    ]);
  });
});

describe("signal exit codes", () => {
  test("uses 128 plus the signal number", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGBREAK")).toBe(149);
  });

  test("falls back to 1 for a signal PUM does not handle", () => {
    expect(signalExitCode("SIGUSR1")).toBe(1);
  });

  test("maps every handled shutdown signal on both platforms", () => {
    for (const platform of ["linux", "win32"] as const) {
      for (const signal of shutdownSignals(platform)) {
        expect(signalExitCode(signal)).toBeGreaterThan(128);
      }
    }
  });

  test("carries the signal code through to the exit action", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => {},
      cleanup: () => {},
      dispose: async () => {},
      destroy: () => {},
      exit: (code) => calls.push(`exit:${code}`),
    });

    await shutdown(signalExitCode("SIGINT"));
    expect(calls).toEqual(["exit:130"]);
  });
});

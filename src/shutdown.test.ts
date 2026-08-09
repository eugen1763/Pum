import { describe, expect, test } from "bun:test";
import { createShutdown } from "./shutdown";

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
});

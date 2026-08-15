import { describe, expect, test } from "bun:test";
import { createShutdown } from "../shutdown";

describe("managed shell shutdown integration", () => {
  test("stops shells before triggers and session disposal", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => { calls.push("unmount"); },
      cleanup: () => calls.push("cleanup"),
      shutdownShells: async () => { calls.push("shells"); },
      shutdownTriggers: async () => { calls.push("triggers"); },
      dispose: async () => { calls.push("dispose"); },
      destroy: () => { calls.push("destroy"); },
      exit: () => calls.push("exit"),
    });

    await shutdown(0);
    expect(calls).toEqual([
      "unmount",
      "cleanup",
      "shells",
      "triggers",
      "dispose",
      "destroy",
      "exit",
    ]);
  });

  test("continues cleanup when managed shell shutdown fails", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => {},
      cleanup: () => {},
      shutdownShells: async () => {
        calls.push("shells");
        throw new Error("shell cleanup failed");
      },
      shutdownTriggers: async () => { calls.push("triggers"); },
      dispose: async () => { calls.push("dispose"); },
      destroy: () => { calls.push("destroy"); },
      exit: () => calls.push("exit"),
    });

    await expect(shutdown(1)).rejects.toThrow("shell cleanup failed");
    expect(calls).toEqual(["shells", "triggers", "dispose", "destroy", "exit"]);
  });
});

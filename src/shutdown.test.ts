import { describe, expect, test } from "bun:test";
import { createShutdown } from "./shutdown";

describe("graceful shutdown", () => {
  test("cleans temporary files and disposes the session before exit", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => calls.push("unmount"),
      cleanup: () => calls.push("cleanup"),
      dispose: async () => { calls.push("dispose"); },
      destroy: () => calls.push("destroy"),
      exit: (code) => calls.push(`exit:${code}`),
    });

    await shutdown(0);
    await shutdown(1);
    expect(calls).toEqual(["unmount", "cleanup", "dispose", "destroy", "exit:0"]);
  });

  test("restores the terminal and exits when session disposal fails", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      unmount: () => calls.push("unmount"),
      cleanup: () => calls.push("cleanup"),
      dispose: async () => { throw new Error("dispose failed"); },
      destroy: () => calls.push("destroy"),
      exit: () => calls.push("exit"),
    });

    await expect(shutdown(1)).rejects.toThrow("dispose failed");
    expect(calls).toEqual(["unmount", "cleanup", "destroy", "exit"]);
  });
});

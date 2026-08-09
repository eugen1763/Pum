import { describe, expect, test } from "bun:test";
import { SpawnPreviewManager } from "./spawn-preview";

const options = {
  task: "Review **exactly** this task.",
  name: "preview-child",
  modelId: "mock/model",
  thinkingLevel: "off",
};

describe("SpawnPreviewManager", () => {
  test("queues exact requesters and advances after approval and cancellation", async () => {
    const manager = new SpawnPreviewManager();
    const seen: Array<string | undefined> = [];
    const unsubscribe = manager.subscribe(() => seen.push(manager.current()?.id));
    const first = manager.request({ sessionId: "main-session", agentId: null, name: "main" }, options);
    const second = manager.request({ sessionId: "child-session", agentId: "child", name: "worker" }, {
      ...options,
      task: "Nested task",
    });

    expect(manager.current()?.requester).toEqual({ sessionId: "main-session", agentId: null, name: "main" });
    expect(manager.current()?.options.task).toBe(options.task);
    expect(manager.approve("  add tests  ")).toBe(true);
    await expect(first).resolves.toEqual({ approved: true, note: "add tests" });
    expect(manager.current()?.requester.agentId).toBe("child");
    expect(manager.cancel()).toBe(true);
    await expect(second).resolves.toEqual({ approved: false, note: "", reason: "cancelled" });
    expect(manager.current()).toBeUndefined();
    expect(seen.length).toBeGreaterThan(2);
    unsubscribe();
  });

  test("settles active and queued requests on abort and session replacement", async () => {
    const manager = new SpawnPreviewManager();
    const unsubscribe = manager.subscribe(() => {});
    const controller = new AbortController();
    const aborted = manager.request({ sessionId: "old", agentId: null, name: "main" }, options, controller.signal);
    const replaced = manager.request({ sessionId: "old", agentId: "child", name: "worker" }, options);
    controller.abort();
    manager.cancelRequester("old");

    await expect(aborted).resolves.toEqual({ approved: false, note: "", reason: "aborted" });
    await expect(replaced).resolves.toEqual({ approved: false, note: "", reason: "shutdown" });
    expect(manager.current()).toBeUndefined();
    unsubscribe();
  });
});

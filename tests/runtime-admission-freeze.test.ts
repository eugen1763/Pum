import { describe, expect, test } from "bun:test";
import { bindRuntimeSettingsActivity, freezeRuntimeAdmissions, isRuntimeIdle, RuntimeSettingsCoordinator } from "../src/runtime-settings";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(run: () => Promise<void> = async () => {}) {
  const coordinator = new RuntimeSettingsCoordinator();
  coordinator.configure({ checkMode: "on", checkModel: "mock", sandboxMode: "require", checkPaths: [], webSearch: false }, () => {});
  const calls: string[] = [];
  const asyncCall = (name: string) => async (..._args: unknown[]) => { calls.push(name); await run(); };
  const syncCall = (name: string) => (..._args: unknown[]) => { calls.push(name); };
  const session = {
    isStreaming: false,
    agent: { state: { isStreaming: false }, prompt: asyncCall("core prompt"), continue: asyncCall("core continue"),
      steer: syncCall("core steer"), followUp: syncCall("core followUp") },
    subscribe: () => () => {}, prompt: asyncCall("prompt"), sendUserMessage: asyncCall("user"),
    sendCustomMessage: asyncCall("custom"), steer: asyncCall("steer"), followUp: asyncCall("followUp"),
    executeBash: asyncCall("bash"), abort: async () => { calls.push("abort"); }, dispose: syncCall("dispose"),
  } as any;
  bindRuntimeSettingsActivity(session, coordinator);
  return { session, coordinator, calls };
}

describe("permanent exact-runtime admission retirement", () => {
  test("unbound, disposed and nonidle runtimes cannot be frozen", async () => {
    expect(() => freezeRuntimeAdmissions({} as any)).toThrow("idle");
    const { session } = fixture();
    session.agent.state.isStreaming = true;
    expect(() => freezeRuntimeAdmissions(session)).toThrow("idle");
    session.agent.state.isStreaming = false;
    session.dispose();
    expect(() => freezeRuntimeAdmissions(session)).toThrow("idle");
  });

  test("each public/core/shell owner rejects freeze despite false streaming flags", async () => {
    for (const route of ["prompt", "custom", "corePrompt", "coreContinue", "bash"]) {
      const gate = deferred(); const { session, coordinator } = fixture(() => gate.promise);
      const pending = route === "prompt" ? session.prompt("work")
        : route === "custom" ? session.sendCustomMessage({}, { triggerTurn: true })
        : route === "corePrompt" ? session.agent.prompt([])
        : route === "coreContinue" ? session.agent.continue() : session.executeBash("work");
      expect(session.isStreaming).toBe(false);
      expect(coordinator.snapshot()!.active).toBe(1);
      expect(() => freezeRuntimeAdmissions(session)).toThrow("idle");
      gate.resolve(); await pending;
      expect(isRuntimeIdle(session)).toBe(true);
      expect(coordinator.snapshot()!.active).toBe(0);
      session.dispose();
    }
  });

  test("fence rejects every public/core/queue/custom/shell route before underlying work", async () => {
    const { session, calls, coordinator } = fixture();
    freezeRuntimeAdmissions(session);
    expect(isRuntimeIdle(session)).toBe(false);
    const routes = [
      () => session.prompt("new"), () => session.sendUserMessage("new"), () => session.steer("new"),
      () => session.followUp("new"), () => session.executeBash("new"), () => session.agent.prompt([]),
      () => session.agent.continue(), () => session.sendCustomMessage({}, { triggerTurn: true }),
      () => session.sendCustomMessage({}, { triggerTurn: false }),
      () => session.sendCustomMessage({}, { deliverAs: "nextTurn" }),
      () => session.sendCustomMessage({}, { deliverAs: "followUp" }),
    ];
    for (const route of routes) await expect(route()).rejects.toThrow(/retiring|cancelled/);
    expect(() => session.agent.steer({})).toThrow("retiring");
    expect(() => session.agent.followUp({})).toThrow("retiring");
    expect(calls).toEqual([]);
    expect(coordinator.snapshot()!.active).toBe(0);
    await session.abort(); session.dispose();
    expect(calls).toEqual(["abort", "dispose"]);
    await expect(session.sendCustomMessage({}, { triggerTurn: false })).rejects.toThrow();
    expect(() => session.agent.steer({})).toThrow();
  });

  test("retirement is permanent and does not freeze another exact runtime", async () => {
    const retired = fixture(); const unrelated = fixture();
    freezeRuntimeAdmissions(retired.session);
    expect(() => freezeRuntimeAdmissions(retired.session)).toThrow("idle");
    await unrelated.session.prompt("accepted");
    expect(unrelated.calls).toEqual(["prompt"]);
    expect(isRuntimeIdle(unrelated.session)).toBe(true);
    expect(isRuntimeIdle(retired.session)).toBe(false);
    retired.session.dispose(); unrelated.session.dispose();
  });

  test("ordinary queue-only routes preserve arguments and work until retirement", async () => {
    const { session, calls } = fixture();
    await session.steer("a"); await session.followUp("b"); await session.sendUserMessage("c");
    await session.sendCustomMessage({ text: "d" }, { deliverAs: "nextTurn" });
    session.agent.steer({ text: "e" }); session.agent.followUp({ text: "f" });
    expect(calls).toEqual(["steer", "followUp", "user", "custom", "core steer", "core followUp"]);
    session.dispose();
  });
});

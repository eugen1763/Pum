import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../../src/subagents/manager";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(shellManager?: any) {
  const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-branch-admission", shellManager });
  const sm = SessionManager.inMemory(process.cwd());
  const pi = { appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data) } as any;
  await manager.attachMain(pi, sm, process.cwd());
  return { manager, sm, pi };
}

describe("conversation branch manager admission", () => {
  test("requires exact fully bound manager, including same-ID impostors", async () => {
    const manager = new SubagentManager({ modelRuntime: {} as any, agentDir: "/tmp/pum-branch-admission" });
    const sm = SessionManager.inMemory(process.cwd());
    expect(manager.canBranchMainSession(sm)).toBe(false);
    await manager.attachMain({ appendEntry() {} } as any, sm, process.cwd());
    expect(manager.canBranchMainSession(sm)).toBe(true);
    expect(manager.canBranchMainSession({ getSessionId: () => sm.getSessionId() } as any)).toBe(false);
    await manager.detachMain();
    expect(manager.canBranchMainSession(sm)).toBe(false);
  });

  test("every retained status/internal record and pending main settlement refuses", async () => {
    const { manager, sm } = await fixture();
    const state = manager as any;
    for (const status of ["starting", "running", "idle", "completed", "failed", "stopped", "interrupted"]) {
      state.records.set("retained", { snapshot: { status, role: "judge" } });
      expect(manager.canBranchMainSession(sm)).toBe(false);
      state.records.clear();
    }
    state.mainRunning = true;
    expect(manager.canBranchMainSession(sm)).toBe(false);
    state.mainRunning = false;
    state.settlements.set("owed", { parentAgentId: null });
    expect(manager.canBranchMainSession(sm)).toBe(false);
    state.settlements.get("owed").acknowledgedAt = 1;
    expect(manager.canBranchMainSession(sm)).toBe(true);
    state.settlementDeliveriesInFlight.add("insertion");
    expect(manager.canBranchMainSession(sm)).toBe(false);
    state.settlementDeliveriesInFlight.clear();
    state.idleOpenReminderStates.set("main", { inFlightMessageId: "reminder" });
    expect(manager.canBranchMainSession(sm)).toBe(false);
    state.idleOpenReminderStates.clear();
    expect(manager.canBranchMainSession(sm)).toBe(true);
  });

  test("attach and detach reserve before their first asynchronous suspension", async () => {
    const gate = deferred();
    let held = false;
    const shellManager = { invalidateSession: () => held ? gate.promise : Promise.resolve() };
    const { manager, sm, pi } = await fixture(shellManager);
    held = true;
    const attachment = manager.attachMain({ ...pi }, sm, process.cwd());
    expect(manager.canBranchMainSession(sm)).toBe(false);
    gate.resolve();
    await attachment;
    expect(manager.canBranchMainSession(sm)).toBe(true);
    const detachment = manager.detachMain();
    expect(manager.canBranchMainSession(sm)).toBe(false);
    await detachment;
    expect(manager.canBranchMainSession(sm)).toBe(false);
  });

  test("queued worktree operations reserve synchronously and failures release only themselves", async () => {
    const { manager, sm } = await fixture();
    const gate = deferred();
    const state = manager as any;
    let secondStarted = false;
    const first = state.withWorktreeLock(() => gate.promise);
    const second = state.withWorktreeLock(async () => { secondStarted = true; throw new Error("fixture failure"); });
    const secondResult = second.catch((error: Error) => error.message);
    expect(manager.canBranchMainSession(sm)).toBe(false);
    expect(secondStarted).toBe(false);
    gate.resolve();
    await first;
    expect(await secondResult).toBe("fixture failure");
    expect(secondStarted).toBe(true);
    expect(manager.canBranchMainSession(sm)).toBe(true);
  });
});

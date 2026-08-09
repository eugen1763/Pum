import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalJson,
  CheckApprovalCoordinator,
  CheckApprovalStore,
  type CheckApprovalRequest,
} from "./check-approvals";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function store(limit = 256) {
  const directory = mkdtempSync(join(tmpdir(), "pum-approval-"));
  directories.push(directory);
  const path = join(directory, "approvals.json");
  return { path, store: new CheckApprovalStore(path, limit) };
}

function request(cwd: string): Omit<CheckApprovalRequest, "id"> {
  return {
    toolName: "bash",
    model: "test/check",
    cwd,
    canonicalInput: canonicalJson({ command: "bun test" }),
    summary: "Run tests",
    reason: "Verifier was unclear",
    paths: [],
    preview: "bun test",
  };
}

describe("project approvals", () => {
  test("binds exact approvals to identity, tool, model, cwd, and canonical complete input", () => {
    const fixture = store();
    const main = { kind: "main" } as const;
    const input = canonicalJson({ timeout: 10, command: "bun test" });
    expect(fixture.store.add(main, "bash", "test/check", "/repo", input)).toBe(true);
    expect(fixture.store.has(main, "bash", "test/check", "/repo", canonicalJson({ command: "bun test", timeout: 10 }))).toBe(true);
    expect(fixture.store.has({ kind: "subagent", agentId: "child-1" }, "bash", "test/check", "/repo", input)).toBe(false);
    expect(fixture.store.has(main, "edit", "test/check", "/repo", input)).toBe(false);
    expect(fixture.store.has(main, "bash", "test/other", "/repo", input)).toBe(false);
    expect(fixture.store.has(main, "bash", "test/check", "/other", input)).toBe(false);
    expect(fixture.store.has(main, "bash", "test/check", "/repo", canonicalJson({ command: "bun test --watch" }))).toBe(false);
  });

  test("persists with a cap and clears one project", () => {
    const fixture = store(2);
    const main = { kind: "main" } as const;
    fixture.store.add(main, "bash", "test/check", "/one", canonicalJson({ command: "one" }));
    fixture.store.add(main, "bash", "test/check", "/two", canonicalJson({ command: "two" }));
    fixture.store.add(main, "bash", "test/check", "/three", canonicalJson({ command: "three" }));
    expect(JSON.parse(readFileSync(fixture.path, "utf8")).entries).toHaveLength(2);
    expect(new CheckApprovalStore(fixture.path, 2).clearProject("/two")).toBe(1);
    expect(new CheckApprovalStore(fixture.path, 2).has(main, "bash", "test/check", "/three", canonicalJson({ command: "three" }))).toBe(true);
  });
});

describe("approval coordinator", () => {
  test("serializes main and subagent prompts", async () => {
    const coordinator = new CheckApprovalCoordinator();
    const shown: Array<string | null> = [];
    const unsubscribe = coordinator.subscribe((value) => shown.push(value?.cwd ?? null));
    const first = coordinator.request(request("/main"));
    const second = coordinator.request(request("/subagent"));
    const firstId = coordinator.current()!.id;
    expect(coordinator.resolve(firstId, "allow-once")).toBe(true);
    expect(await first).toBe("allow-once");
    const secondId = coordinator.current()!.id;
    coordinator.resolve(secondId, "allow-project");
    expect(await second).toBe("allow-project");
    expect(shown).toEqual([null, "/main", "/subagent", null]);
    unsubscribe();
  });

  test("denies without UI and cancels an active request on abort", async () => {
    const coordinator = new CheckApprovalCoordinator();
    expect(await coordinator.request(request("/none"))).toBe("deny");
    const unsubscribe = coordinator.subscribe(() => {});
    const controller = new AbortController();
    const pending = coordinator.request(request("/repo"), controller.signal);
    controller.abort();
    expect(await pending).toBe("deny");
    expect(coordinator.current()).toBeNull();
    unsubscribe();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointController } from "../src/file-checkpoints";
import { FileMutationGuard, MUTATION_BASELINE_MAX_FILE_BYTES, MUTATION_BASELINE_MAX_FILES } from "../src/file-mutation-guard";
import { canonicalRealpathSync } from "../src/platform";

const roots: string[] = [];
const controllers: FileCheckpointController[] = [];
let call = 0;
function fixture() {
  const cwd = canonicalRealpathSync(mkdtempSync(join(tmpdir(), "pum-conflicts-")));
  roots.push(cwd);
  const main = new FileCheckpointController(cwd, () => [], join(cwd, "private"));
  const worker = new FileCheckpointController(cwd, () => [], join(cwd, "private"));
  controllers.push(main, worker);
  const path = join(cwd, "shared.txt");
  writeFileSync(path, "alpha = 1\nbeta = 2\n");
  return { cwd, path, main, worker };
}
const read = (c: FileCheckpointController, path: string) => c.mutationGuard.read(`r${call++}`, { path });
const write = (c: FileCheckpointController, path: string, content: string, signal?: AbortSignal) =>
  c.execute("write", `w${call++}`, { path, content }, signal);
const edit = (c: FileCheckpointController, path: string, oldText: string, newText: string) =>
  c.execute("edit", `e${call++}`, { path, edits: [{ oldText, newText }] });
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});

describe("shared file mutation baselines", () => {
  for (const actor of ["main", "worker", "user/Bash"] as const) {
    test(`${actor} changes reject another runtime's stale whole-file write`, async () => {
      const { main, worker, path } = fixture();
      const stale = actor === "worker" ? main : worker;
      await read(stale, path);
      if (actor === "user/Bash") writeFileSync(path, "user changes\n");
      else await write(actor === "main" ? main : worker, path, "user changes\n");
      await expect(write(stale, path, "stale\n")).rejects.toThrow("File mutation conflict");
      expect(readFileSync(path, "utf8")).toBe("user changes\n");
      expect(stale.list()).toEqual([]);
      await read(stale, path);
      await write(stale, path, "reconciled\n");
      expect(readFileSync(path, "utf8")).toBe("reconciled\n");
    });
  }
  test("overlapping edits fail with guidance, while disjoint exact targets preserve both workers' changes", async () => {
    const { main, worker, path } = fixture();
    await Promise.all([read(main, path), read(worker, path)]);
    await edit(main, path, "alpha = 1", "alpha = 10");
    await expect(edit(worker, path, "alpha = 1", "alpha = 11")).rejects.toThrow("worktree: true");
    const result = await edit(worker, path, "beta = 2", "beta = 20");
    expect(readFileSync(path, "utf8")).toBe("alpha = 10\nbeta = 20\n");
    expect(JSON.stringify(result)).toContain("preserved those other changes");
    // A safe edit must not bless the other worker's unseen changes as a new read baseline.
    await expect(write(worker, path, "alpha = 1\nbeta = 20\n")).rejects.toThrow("baseline changed");
    const recovered = await worker.recover(worker.list()[0]!.id);
    expect(readFileSync(recovered, "utf8")).toBe("alpha = 10\nbeta = 2\n");
  });
  test("stale fuzzy or ambiguous edit targets fail instead of rebasing", async () => {
    const { main, path } = fixture();
    await read(main, path);
    writeFileSync(path, "alpha  = 1\nbeta = 2\n");
    await expect(edit(main, path, "alpha = 1", "replacement")).rejects.toThrow("baseline changed");
    writeFileSync(path, "alpha = 1\nalpha = 1\nbeta = 2\n");
    await expect(edit(main, path, "alpha = 1", "replacement")).rejects.toThrow("baseline changed");
  });
  test("stale multi-edit is all-or-nothing when one block overlaps", async () => {
    const { main, worker, path } = fixture();
    await read(worker, path);
    await edit(main, path, "alpha = 1", "gamma = 3");
    await expect(worker.execute("edit", "multi", { path, edits: [
      { oldText: "alpha = 1", newText: "alpha = 5" }, { oldText: "beta = 2", newText: "beta = 5" },
    ] })).rejects.toThrow("baseline changed");
    expect(readFileSync(path, "utf8")).toBe("gamma = 3\nbeta = 2\n");
  });
  test("BOM/CRLF disjoint exact edits keep native matching and diff behavior", async () => {
    const { main, worker, path } = fixture();
    writeFileSync(path, "\ufeffalpha\r\nbeta\r\n");
    await read(worker, path);
    await edit(main, path, "alpha", "ALPHA");
    const result = await edit(worker, path, "beta\n", "BETA\n");
    expect(readFileSync(path, "utf8")).toBe("\ufeffALPHA\r\nBETA\r\n");
    expect(result.details.patch).toContain("+BETA");
  });
  for (const change of ["delete", "replace"] as const) test(`observed ${change} refuses a stale write`, async () => {
    const { main, path } = fixture();
    await read(main, path);
    if (change === "delete") unlinkSync(path);
    else { renameSync(path, path + ".old"); writeFileSync(path, "alpha = 1\nbeta = 2\n"); }
    await expect(write(main, path, "clobber")).rejects.toThrow("baseline changed");
  });
  test("parallel whole-file proposals cannot silently overwrite one another", async () => {
    const { main, worker, path } = fixture();
    const a = { path, content: "first" }, b = { path, content: "second" };
    await Promise.all([main.mutationGuard.prepare("write", "a", a), worker.mutationGuard.prepare("write", "b", b)]);
    const results = await Promise.allSettled([main.execute("write", "a", a), worker.execute("write", "b", b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(main.list().length + worker.list().length).toBe(1);
  });
  test("same-runtime proposals retain their own baselines after the first succeeds", async () => {
    const { main, path } = fixture();
    const a = { path, content: "first" }, b = { path, content: "second" };
    await main.mutationGuard.prepare("write", "a", a);
    await main.mutationGuard.prepare("write", "b", b);
    await main.execute("write", "a", a);
    await expect(main.execute("write", "b", b)).rejects.toThrow("baseline changed");
    await write(main, path, "subsequent own write");
    expect(readFileSync(path, "utf8")).toBe("subsequent own write");
  });
  test("parallel disjoint proposals to the same file both succeed", async () => {
    const { main, worker, path } = fixture();
    const a = { path, edits: [{ oldText: "alpha = 1", newText: "alpha = 3" }] };
    const b = { path, edits: [{ oldText: "beta = 2", newText: "beta = 4" }] };
    await Promise.all([main.mutationGuard.prepare("edit", "a", a), worker.mutationGuard.prepare("edit", "b", b)]);
    await Promise.all([main.execute("edit", "a", a), worker.execute("edit", "b", b)]);
    expect(readFileSync(path, "utf8")).toBe("alpha = 3\nbeta = 4\n");
  });
  test("new file creation proposals conflict instead of replacing the winner", async () => {
    const { main, worker, path } = fixture();
    unlinkSync(path);
    const a = { path, content: "new-a" }, b = { path, content: "new-b" };
    await Promise.all([main.mutationGuard.prepare("write", "a", a), worker.mutationGuard.prepare("write", "b", b)]);
    await main.execute("write", "a", a);
    await expect(worker.execute("write", "b", b)).rejects.toThrow("baseline changed");
    expect(readFileSync(path, "utf8")).toBe("new-a");
  });
  test("user filesystem changes after proposal and during execution are detected, not prevented", async () => {
    const { main, path } = fixture();
    const input = { path, content: "proposed" };
    await main.mutationGuard.prepare("write", "pending", input);
    writeFileSync(path, "user after proposal"); // Deliberately outside PUM: no lock prevents this.
    await expect(main.execute("write", "pending", input)).rejects.toThrow("baseline changed");
    const guard = main.mutationGuard;
    await expect(guard.run("write", "during", input, undefined, async (admission) => {
      writeFileSync(path, "user during execution");
      await guard.assertUnchanged(admission);
    })).rejects.toThrow("during mutation execution");
    expect(readFileSync(path, "utf8")).toBe("user during execution");
  });
  test("different paths and worktree directories do not conflict", async () => {
    const { main, worker, path, cwd } = fixture();
    const isolated = fixture();
    await Promise.all([write(main, path, "main"), write(worker, join(cwd, "other.txt"), "worker"),
      write(isolated.worker, isolated.path, "isolated")]);
    expect(readFileSync(path, "utf8")).toBe("main");
    expect(readFileSync(isolated.path, "utf8")).toBe("isolated");
  });
  test("canonical relative and absolute spellings share the read baseline", async () => {
    const { main, path } = fixture();
    await read(main, "./shared.txt");
    writeFileSync(path, "external");
    await expect(write(main, path, "stale")).rejects.toThrow("baseline changed");
  });
  test("checkpoint clear and recovery copies do not erase or refresh stale observations", async () => {
    const { main, worker, path } = fixture();
    await write(main, path, "main postimage");
    await read(worker, path);
    await main.recover(main.list()[0]!.id);
    await write(worker, path, "worker postimage");
    main.clear();
    await expect(write(main, path, "stale")).rejects.toThrow("baseline changed");
    expect(main.list()).toEqual([]);
  });
  test("missing read baseline is disclosed, and failed/aborted operations do not refresh it", async () => {
    const { main, path } = fixture();
    const result = await write(main, path, "first write");
    expect(JSON.stringify(result)).toContain("No prior read baseline");
    const abort = new AbortController(); abort.abort();
    await expect(write(main, path, "aborted", abort.signal)).rejects.toThrow("aborted");
    await expect(edit(main, path, "missing", "failed")).rejects.toThrow();
    writeFileSync(path, "external");
    await expect(write(main, path, "stale")).rejects.toThrow("baseline changed");
  });
  test("large files retain bounded metadata baselines and refuse stale edit rebasing", async () => {
    const { main, path } = fixture();
    writeFileSync(path, "target\n" + "x".repeat(MUTATION_BASELINE_MAX_FILE_BYTES));
    await read(main, path);
    writeFileSync(path, "target\n" + "y".repeat(MUTATION_BASELINE_MAX_FILE_BYTES + 1));
    await expect(edit(main, path, "target", "changed")).rejects.toThrow("baseline changed");
    await read(main, path);
    const result = await edit(main, path, "target", "changed");
    expect(JSON.stringify(result)).toContain("metadata only");
  });
  test("bounded baseline eviction is disclosed rather than pretending an old read is fresh", async () => {
    const { main, path, cwd } = fixture();
    await read(main, path);
    for (let i = 0; i < MUTATION_BASELINE_MAX_FILES; i++) {
      const next = join(cwd, `file-${i}.txt`); writeFileSync(next, "new"); await read(main, next);
    }
    const result = await write(main, path, "no retained read");
    expect(JSON.stringify(result)).toContain("No prior read baseline");
  });
  test("duplicate call IDs cannot replace an earlier proposal's argument-bound baseline", async () => {
    const { main, path } = fixture();
    const earlier = { path, content: "replacement" }, later = { path, content: "replacement" };
    await main.mutationGuard.prepare("write", "same-id", earlier);
    writeFileSync(path, "user change");
    await main.mutationGuard.prepare("write", "same-id", later);
    await expect(main.execute("write", "same-id", earlier)).rejects.toThrow("baseline changed");
    await main.execute("write", "same-id", later);
    expect(readFileSync(path, "utf8")).toBe("replacement");
  });
  test("denial/settlement cleanup expires exact proposals without dropping a same-ID sibling", async () => {
    const { main, path } = fixture();
    const denied = { path, content: "denied" }, sibling = { path, content: "sibling" };
    await main.mutationGuard.prepare("write", "duplicate", denied);
    await main.mutationGuard.prepare("write", "duplicate", sibling);
    main.mutationGuard.forgetProposal(denied);
    await expect(main.execute("write", "duplicate", denied, undefined, undefined, true)).rejects.toThrow("missing or expired");
    await main.execute("write", "duplicate", sibling, undefined, undefined, true);
    const expired = { path, content: "expired" };
    await main.mutationGuard.prepare("write", "expired", expired);
    main.mutationGuard.clearProposals();
    await expect(main.execute("write", "expired", expired, undefined, undefined, true)).rejects.toThrow("missing or expired");
    expect(readFileSync(path, "utf8")).toBe("sibling");
  });
  test("aborted queued mutations release their slot without blessing a changed baseline", async () => {
    const { main, worker, path } = fixture();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const input = { path, content: "waiting" };
    await worker.mutationGuard.prepare("write", "waiting", input);
    const first = main.mutationGuard.run("write", "held", { path, content: "unused" }, undefined, async () => {
      enter(); await gate;
    });
    await entered;
    const abort = new AbortController();
    const waiting = worker.execute("write", "waiting", input, abort.signal);
    abort.abort(); release();
    await first;
    await expect(waiting).rejects.toThrow("aborted");
    expect(worker.list()).toEqual([]);
    await write(main, path, "queue released");
    expect(readFileSync(path, "utf8")).toBe("queue released");
  });
  test("argument changes, disposal and queue failure cannot leave ownership locked", async () => {
    const { main, worker, path, cwd } = fixture();
    const input = { path, content: "first" };
    await main.mutationGuard.prepare("write", "prepared", input);
    input.content = "different";
    await expect(main.execute("write", "prepared", input)).rejects.toThrow("arguments changed");
    const guard = new FileMutationGuard(cwd, () => []);
    await expect(guard.run("write", "error", input, undefined, async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    guard.dispose();
    await expect(guard.prepare("write", "disposed", input)).rejects.toThrow("disposed");
    await write(worker, path, "still writable");
    expect(readFileSync(path, "utf8")).toBe("still writable");
  });
});

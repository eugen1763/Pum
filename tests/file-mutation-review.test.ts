import { afterEach, expect, test } from "bun:test";
import { createReadToolDefinition, SettingsManager } from "@earendil-works/pi-coding-agent";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindFileCheckpointSession, FileCheckpointController, createFileCheckpointExtension } from "../src/file-checkpoints";
import { FileMutationGuard, MUTATION_BASELINE_MAX_FILE_BYTES, MUTATION_BASELINE_MAX_FILES } from "../src/file-mutation-guard";
import { canonicalRealpathSync } from "../src/platform";
import { registerSandboxTempReadRoot, unregisterSandboxTempReadRoot } from "../src/filesystem-sandbox";

const roots: string[] = [];
const guards: FileMutationGuard[] = [];
function directory() {
  const cwd = canonicalRealpathSync(mkdtempSync(join(tmpdir(), "pum-mutation-review-")));
  roots.push(cwd); return cwd;
}
function fixture() {
  const cwd = directory();
  const guard = new FileMutationGuard(cwd, () => []); guards.push(guard);
  return { cwd, guard };
}
afterEach(() => {
  guards.splice(0).forEach((guard) => guard.dispose());
  roots.splice(0).forEach((root) => { unregisterSandboxTempReadRoot(root); rmSync(root, { recursive: true, force: true }); });
});

for (const name of ["notes’draft.txt", "cafe\u0301.txt", "screen 10.00\u202fAM.txt"]) {
  test(`read keeps SDK filename retry and partial output for ${name}`, async () => {
    const { cwd, guard } = fixture();
    writeFileSync(join(cwd, name), "first\nsecond\nthird\n");
    const path = name.replace("’", "'").normalize("NFC").replace("\u202f", " ");
    const input = { path, offset: 2, limit: 1 };
    const native = await createReadToolDefinition(cwd).execute("native", input, undefined, undefined, { cwd } as any);
    expect(await guard.read("guarded", input)).toEqual(native);
    // Mutations intentionally do not use the read-only narrow-space retry:
    // both native write and sandbox normalize that spelling to a different name.
    if (!name.includes("\u202f")) {
      writeFileSync(join(cwd, name), "changed\n");
      await expect(guard.run("write", "stale", { path: name, content: "stale" }, undefined, async () => {})).rejects.toThrow("baseline changed");
    }
  });
}

test("registered read wrapper preserves native model context and live image-resize settings", async () => {
  const { cwd } = fixture();
  const path = join(cwd, "pixel.png");
  writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const extension = createFileCheckpointExtension();
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const ctx = { cwd, sessionManager: { getSessionId: () => "mutation-review-image" }, model: { input: ["text"] } } as any;
  const settings = SettingsManager.inMemory({ images: { autoResize: false } });
  let getterCalls = 0;
  const session = { sessionId: ctx.sessionManager.getSessionId(), dispose() {}, settingsManager: {
    getImageAutoResize: () => { getterCalls++; return settings.getImageAutoResize(); },
  } };
  bindFileCheckpointSession(session);
  try {
    const input = { path };
    for (const setting of [false, true, false]) {
      settings.setImageAutoResize(setting);
      const native = await createReadToolDefinition(cwd, { autoResizeImages: setting }).execute("native", input, undefined, undefined, ctx);
      const guarded = await tools.get("read").execute("guarded", input, undefined, undefined, ctx);
      expect(JSON.stringify(native)).toContain("Current model does not support images");
      expect(guarded).toEqual(native);
      if (!setting) expect(guarded.content.some((part: any) => part.type === "image")).toBe(true);
    }
    expect(getterCalls).toBe(3);
  } finally { handlers.get("session_shutdown")?.(); session.dispose(); }
});

test("hard-linked and staged file reads remain compatible but cannot authorize mutations", async () => {
  const { cwd, guard } = fixture();
  const path = join(cwd, "hard.txt"); writeFileSync(path, "readable"); linkSync(path, join(cwd, "alias.txt"));
  expect(JSON.stringify(await guard.read("hard", { path }))).toContain("readable");
  await expect(guard.prepare("write", "hard-write", { path, content: "bad" })).rejects.toThrow("hard link");
  const staged = directory(); registerSandboxTempReadRoot(staged);
  const stagedPath = join(staged, "output.txt"); writeFileSync(stagedPath, "staged");
  expect(JSON.stringify(await guard.read("staged", { path: stagedPath }))).toContain("staged");
  await expect(guard.prepare("write", "staged-write", { path: stagedPath, content: "bad" })).rejects.toThrow("outside the sandbox");
});

test.skipIf(process.platform === "win32")("read filename fallback cannot authorize a symlink", async () => {
  const { cwd, guard } = fixture(); const outside = directory();
  writeFileSync(join(outside, "target.txt"), "outside");
  symlinkSync(join(outside, "target.txt"), join(cwd, "notes’draft.txt"));
  await expect(guard.read("link", { path: "notes'draft.txt" })).rejects.toThrow("symbolic link");
});

test("queued root revocation and disposal refuse admission and release the canonical queue", async () => {
  const cwd = directory(), other = directory(), path = join(other, "file.txt"); writeFileSync(path, "before");
  let allowed = [other];
  const holder = new FileMutationGuard(cwd, () => allowed), waiter = new FileMutationGuard(cwd, () => allowed);
  guards.push(holder, waiter);
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const input = { path, content: "after" }; await waiter.prepare("write", "waiting", input);
  const held = holder.run("write", "held", { path, content: "unused" }, undefined, async () => { entered(); await gate; });
  await entry;
  let executed = false;
  const waiting = waiter.run("write", "waiting", input, undefined, async () => { executed = true; }, true);
  allowed = []; release(); await held;
  await expect(waiting).rejects.toThrow("outside the sandbox"); expect(executed).toBe(false);
  allowed = [other];
  waiter.dispose();
  await expect(waiter.prepare("write", "disposed", input)).rejects.toThrow("disposed");
  await holder.run("write", "after", { path, content: "unused" }, undefined, async () => {});
});

test("prepared argument bytes cannot change while waiting in the canonical queue", async () => {
  const { cwd, guard } = fixture(); const path = join(cwd, "waiting.txt"); writeFileSync(path, "before");
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const input = { path, content: "approved" }; await guard.prepare("write", "waiting", input);
  const held = guard.run("write", "holder", { path, content: "unused" }, undefined, async () => { entered(); await gate; });
  await entry;
  let executed = false;
  const waiting = guard.run("write", "waiting", input, undefined, async () => { executed = true; }, true);
  input.content = "not approved"; release(); await held;
  await expect(waiting).rejects.toThrow("arguments changed"); expect(executed).toBe(false);
  await guard.run("write", "unlocked", { path, content: "unused" }, undefined, async () => {});
});

test("prepared proposals require exact object identity and expire at bounded cleanup", async () => {
  const { cwd, guard } = fixture(); const path = join(cwd, "file.txt"); writeFileSync(path, "before");
  const input = { path, content: "after" }; await guard.prepare("write", "id", input);
  await expect(guard.run("write", "id", { ...input }, undefined, async () => {}, true)).rejects.toThrow("missing or expired");
  await guard.run("write", "id", input, undefined, async () => {}, true);
  for (let i = 0; i < MUTATION_BASELINE_MAX_FILES; i++) await guard.prepare("write", `id-${i}`, { path, content: "after" });
  await expect(guard.prepare("write", "over", { path, content: "after" })).rejects.toThrow("too many pending");
  guard.clearProposals(); await guard.prepare("write", "cleared", { path, content: "after" });
});

for (const current of ["alpha\nbeta\r\n", "alpha\r\nbeta\n", "alpha\nbeta\r", "alpha\rbeta\r", "\ufeffalpha\nbeta\r\n"]) test(`stale rebase refuses non-roundtripping line endings ${JSON.stringify(current)}`, async () => {
  const cwd = directory(), path = join(cwd, "mixed.txt");
  const controller = new FileCheckpointController(cwd, () => [], join(cwd, "private"));
  try {
    writeFileSync(path, "alpha\nbeta\n");
    await controller.mutationGuard.read("observed", { path });
    writeFileSync(path, current);
    await expect(controller.execute("edit", "stale", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] })).rejects.toThrow("baseline changed");
    expect(readFileSync(path, "utf8")).toBe(current);
    expect(controller.list()).toEqual([]);
  } finally { controller.dispose(); }
});

for (const current of [
  Buffer.from("alpha\nbeta\0changed\n"),
  Buffer.concat([Buffer.from("alpha\nbeta"), Buffer.from([0xff]), Buffer.from("\n")]),
]) test(`stale rebase refuses binary or invalid UTF-8: ${current.toString("hex")}`, async () => {
  const cwd = directory(), path = join(cwd, "bytes.txt");
  const controller = new FileCheckpointController(cwd, () => [], join(cwd, "private"));
  try {
    writeFileSync(path, "alpha\nbeta\n"); await controller.mutationGuard.read("observed", { path });
    writeFileSync(path, current);
    await expect(controller.execute("edit", "stale", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] })).rejects.toThrow("baseline changed");
    expect(readFileSync(path)).toEqual(current); expect(controller.list()).toEqual([]);
  } finally { controller.dispose(); }
});

for (const ending of ["\n", "\r\n"]) test(`stale rebase preserves BOM and disjoint Unicode bytes with ${JSON.stringify(ending)}`, async () => {
  const cwd = directory(), path = join(cwd, "unicode.txt");
  const controller = new FileCheckpointController(cwd, () => [], join(cwd, "private"));
  try {
    writeFileSync(path, "alpha\nbeta\n"); await controller.mutationGuard.read("observed", { path });
    const untouched = `cafe\u0301 🐈 — “quotes”\t ${ending}`;
    writeFileSync(path, `\ufeffalpha${ending}${untouched}`);
    const result = await controller.execute("edit", "stale", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] });
    expect(readFileSync(path)).toEqual(Buffer.from(`\ufeffALPHA${ending}${untouched}`));
    expect(JSON.stringify(result)).toContain("preserved those other changes");
  } finally { controller.dispose(); }
});

test("fresh mixed-line-ending edits keep SDK behavior rather than disabling edit", async () => {
  const cwd = directory(), path = join(cwd, "fresh-mixed.txt");
  const controller = new FileCheckpointController(cwd, () => [], join(cwd, "private"));
  try {
    writeFileSync(path, "alpha\nbeta\r\n"); await controller.mutationGuard.read("observed", { path });
    await controller.execute("edit", "fresh", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] });
    expect(readFileSync(path, "utf8")).toBe("ALPHA\nbeta\n");
  } finally { controller.dispose(); }
});

test("pending byte bound fails closed and baseline byte eviction discloses lost observation", async () => {
  const { cwd, guard } = fixture();
  const first = join(cwd, "first.txt"); writeFileSync(first, "x".repeat(MUTATION_BASELINE_MAX_FILE_BYTES));
  await guard.read("first", { path: first, limit: 1 });
  for (let i = 0; i < 8; i++) await guard.prepare("write", `large-${i}`, { path: first, content: "small" });
  await expect(guard.prepare("write", "over-bytes", { path: first, content: "small" })).rejects.toThrow("too many pending");
  guard.clearProposals();
  for (let i = 0; i < 8; i++) {
    const path = join(cwd, `large-${i}.txt`); writeFileSync(path, "y".repeat(MUTATION_BASELINE_MAX_FILE_BYTES));
    await guard.read(`large-${i}`, { path, limit: 1 });
  }
  writeFileSync(first, "external");
  await guard.run("write", "evicted", { path: first, content: "small" }, undefined, async (admission) => {
    expect(admission.notice).toContain("No prior read baseline");
  });
});

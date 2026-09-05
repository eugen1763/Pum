import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_FILE_BYTES, CHECKPOINT_MAX_RECORDS,
  FileCheckpointController, bindFileCheckpointSession, checkpointControllerForSession, createFileCheckpointExtension,
  checkpointRecoveryFailureText,
} from "../src/file-checkpoints";
import { canonicalRealpathSync } from "../src/platform";

const directories: string[] = [];
const controllers: FileCheckpointController[] = [];
function directory() {
  const path = canonicalRealpathSync(mkdtempSync(join(tmpdir(), "pum-checkpoints-")));
  directories.push(path);
  return path;
}
function fixture(allowedPaths: () => readonly string[] = () => []) {
  const cwd = directory();
  const controller = new FileCheckpointController(cwd, allowedPaths, join(cwd, "private-config"));
  controllers.push(controller);
  return { cwd, controller, path: join(cwd, "sample.txt") };
}
const write = (controller: FileCheckpointController, path: string, content: string, signal?: AbortSignal) =>
  controller.execute("write", "write-id", { path, content }, signal);
const edit = (controller: FileCheckpointController, path: string, oldText: string, newText: string) =>
  controller.execute("edit", "edit-id", { path, edits: [{ oldText, newText }] });
const artifacts = (cwd: string) => readdirSync(cwd).filter((name) => name.startsWith("pum-recovery-"));
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("runtime-only file checkpoints", () => {
  test("exclusive recovery creation never truncates a competing destination", async () => {
    const { cwd, controller, path } = fixture();
    writeFileSync(path, "before");
    await write(controller, path, "after");
    const original = (controller as any).validate.bind(controller);
    (controller as any).validate = async (target: string) => {
      const result = await original(target);
      if (target.includes("pum-recovery-")) writeFileSync(target, "concurrent destination");
      return result;
    };
    await expect(controller.recover(controller.list()[0]!.id)).rejects.toThrow("exclusively created");
    expect(readFileSync(join(cwd, artifacts(cwd)[0]!), "utf8")).toBe("concurrent destination");
    expect(readFileSync(path, "utf8")).toBe("after");
  });

  test("failure after exclusive create reports artifact and never cleans up competing work", async () => {
    const { cwd, controller, path } = fixture();
    writeFileSync(path, "before");
    await write(controller, path, "after");
    const original = (controller as any).validate.bind(controller);
    let checks = 0;
    (controller as any).validate = async (target: string) => {
      if (target.includes("pum-recovery-") && ++checks === 2) {
        writeFileSync(target, "user artifact");
        writeFileSync(path, "newer original");
        throw new Error("raw IO secret must not be shown");
      }
      return original(target);
    };
    let failure: unknown;
    try { await controller.recover(controller.list()[0]!.id); } catch (error) { failure = error; }
    const text = checkpointRecoveryFailureText(failure);
    expect(text).toContain("possible partial recovery file");
    expect(text).toContain(artifacts(cwd)[0]!);
    expect(text).not.toContain("raw IO secret");
    expect(readFileSync(join(cwd, artifacts(cwd)[0]!), "utf8")).toBe("user artifact");
    expect(readFileSync(path, "utf8")).toBe("newer original");
    expect(checkpointRecoveryFailureText(new Error("hidden details"))).not.toContain("hidden details");
  });
  for (const [name, before] of [
    ["empty", Buffer.alloc(0)],
    ["BOM and CRLF", Buffer.from("\ufeffalpha\r\nbeta\r\n")],
    ["binary", Buffer.from([0, 255, 254, 128, 13, 10, 0, 1])],
  ] as const) {
    test(`write retains exact ${name} preimage and exports distinct siblings`, async () => {
      const { cwd, controller, path } = fixture();
      writeFileSync(path, before);
      const result = await write(controller, "sample.txt", "replacement\n");
      const [record] = controller.list();
      expect(record).toMatchObject({ path, toolName: "write", bytes: before.length, priorAbsent: false });
      expect(result.content.at(-1).text).toContain("Runtime-only");
      const originalStat = lstatSync(path);
      const first = await controller.recover(record!.id);
      const second = await controller.recover(record!.id);
      expect(first).not.toBe(second);
      for (const recovered of [first, second]) {
        expect(dirname(recovered)).toBe(cwd);
        expect(readFileSync(recovered)).toEqual(before);
        expect(lstatSync(recovered).isFile()).toBe(true);
        if (process.platform !== "win32") expect(lstatSync(recovered).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(path, "utf8")).toBe("replacement\n");
      const afterStat = lstatSync(path);
      for (const key of ["ino", "size", "mode", "mtimeMs", "ctimeMs"] as const) expect(afterStat[key]).toBe(originalStat[key]);
      expect(controller.list()).toHaveLength(1);
    });
  }

  test("native multi-edit preserves BOM, CRLF and diff contract", async () => {
    const { controller, path } = fixture();
    const before = Buffer.from("\ufeffalpha\r\nbeta\r\ngamma\r\n");
    writeFileSync(path, before);
    const result = await controller.execute("edit", "multi", { path, edits: [
      { oldText: "alpha\nbeta", newText: "ALPHA\nBETA" }, { oldText: "gamma", newText: "GAMMA" },
    ] });
    expect(readFileSync(path, "utf8")).toBe("\ufeffALPHA\r\nBETA\r\nGAMMA\r\n");
    expect(result.details.diff).toContain("ALPHA");
    expect(result.details.diff).toContain("gamma");
    expect(controller.list()[0]!.toolName).toBe("edit");
    expect(readFileSync(await controller.recover(controller.list()[0]!.id))).toEqual(before);
  });

  test("prior absence never deletes the created file", async () => {
    const { controller, path, cwd } = fixture();
    await write(controller, path, "new");
    expect(controller.list()[0]).toMatchObject({ priorAbsent: true, bytes: 0 });
    await expect(controller.recover(controller.list()[0]!.id)).rejects.toThrow("no prior bytes");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(artifacts(cwd)).toEqual([]);
  });

  for (const change of ["edit", "replacement", "deletion"] as const) {
    test(`recovery rejects concurrent ${change} without creating an export`, async () => {
      const { cwd, controller, path } = fixture();
      writeFileSync(path, "before");
      await write(controller, path, "after");
      if (change === "edit") writeFileSync(path, "other");
      if (change === "replacement") {
        // Same bytes, different identity: keep the old inode allocated while replacing it.
        renameSync(path, join(cwd, "old.txt"));
        writeFileSync(path, "after");
      }
      if (change === "deletion") unlinkSync(path);
      await expect(controller.recover(controller.list()[0]!.id)).rejects.toThrow("conflict");
      expect(artifacts(cwd)).toEqual([]);
      if (change !== "deletion") expect(readFileSync(path, "utf8")).toBe(change === "edit" ? "other" : "after");
      else expect(readdirSync(cwd)).not.toContain("sample.txt");
    });
  }

  test("additional root authorization is rechecked on recovery", async () => {
    const external = directory();
    let roots = [external];
    const { controller } = fixture(() => roots);
    const path = join(external, "sample.txt");
    writeFileSync(path, "before");
    await write(controller, path, "after");
    roots = [];
    await expect(controller.recover(controller.list()[0]!.id)).rejects.toThrow("outside the sandbox");
    expect(artifacts(external)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("after");
  });

  test("credential-sensitive paths are blocked before mutation", async () => {
    const { cwd, controller } = fixture();
    const path = join(cwd, ".env");
    writeFileSync(path, "PRIVATE=before");
    await expect(write(controller, path, "after")).rejects.toThrow();
    expect(controller.list()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("PRIVATE=before");
  });

  test("custom config directory does not retain a preimage", async () => {
    const { cwd, controller } = fixture();
    mkdirSync(join(cwd, "private-config"));
    const path = join(cwd, "private-config", "ordinary.txt");
    writeFileSync(path, "before");
    await write(controller, path, "after");
    expect(controller.list()).toEqual([]);
    expect(controller.summary()).toContain("1 skipped");
  });

  test.skipIf(process.platform === "win32")("symlink mutation is refused (Windows requires symlink privilege)", async () => {
    const { cwd, controller, path } = fixture();
    const target = join(cwd, "target.txt");
    writeFileSync(target, "before");
    symlinkSync(target, path);
    await expect(write(controller, path, "after")).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("before");
    expect(controller.list()).toEqual([]);
  });

  test("hard-linked mutation is refused", async () => {
    const { cwd, controller, path } = fixture();
    writeFileSync(path, "before");
    linkSync(path, join(cwd, "alias.txt"));
    await expect(write(controller, path, "after")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(controller.list()).toEqual([]);
  });

  test("nonregular targets fail without checkpoint", async () => {
    const { controller, path } = fixture();
    mkdirSync(path);
    await expect(write(controller, path, "after")).rejects.toThrow();
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(controller.list()).toEqual([]);
  });

  test("1 MiB inclusive preimage bound; oversized before and after skip coverage", async () => {
    const { controller, path } = fixture();
    const maximum = "x".repeat(CHECKPOINT_MAX_FILE_BYTES);
    writeFileSync(path, maximum);
    await write(controller, path, "small");
    expect(controller.list()[0]!.bytes).toBe(CHECKPOINT_MAX_FILE_BYTES);
    controller.clear();
    writeFileSync(path, maximum + "x");
    await write(controller, path, "small");
    expect(controller.list()).toEqual([]);
    await write(controller, path, maximum + "x");
    expect(controller.list()).toEqual([]);
    expect(readFileSync(path).length).toBe(CHECKPOINT_MAX_FILE_BYTES + 1);
    expect(controller.summary()).toContain("2 skipped");
  });

  test("oversized edit still executes without coverage", async () => {
    const { controller, path } = fixture();
    writeFileSync(path, "first\n" + "x".repeat(CHECKPOINT_MAX_FILE_BYTES));
    await edit(controller, path, "first", "second");
    expect(readFileSync(path, "utf8").startsWith("second\n")).toBe(true);
    expect(controller.list()).toEqual([]);
  });

  test("FIFO retains exactly 32 records including zero-byte prior absence", async () => {
    const { cwd, controller } = fixture();
    let first = "";
    for (let i = 0; i <= CHECKPOINT_MAX_RECORDS; i++) {
      await write(controller, join(cwd, `${i}.txt`), String(i));
      if (i === 0) first = controller.list()[0]!.id;
    }
    expect(controller.list()).toHaveLength(CHECKPOINT_MAX_RECORDS);
    expect(controller.list()[0]!.path).toBe(join(cwd, "1.txt"));
    expect(controller.summary()).toContain("0/8388608 bytes; 0 skipped, 1 evicted");
    await expect(controller.recover(first)).rejects.toThrow("unavailable");
  });

  test("FIFO byte cap is inclusive at 8 MiB and evicts oldest preimage", async () => {
    const { cwd, controller } = fixture();
    for (let i = 0; i < 9; i++) {
      const path = join(cwd, `${i}.txt`);
      writeFileSync(path, Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES, i));
      await write(controller, path, "small");
    }
    expect(controller.list()).toHaveLength(8);
    expect(controller.list().reduce((sum, item) => sum + item.bytes, 0)).toBe(CHECKPOINT_MAX_BYTES);
    expect(controller.list()[0]!.path).toBe(join(cwd, "1.txt"));
    expect(controller.summary()).toContain("1 evicted");
  });

  test("failed and already-aborted mutations retain no records", async () => {
    const { controller, path } = fixture();
    writeFileSync(path, "before");
    await expect(edit(controller, path, "not found", "after")).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(write(controller, path, "after", abort.signal)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(controller.list()).toEqual([]);
  });

  test("native queue serializes preimages and clear invalidates queued capture", async () => {
    const { controller, path } = fixture();
    writeFileSync(path, "zero");
    await Promise.all([write(controller, path, "one"), write(controller, path, "two")]);
    const records = controller.list();
    expect(records).toHaveLength(2);
    expect(readFileSync(await controller.recover(records[1]!.id), "utf8")).toBe("one");
    await expect(controller.recover(records[0]!.id)).rejects.toThrow("conflict");
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocking = withFileMutationQueue(path, async () => { entered(); await gate; });
    await ready;
    const pending = write(controller, path, "three");
    controller.clear();
    release();
    await Promise.all([blocking, pending]);
    expect(readFileSync(path, "utf8")).toBe("three");
    expect(controller.list()).toEqual([]);
  });

  test("abort while waiting for the native queue does not mutate or capture", async () => {
    const { controller, path } = fixture();
    writeFileSync(path, "before");
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocking = withFileMutationQueue(path, async () => { entered(); await gate; });
    await ready;
    const abort = new AbortController();
    const pending = write(controller, path, "after", abort.signal);
    abort.abort();
    release();
    await expect(pending).rejects.toThrow();
    await blocking;
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(controller.list()).toEqual([]);
  });

  test("recovery waits on the SDK queue and rechecks intervening changes", async () => {
    const { controller, path, cwd } = fixture();
    writeFileSync(path, "before");
    await write(controller, path, "after");
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocking = withFileMutationQueue(path, async () => { entered(); await gate; writeFileSync(path, "intervening"); });
    await ready;
    const pending = controller.recover(controller.list()[0]!.id);
    release();
    await expect(pending).rejects.toThrow("conflict");
    await blocking;
    expect(readFileSync(path, "utf8")).toBe("intervening");
    expect(artifacts(cwd)).toEqual([]);
  });

  test("recovery rejects a newly hard-linked original", async () => {
    const { controller, path, cwd } = fixture();
    writeFileSync(path, "before");
    await write(controller, path, "after");
    linkSync(path, join(cwd, "alias.txt"));
    await expect(controller.recover(controller.list()[0]!.id)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("after");
    expect(artifacts(cwd)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("recovery rejects an original replaced by a symlink (Windows requires symlink privilege)", async () => {
    const { controller, path, cwd } = fixture();
    writeFileSync(path, "before");
    await write(controller, path, "after");
    const target = join(cwd, "target.txt");
    renameSync(path, target);
    symlinkSync(target, path);
    await expect(controller.recover(controller.list()[0]!.id)).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("after");
    expect(artifacts(cwd)).toEqual([]);
  });

  test("list is detached metadata and dispose expires recovery", async () => {
    const { controller, path } = fixture();
    writeFileSync(path, "before");
    await write(controller, path, "after");
    const list = controller.list();
    const id = list[0]!.id;
    expect(Object.keys(list[0]!).sort()).toEqual(["id", "path", "toolName", "createdAt", "bytes", "priorAbsent"].sort());
    list[0]!.path = "changed";
    expect(controller.list()[0]!.path).toBe(path);
    controller.dispose();
    expect(controller.list()).toEqual([]);
    await expect(controller.recover(id)).rejects.toThrow("unavailable");
    await expect(write(controller, path, "later")).rejects.toThrow("disposed");
    expect(readFileSync(path, "utf8")).toBe("after");
    expect(controller.list()).toEqual([]);
  });

  for (const timing of ["before", "after"] as const) {
    test(`direct session disposal bound ${timing} start clears runtime bytes even when dispose throws`, async () => {
      const cwd = directory();
      const handlers = new Map<string, Function>();
      const extension = createFileCheckpointExtension();
      if (typeof extension === "function") throw new Error("Expected named checkpoint extension");
      extension.factory({ on: (event: string, handler: Function) => handlers.set(event, handler), registerTool: () => {} } as any);
      const id = `dispose-${cwd}`;
      const ctx = { cwd, sessionManager: { getSessionId: () => id } };
      const session = { sessionId: id, calls: 0, dispose() { this.calls++; throw new Error("underlying dispose failure"); } };
      try {
        if (timing === "before") bindFileCheckpointSession(session);
        handlers.get("session_start")!({}, ctx);
        if (timing === "after") bindFileCheckpointSession(session);
        const controller = checkpointControllerForSession(id)!;
        const path = join(cwd, "sample.txt");
        writeFileSync(path, "before");
        await write(controller, path, "after");
        expect(controller.list()).toHaveLength(1);
        expect(() => session.dispose()).toThrow("underlying dispose failure");
        expect(session.calls).toBe(1);
        expect(controller.list()).toEqual([]);
        expect(checkpointControllerForSession(id)).toBeUndefined();
        await expect(write(controller, path, "bad")).rejects.toThrow("disposed");
        expect(readFileSync(path, "utf8")).toBe("after");
      } finally { handlers.get("session_shutdown")!({}, ctx); }
    });
  }

  test("readonly extension registers neither mutation tools nor lifecycle state", () => {
    const extension = createFileCheckpointExtension({ readonly: true });
    if (typeof extension === "function") throw new Error("Expected named checkpoint extension");
    let registrations = 0;
    extension.factory({ on: () => { registrations++; }, registerTool: () => { registrations++; } } as any);
    expect(registrations).toBe(0);
  });

  test("extension binds per session, keeps installed SDK argument preparation, and disposes", async () => {
    const cwd = directory();
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const extension = createFileCheckpointExtension();
    if (typeof extension === "function") throw new Error("Expected named checkpoint extension");
    extension.factory({
      on: (event: string, handler: Function) => handlers.set(event, handler),
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
    const id = `checkpoint-test-${cwd}`;
    const ctx = { cwd, sessionManager: { getSessionId: () => id } };
    try {
      handlers.get("session_start")!({}, ctx);
      const controller = checkpointControllerForSession(id)!;
      expect(controller).toBeDefined();
      const path = join(cwd, "sample.txt");
      writeFileSync(path, "one two three");
      const tool = tools.get("edit");
      for (const raw of [
        { path: "sample.txt", oldText: "one", newText: "ONE" },
        { path: "sample.txt", edits: JSON.stringify([{ oldText: "two", newText: "TWO" }]) },
        { path: "sample.txt", edits: { oldText: "three", newText: "THREE" } },
      ]) {
        const prepared = await tool.prepareArguments(raw);
        const result = await tool.execute("sdk-contract", prepared, undefined, undefined, ctx);
        expect(result.details.diff).toBeString();
      }
      expect(readFileSync(path, "utf8")).toBe("ONE TWO THREE");
      expect(controller.list()).toHaveLength(3);
      handlers.get("session_shutdown")!({}, ctx);
      expect(checkpointControllerForSession(id)).toBeUndefined();
      expect(controller.list()).toEqual([]);
      expect(() => handlers.get("session_start")!({}, ctx)).toThrow("unavailable");
      expect(() => tool.execute("stale", { path, edits: [{ oldText: "ONE", newText: "bad" }] }, undefined, undefined, ctx)).toThrow("unavailable");
      expect(readFileSync(path, "utf8")).toBe("ONE TWO THREE");
    } finally { handlers.get("session_shutdown")!({}, ctx); }
  });
});

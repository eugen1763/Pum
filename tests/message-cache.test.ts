import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageCacheController } from "../src/message-cache";
import { PromptCacheStore, type PromptCacheFileOps } from "../src/prompt-cache";

const directories: string[] = [];

function fixture(platform: NodeJS.Platform = "linux", ops?: PromptCacheFileOps) {
  const directory = mkdtempSync(join(tmpdir(), "pum-message-cache-"));
  directories.push(directory);
  const historyPath = join(directory, "history.json");
  const stashPath = join(directory, "prompt-stash.json");
  const store = new PromptCacheStore(historyPath, stashPath, platform, ops);
  const cwd = platform === "win32" ? "C:\\Work\\Repo" : "/work/repo";
  return { directory, historyPath, stashPath, cwd, store, controller: new MessageCacheController(cwd, store) };
}

function context(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId } } as any;
}

function register(controller: MessageCacheController, requester: (ctx: any) => any) {
  const tools = new Map<string, any>();
  controller.registerTools({ registerTool(tool: any) { tools.set(tool.name, tool); } }, requester);
  return tools;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("message cache ownership and tools", () => {
  test("requires send before cached task assignment through exact tool metadata", () => {
    const { controller } = fixture();
    const tools = register(controller, () => ({ kind: "main", id: "session-1", name: "main" }));
    const send = tools.get("message_cache_send");

    expect(send.description).toBe(
      "Execute cached messages by stable ID through PUM's authoritative user execution path. This marks entries executed and produces the main-agent coordination path. Order and duplicates are preserved.",
    );
    expect(send.promptGuidelines).toEqual([
      "Use stable IDs from message_cache_list or message_cache_read.",
      "When the user asks to do, run, or execute open or pending cached tasks, call message_cache_send before spawning or assigning work.",
      "Listing entries or reading previews is not execution and does not replace message_cache_send.",
      "After the generated coordination prompt arrives, reuse agents already assigned to those tasks and never create duplicate assignments.",
      "Do not retry a send while the requester or target is still processing a prior cache send.",
    ]);
  });

  test("migrates legacy object rows as stable user-owned entries", () => {
    const { cwd, stashPath, store } = fixture();
    writeFileSync(stashPath, JSON.stringify({ [cwd]: [{ text: "legacy", executed: false }] }));

    const first = store.loadStash(cwd);
    const second = store.loadStash(cwd);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ text: "legacy", owner: { type: "user" } });
    expect(first[0]!.id).toStartWith("cache-");
  });

  test("repairs duplicate legacy IDs without merging duplicate rows", () => {
    const { cwd, stashPath, store } = fixture();
    writeFileSync(stashPath, JSON.stringify({
      [cwd]: [
        { id: "cache-duplicate", text: "first", executed: false },
        { id: "cache-duplicate", text: "second", executed: false },
      ],
    }));

    const entries = store.loadStash(cwd);
    expect(entries.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(entries.every((entry) => entry.owner.type === "user")).toBe(true);
  });

  test("binds exact main and child ownership without model-supplied identities", async () => {
    const { controller } = fixture();
    const mainTools = register(controller, (ctx) => ({ kind: "main", id: ctx.sessionManager.getSessionId(), name: "main" }));
    const childTools = register(controller, () => ({ kind: "subagent", id: "child-1", name: "worker\nname" }));

    const mainResult = await mainTools.get("message_cache_add").execute("add-main", { text: "main row" }, undefined, undefined, context("session-1"));
    const childResult = await childTools.get("message_cache_add").execute("add-child", { text: "child row" }, undefined, undefined, context("ignored"));
    const entries = controller.list();

    expect(mainResult.details.id).toBeString();
    expect(childResult.details.id).toBeString();
    expect(entries.find((entry) => entry.text === "main row")?.owner).toEqual({ type: "agent", id: "session-1", name: "main" });
    expect(entries.find((entry) => entry.text === "child row")?.owner).toEqual({ type: "agent", id: "child-1", name: "worker name" });
  });

  test("allows deletion only by the exact creating agent", () => {
    const { controller, cwd, store } = fixture();
    const own = controller.add({ kind: "subagent", id: "child-1", name: "one" }, "owned");
    const sibling = controller.add({ kind: "subagent", id: "child-2", name: "two" }, "sibling");
    const main = controller.add({ kind: "main", id: "session-1", name: "main" }, "main");
    const user = store.appendStash(cwd, "user", false)[0]!;

    expect(() => controller.delete({ kind: "subagent", id: "child-1", name: "one" }, sibling.id)).toThrow();
    expect(() => controller.delete({ kind: "main", id: "session-1", name: "main" }, user.id)).toThrow();
    expect(() => controller.delete({ kind: "main", id: "session-2", name: "main" }, main.id)).toThrow();
    controller.delete({ kind: "subagent", id: "child-1", name: "one" }, own.id);
    expect(controller.list().some((entry) => entry.id === own.id)).toBe(false);
  });

  test("lists concise previews and reads full entries in supplied duplicate order", async () => {
    const { controller } = fixture();
    const requester = { kind: "subagent", id: "child-1", name: "worker" } as const;
    const first = controller.add(requester, `first ${"x".repeat(300)}`);
    const second = controller.add(requester, "second");
    const tools = register(controller, () => requester);

    const listed = await tools.get("message_cache_list").execute("list", {}, undefined, undefined, context("x"));
    const read = await tools.get("message_cache_read").execute("read", { ids: [second.id, first.id, second.id] }, undefined, undefined, context("x"));

    expect(listed.content[0].text.length).toBeLessThan(700);
    expect(JSON.parse(read.content[0].text).map((entry: any) => entry.id)).toEqual([second.id, first.id, second.id]);
  });
});

describe("message cache send serialization", () => {
  test("preserves ID order and duplicates and rejects stale IDs", async () => {
    const { controller } = fixture();
    const requester = { kind: "main", id: "session-1", name: "main" } as const;
    const first = controller.add(requester, "first");
    const second = controller.add(requester, "second");
    let received: string[] = [];
    controller.bindExecutor("session-1", async (request) => {
      received = request.ids;
      return { count: request.ids.length, route: "main" };
    });

    await controller.send(requester, [second.id, first.id, second.id]);
    expect(received).toEqual([second.id, first.id, second.id]);
    expect(controller.list().filter((entry) => [first.id, second.id].includes(entry.id)).every((entry) => entry.executed)).toBe(true);
    controller.releaseRequester(requester);
    await expect(controller.send(requester, ["missing"])).rejects.toThrow("stale");
  });

  test("blocks repeated send races until the requester and target settle", async () => {
    const { controller } = fixture();
    const child = { kind: "subagent", id: "child-1", name: "worker" } as const;
    const first = controller.add(child, "first");
    const second = controller.add(child, "second");
    let resolve!: () => void;
    controller.bindExecutor("main-session", () => new Promise((done) => {
      resolve = () => done({ count: 2, route: "main" });
    }));

    const running = controller.send(child, [first.id, second.id]);
    await expect(controller.send(child, [first.id])).rejects.toThrow("already active");
    resolve();
    await running;
    controller.releaseRequester(child);
    await expect(controller.send(child, [first.id, second.id])).rejects.toThrow("already active");
    controller.releaseRequester({ kind: "main", id: "main-session" });
  });

  test("leaves entries pending when main delivery fails", async () => {
    const { controller } = fixture();
    const requester = { kind: "main", id: "session-1", name: "main" } as const;
    const entry = controller.add(requester, "main task");
    controller.bindExecutor("session-1", async () => {
      throw new Error("main delivery failed");
    });

    await expect(controller.send(requester, [entry.id])).rejects.toThrow("main delivery failed");
    expect(controller.list().find((item) => item.id === entry.id)?.executed).toBe(false);
  });

  test("leaves entries pending when child delivery fails", async () => {
    const { controller } = fixture();
    const requester = { kind: "subagent", id: "child-1", name: "worker" } as const;
    const entry = controller.add(requester, "child task");
    controller.bindExecutor("main-session", async () => {
      throw new Error("child delivery failed");
    });

    await expect(controller.send(requester, [entry.id])).rejects.toThrow("child delivery failed");
    expect(controller.list().find((item) => item.id === entry.id)?.executed).toBe(false);
  });

  test("reserves IDs across requesters and commits after successful delivery", async () => {
    const { controller } = fixture();
    const firstRequester = { kind: "subagent", id: "child-1", name: "one" } as const;
    const secondRequester = { kind: "subagent", id: "child-2", name: "two" } as const;
    const entry = controller.add(firstRequester, "shared task");
    let resolve!: () => void;
    controller.bindExecutor("main-session", () => new Promise((done) => {
      resolve = () => done({ count: 1, route: "subagent" });
    }));

    const running = controller.send(firstRequester, [entry.id]);
    await expect(controller.send(secondRequester, [entry.id])).rejects.toThrow("already active");
    expect(controller.list().find((item) => item.id === entry.id)?.executed).toBe(false);
    resolve();
    await running;
    expect(controller.list().find((item) => item.id === entry.id)?.executed).toBe(true);
  });

  test("rejects a stale main session and keeps workspaces isolated", async () => {
    const first = fixture();
    const second = fixture();
    const entry = first.controller.add({ kind: "main", id: "old", name: "main" }, "one");
    first.controller.bindExecutor("current", async () => ({ count: 1, route: "main" }));

    await expect(first.controller.send({ kind: "main", id: "old", name: "main" }, [entry.id])).rejects.toThrow("no longer active");
    expect(second.controller.list()).toEqual([]);
    expect(() => second.controller.read([entry.id])).toThrow("stale");
  });
});

describe("message cache atomic persistence", () => {
  test("retries transient atomic rename failures", () => {
    const base = fixture();
    let failures = 0;
    const ops: PromptCacheFileOps = {
      exists: existsSync,
      mkdir: mkdirSync,
      read: readFileSync,
      write: writeFileSync,
      copy: copyFileSync,
      remove: rmSync,
      rename(source, target) {
        if (String(source).endsWith(".tmp") && failures < 2) {
          failures++;
          throw Object.assign(new Error("transient rename failure"), { code: "EPERM" });
        }
        renameSync(source, target);
      },
    };
    const store = new PromptCacheStore(base.historyPath, base.stashPath, "win32", ops);

    expect(store.appendHistory(base.cwd, "saved after retry")).toEqual(["saved after retry"]);
    expect(failures).toBe(2);
    expect(readFileSync(base.historyPath, "utf8")).toContain("saved after retry");
  });

  test("rolls back both files when the second commit rename fails", () => {
    const base = fixture();
    const owner = { type: "agent", id: "agent-1", name: "agent" } as const;
    const entry = base.store.addAgentStash(base.cwd, "cached", owner);
    const beforeHistory = readFileSync(base.historyPath, "utf8");
    const beforeStash = readFileSync(base.stashPath, "utf8");
    let commits = 0;
    let failed = false;
    const ops: PromptCacheFileOps = {
      exists: existsSync,
      mkdir: mkdirSync,
      read: readFileSync,
      write: writeFileSync,
      copy: copyFileSync,
      remove: rmSync,
      rename(source, target) {
        if (String(source).endsWith(".tmp")) {
          commits++;
          if (commits === 2 && !failed) {
            failed = true;
            throw new Error("injected rename failure");
          }
        }
        renameSync(source, target);
      },
    };
    const failing = new PromptCacheStore(base.historyPath, base.stashPath, "linux", ops);

    expect(() => failing.executeStashByIds(base.cwd, [entry.id])).toThrow("persistence failed");
    expect(readFileSync(base.historyPath, "utf8")).toBe(beforeHistory);
    expect(readFileSync(base.stashPath, "utf8")).toBe(beforeStash);
    expect(base.store.loadStash(base.cwd).find((item) => item.id === entry.id)?.executed).toBe(false);
  });
});

describe("message cache growth bounds", () => {
  test("bounds repeated adds and evicts executed entries before pending ones", () => {
    const { controller, store, cwd } = fixture();
    const requester = { kind: "subagent", id: "agent-1", name: "worker" } as const;
    const executed = Array.from({ length: 400 }, (_, index) => controller.add(requester, `executed ${index}`));
    store.executeStashByIds(cwd, executed.map((entry) => entry.id));
    for (let index = 0; index < 300; index++) controller.add(requester, `pending ${index}`);

    const entries = controller.list();

    expect(entries).toHaveLength(500);
    expect(entries.filter((entry) => entry.executed)).toHaveLength(200);
    expect(entries[0]!.text).toBe("executed 200");
    expect(entries.at(-1)!.text).toBe("pending 299");
  }, 30_000);
});

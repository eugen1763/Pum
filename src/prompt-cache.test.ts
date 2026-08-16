import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptCacheStore, type PromptCacheFileOps } from "./prompt-cache";

const directories: string[] = [];

function fixture(platform: NodeJS.Platform = "linux") {
  const directory = mkdtempSync(join(tmpdir(), "pum-prompt-cache-"));
  directories.push(directory);
  const historyPath = join(directory, "history.json");
  const stashPath = join(directory, "prompt-stash.json");
  return {
    historyPath,
    stashPath,
    store: new PromptCacheStore(historyPath, stashPath, platform),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitWorktreeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pum-prompt-cache-git-"));
  directories.push(directory);
  const primary = join(directory, "primary");
  const linked = join(directory, "linked");
  mkdirSync(primary);
  git(primary, ["init", "-q", "-b", "main"]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "PUM Test"]);
  writeFileSync(join(primary, "tracked.txt"), "initial\n");
  git(primary, ["add", "tracked.txt"]);
  git(primary, ["commit", "-qm", "initial"]);
  git(primary, ["worktree", "add", "-q", "-b", "linked", linked]);
  const historyPath = join(directory, "history.json");
  const stashPath = join(directory, "prompt-stash.json");
  return { primary, linked, historyPath, stashPath, store: new PromptCacheStore(historyPath, stashPath) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("prompt history and cache cleanup", () => {
  test("shares history and stash with the primary Git worktree", () => {
    const { primary, linked, historyPath, stashPath, store } = gitWorktreeFixture();

    store.appendHistory(primary, "from primary");
    store.appendStash(primary, "cached in primary");
    expect(store.loadHistory(linked)).toEqual(["from primary"]);
    expect(store.loadStash(linked).map((entry) => entry.text)).toEqual(["cached in primary"]);

    store.appendHistory(linked, "from linked");
    store.appendStash(linked, "cached in linked");
    expect(store.loadHistory(primary)).toEqual(["from primary", "from linked"]);
    expect(store.loadStash(primary).map((entry) => entry.text)).toEqual([
      "cached in primary",
      "cached in linked",
    ]);
    expect(Object.keys(readJson(historyPath))).toEqual([primary]);
    expect(Object.keys(readJson(stashPath))).toEqual([primary]);
  });

  test("migrates old isolated linked-worktree cache entries", () => {
    const { primary, linked, historyPath, stashPath, store } = gitWorktreeFixture();
    writeJson(historyPath, { [primary]: ["primary"], [linked]: ["linked"] });
    writeJson(stashPath, {
      [primary]: [{ text: "primary cached", executed: false }],
      [linked]: [{ text: "linked cached", executed: false }],
    });

    expect(store.loadHistory(linked)).toEqual(["primary", "linked"]);
    expect(store.loadStash(linked).map((entry) => entry.text)).toEqual([
      "primary cached",
      "linked cached",
    ]);
    expect(Object.keys(readJson(historyPath))).toEqual([primary]);
    expect(Object.keys(readJson(stashPath))).toEqual([primary]);
  });

  test("keeps corresponding subdirectories shared without merging the whole repository", () => {
    const { primary, linked, store } = gitWorktreeFixture();
    const primarySubdirectory = join(primary, "src");
    const linkedSubdirectory = join(linked, "src");
    mkdirSync(primarySubdirectory);
    mkdirSync(linkedSubdirectory);

    store.appendHistory(primarySubdirectory, "from primary src");

    expect(store.loadHistory(linkedSubdirectory)).toEqual(["from primary src"]);
    expect(store.loadHistory(primary)).toEqual([]);
  });

  test("maps a worktree created from another linked worktree back to the primary", () => {
    const { primary, linked, store } = gitWorktreeFixture();
    const nested = join(linked, "nested-worktree");
    git(linked, ["worktree", "add", "-q", "-b", "nested", nested]);

    store.appendHistory(nested, "from nested");

    expect(store.loadHistory(primary)).toEqual(["from nested"]);
  });

  test("retains 100 recent sent entries plus every cached occurrence", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/one";
    const sent = Array.from({ length: 130 }, (_, index) => `sent ${index}`);
    writeJson(historyPath, { [cwd]: ["cached one", "cached two", ...sent] });
    writeJson(stashPath, {
      [cwd]: [
        { text: "cached one", executed: false },
        { text: "cached two", executed: false },
      ],
    });

    const history = store.loadHistory(cwd);

    expect(history).toEqual(["cached one", "cached two", ...sent.slice(-100)]);
    expect((readJson(historyPath)[cwd] as string[]).length).toBe(102);
    expect(store.loadStash(cwd)).toHaveLength(2);
  });

  test("protects cached duplicate occurrences without protecting all sent duplicates", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/duplicates";
    writeJson(historyPath, { [cwd]: Array.from({ length: 140 }, () => "same prompt") });
    writeJson(stashPath, {
      [cwd]: [
        { text: "same prompt", executed: false },
        { text: "same prompt", executed: false },
      ],
    });

    expect(store.loadHistory(cwd)).toEqual(Array.from({ length: 102 }, () => "same prompt"));

    store.removeStash(cwd, 1);
    expect(store.loadHistory(cwd)).toEqual(Array.from({ length: 101 }, () => "same prompt"));
  });

  test("migrates legacy string stash rows with occurrence-aware executed state", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/legacy";
    writeJson(historyPath, { [cwd]: ["sent once"] });
    writeJson(stashPath, { [cwd]: ["sent once", "cached", "sent once"] });

    expect(store.loadStash(cwd).map(({ text, executed, owner }) => ({ text, executed, owner }))).toEqual([
      { text: "sent once", executed: true, owner: { type: "user" } },
      { text: "cached", executed: false, owner: { type: "user" } },
      { text: "sent once", executed: false, owner: { type: "user" } },
    ]);
    expect((readJson(stashPath)[cwd] as any[]).map(({ text, executed, owner }) => ({ text, executed, owner }))).toEqual([
      { text: "sent once", executed: true, owner: { type: "user" } },
      { text: "cached", executed: false, owner: { type: "user" } },
      { text: "sent once", executed: false, owner: { type: "user" } },
    ]);
  });

  test("isolates cleanup by working directory", () => {
    const { historyPath, stashPath, store } = fixture();
    const first = "/work/first";
    const second = "/work/second";
    const firstHistory = Array.from({ length: 110 }, (_, index) => `first ${index}`);
    const secondHistory = Array.from({ length: 110 }, (_, index) => `second ${index}`);
    writeJson(historyPath, { [first]: firstHistory, [second]: secondHistory });
    writeJson(stashPath, { [first]: [], [second]: [] });

    expect(store.loadHistory(first)).toEqual(firstHistory.slice(-100));
    expect(readJson(historyPath)[second]).toEqual(secondHistory);
    expect(store.loadHistory(second)).toEqual(secondHistory.slice(-100));
  });

  test("reconciles legacy Windows key spelling into one normalized identity", () => {
    const { historyPath, stashPath, store } = fixture("win32");
    const legacyCwd = "C:\\Users\\Ada\\Project";
    const normalizedCwd = "c:\\users\\ada\\project";
    writeJson(historyPath, {
      [legacyCwd]: ["old prompt"],
      [normalizedCwd]: ["new prompt"],
    });
    writeJson(stashPath, {
      [legacyCwd]: [{ text: "legacy cached", executed: false }],
      [normalizedCwd]: [{ text: "normalized cached", executed: false }],
    });

    expect(store.loadHistory(normalizedCwd)).toEqual(["old prompt", "new prompt"]);
    expect(store.loadStash(normalizedCwd).map(({ text, executed, owner }) => ({ text, executed, owner }))).toEqual([
      { text: "legacy cached", executed: false, owner: { type: "user" } },
      { text: "normalized cached", executed: false, owner: { type: "user" } },
    ]);
    expect(Object.keys(readJson(historyPath))).toEqual([normalizedCwd]);
    expect(Object.keys(readJson(stashPath))).toEqual([normalizedCwd]);
  });

  test("cleans after history and stash mutations without deleting cached rows", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/mutations";
    const cached = Array.from({ length: 205 }, (_, index) => `cached ${index}`);
    const sent = Array.from({ length: 105 }, (_, index) => `sent ${index}`);
    writeJson(historyPath, { [cwd]: [...cached, ...sent] });
    writeJson(stashPath, {
      [cwd]: cached.map((text, index) => ({ text, executed: index % 2 === 0 })),
    });

    const stash = store.loadStash(cwd);
    expect(stash).toHaveLength(205);
    expect(store.loadHistory(cwd)).toEqual([...cached, ...sent.slice(-100)]);

    store.appendHistory(cwd, "new sent");
    expect(store.loadHistory(cwd)).toEqual([...cached, ...sent.slice(-99), "new sent"]);

    const removed = stash.findIndex((prompt) => prompt.text === "cached 0");
    store.removeStash(cwd, removed);
    expect(store.loadHistory(cwd)).toEqual([...cached.slice(1), ...sent.slice(-99), "new sent"]);
  });
});

describe("cache bounds", () => {
  test("caps cached entries per working directory and evicts executed rows first", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/bounded";
    writeJson(historyPath, { [cwd]: [] });
    writeJson(stashPath, {
      [cwd]: Array.from({ length: 600 }, (_, index) => ({
        text: `entry ${index}`,
        executed: index < 300,
      })),
    });

    const stash = store.loadStash(cwd);

    expect(stash).toHaveLength(500);
    expect(stash.filter((entry) => entry.executed)).toHaveLength(200);
    expect(stash.filter((entry) => !entry.executed)).toHaveLength(300);
    expect(stash[0]!.text).toBe("entry 100");
    expect(stash.at(-1)!.text).toBe("entry 599");
    expect((readJson(stashPath)[cwd] as unknown[]).length).toBe(500);
  });

  test("drops the oldest pending rows only when no executed row is left", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/pending";
    writeJson(historyPath, { [cwd]: [] });
    writeJson(stashPath, {
      [cwd]: Array.from({ length: 520 }, (_, index) => ({ text: `pending ${index}`, executed: false })),
    });

    const stash = store.loadStash(cwd);

    expect(stash).toHaveLength(500);
    expect(stash[0]!.text).toBe("pending 20");
    expect(stash.at(-1)!.text).toBe("pending 519");
  });

  test("caps total cached text and keeps the newest entry", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/bytes";
    const text = "x".repeat(12_000);
    writeJson(historyPath, { [cwd]: [] });
    writeJson(stashPath, {
      [cwd]: Array.from({ length: 100 }, (_, index) => ({ text: `${index} ${text}`, executed: false })),
    });

    const stash = store.loadStash(cwd);
    const characters = stash.reduce((total, entry) => total + entry.text.length, 0);

    expect(characters).toBeLessThanOrEqual(1_000_000);
    expect(stash).toHaveLength(83);
    expect(stash.at(-1)!.text.startsWith("99 ")).toBe(true);
  });

  test("returns the entry an agent adds at capacity", () => {
    const { historyPath, stashPath, store } = fixture();
    const cwd = "/work/full";
    writeJson(historyPath, { [cwd]: [] });
    writeJson(stashPath, {
      [cwd]: Array.from({ length: 500 }, (_, index) => ({ text: `entry ${index}`, executed: true })),
    });

    const added = store.addAgentStash(cwd, "fresh", { type: "agent", id: "agent-1", name: "agent" });
    const stash = store.loadStash(cwd);

    expect(added.text).toBe("fresh");
    expect(stash).toHaveLength(500);
    expect(stash.at(-1)!.id).toBe(added.id);
    expect(stash[0]!.text).toBe("entry 1");
  });
});

describe("cross-process cache locking", () => {
  test("keeps both working directory keys when two PUM processes interleave", async () => {
    const { historyPath, stashPath } = fixture();
    const directory = join(historyPath, "..");
    const script = join(directory, "writer.ts");
    writeFileSync(
      script,
      `import { PromptCacheStore } from ${JSON.stringify(join(import.meta.dir, "prompt-cache.ts"))};\n`
        + "const [historyPath, stashPath, cwd, count] = process.argv.slice(2);\n"
        + "const store = new PromptCacheStore(historyPath!, stashPath!, \"linux\");\n"
        + "for (let index = 0; index < Number(count); index++) store.appendHistory(cwd!, `${cwd} ${index}`);\n",
    );

    const run = (cwd: string) =>
      Bun.spawn([process.execPath, script, historyPath, stashPath, cwd, "60"], { stdout: "pipe", stderr: "pipe" });
    const [first, second] = [run("/work/alpha"), run("/work/beta")];
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);

    const history = readJson(historyPath);
    expect(history["/work/alpha"]).toEqual(Array.from({ length: 60 }, (_, index) => `/work/alpha ${index}`));
    expect(history["/work/beta"]).toEqual(Array.from({ length: 60 }, (_, index) => `/work/beta ${index}`));
  });

  test("breaks a lock left behind by a killed process", () => {
    const { historyPath, stashPath, store } = fixture();
    writeFileSync(`${historyPath}.lock`, JSON.stringify({ token: "dead", pid: 1, at: Date.now() - 60_000 }));

    const started = Date.now();
    expect(store.appendHistory("/work/stale", "after the crash")).toEqual(["after the crash"]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(`${historyPath}.lock`)).toBe(false);
  });

  test("persists when the filesystem cannot lock at all", () => {
    const { historyPath, stashPath } = fixture();
    const ops: PromptCacheFileOps = {
      exists: existsSync,
      mkdir: mkdirSync,
      read: readFileSync,
      rename: renameSync,
      copy: copyFileSync,
      remove: rmSync,
      write(path, data, options) {
        if (String(path).endsWith(".lock")) {
          throw Object.assign(new Error("locking unavailable"), { code: "EPERM" });
        }
        writeFileSync(path as string, data as string, options as never);
      },
    };
    const store = new PromptCacheStore(historyPath, stashPath, "linux", ops);

    expect(store.appendHistory("/work/nolock", "written anyway")).toEqual(["written anyway"]);
    expect(readJson(historyPath)["/work/nolock"]).toEqual(["written anyway"]);
    expect(existsSync(`${historyPath}.lock`)).toBe(false);
  });
});

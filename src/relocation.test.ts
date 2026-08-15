import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRelocationSettlementCurrent,
  loadRelocation,
  relocationFileFor,
  relocationPathsTrusted,
  relocationTargetDirectory,
  returnRelocationBlockReason,
  saveRelocation,
  startRelocationBlockReason,
  type RelocationRecord,
} from "./relocation";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-relocation-"));
  directories.push(directory);
  return join(directory, "session.jsonl");
}

function record(overrides: Partial<RelocationRecord> = {}): RelocationRecord {
  return {
    id: "reloc-1",
    generation: 1,
    sourceRoot: join("/repo"),
    worktreePath: join("/repo", ".pum", "worktrees", "jade-falcon"),
    name: "jade-falcon",
    branch: "pum/jade-falcon",
    baseBranch: "main",
    baseCommit: "abc1234",
    location: "source",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const idle = { busy: false, retainedChildren: 0, inFlight: false };

describe("the relocation companion file", () => {
  test("sits beside the session JSONL", () => {
    expect(relocationFileFor(join("sessions", "abc.jsonl")))
      .toBe(join("sessions", "abc.relocation.json"));
  });

  test("round-trips a record", () => {
    const file = sessionFile();
    saveRelocation(file, record({ location: "worktree" }));
    expect(loadRelocation(file)?.location).toBe("worktree");
  });

  test("clearing removes the file", () => {
    const file = sessionFile();
    saveRelocation(file, record());
    expect(existsSync(relocationFileFor(file))).toBe(true);
    saveRelocation(file, null);
    expect(existsSync(relocationFileFor(file))).toBe(false);
  });

  test("corrupt, missing, or partial state reads as no relocation", () => {
    const file = sessionFile();
    expect(loadRelocation(file)).toBeNull();
    writeFileSync(relocationFileFor(file), "{ not json");
    expect(loadRelocation(file)).toBeNull();
    // A record missing its branch cannot be trusted to describe a real worktree.
    const { branch: _branch, ...partial } = record();
    writeFileSync(relocationFileFor(file), JSON.stringify(partial));
    expect(loadRelocation(file)).toBeNull();
    writeFileSync(relocationFileFor(file), JSON.stringify({ ...record(), location: "elsewhere" }));
    expect(loadRelocation(file)).toBeNull();
  });

  test("no session file means no record and no write", () => {
    expect(loadRelocation(undefined)).toBeNull();
    expect(() => saveRelocation(undefined, record())).not.toThrow();
  });
});

describe("starting a move", () => {
  test("is allowed from an idle source session", () => {
    expect(startRelocationBlockReason({ ...idle, relocation: null })).toBeNull();
    expect(startRelocationBlockReason({ ...idle, relocation: record() })).toBeNull();
  });

  test("waits for the turn to finish", () => {
    expect(startRelocationBlockReason({ ...idle, relocation: null, busy: true }))
      .toContain("wait for the current turn");
  });

  test("refuses while any managed child is retained", () => {
    expect(startRelocationBlockReason({ ...idle, relocation: null, retainedChildren: 1 }))
      .toContain("1 managed agent ");
    expect(startRelocationBlockReason({ ...idle, relocation: null, retainedChildren: 3 }))
      .toContain("3 managed agents");
  });

  test("supports only one layer", () => {
    const reason = startRelocationBlockReason({
      ...idle,
      relocation: record({ location: "worktree" }),
    });
    expect(reason).toContain("already runs in worktree jade-falcon");
  });

  test("refuses a second transition while one is in flight", () => {
    expect(startRelocationBlockReason({ ...idle, relocation: null, inFlight: true }))
      .toContain("already in progress");
  });
});

describe("returning", () => {
  test("is allowed only from a worktree", () => {
    expect(returnRelocationBlockReason({ ...idle, relocation: record({ location: "worktree" }) }))
      .toBeNull();
    expect(returnRelocationBlockReason({ ...idle, relocation: record() }))
      .toContain("not running in a generated worktree");
    expect(returnRelocationBlockReason({ ...idle, relocation: null }))
      .toContain("not running in a generated worktree");
  });

  test("carries the same idle and child rules as starting", () => {
    const worktree = record({ location: "worktree" });
    expect(returnRelocationBlockReason({ ...idle, relocation: worktree, busy: true }))
      .toContain("wait for the current turn");
    expect(returnRelocationBlockReason({ ...idle, relocation: worktree, retainedChildren: 2 }))
      .toContain("2 managed agents");
    expect(returnRelocationBlockReason({ ...idle, relocation: worktree, inFlight: true }))
      .toContain("already in progress");
  });
});

describe("where the session belongs", () => {
  test("follows the recorded location", () => {
    expect(relocationTargetDirectory(record())).toBe(join("/repo"));
    expect(relocationTargetDirectory(record({ location: "worktree" })))
      .toBe(join("/repo", ".pum", "worktrees", "jade-falcon"));
  });
});

describe("stale settlements", () => {
  test("only the transition that scheduled it counts", () => {
    const pending = record({ pending: "start", pendingGeneration: 2 });
    expect(isRelocationSettlementCurrent(pending, { id: "reloc-1", generation: 2 })).toBe(true);
    // A newer transition, a different session, or none pending at all.
    expect(isRelocationSettlementCurrent(pending, { id: "reloc-1", generation: 1 })).toBe(false);
    expect(isRelocationSettlementCurrent(pending, { id: "other", generation: 2 })).toBe(false);
    expect(isRelocationSettlementCurrent(record(), { id: "reloc-1", generation: 2 })).toBe(false);
    expect(isRelocationSettlementCurrent(null, { id: "reloc-1", generation: 2 })).toBe(false);
  });
});

describe("trusting a persisted path", () => {
  const live = { worktreeExists: true, worktreeBranch: "pum/jade-falcon", sourceRoot: join("/repo") };

  test("accepts a worktree that still matches the record", () => {
    expect(relocationPathsTrusted(record(), live)).toBe(true);
  });

  test("refuses a worktree that is gone or pruned", () => {
    expect(relocationPathsTrusted(record(), { ...live, worktreeExists: false })).toBe(false);
  });

  test("refuses a path now on a different branch", () => {
    // Someone reused the directory; authorizing it would grant writes to a
    // worktree the user never generated.
    expect(relocationPathsTrusted(record(), { ...live, worktreeBranch: "main" })).toBe(false);
    expect(relocationPathsTrusted(record(), { ...live, worktreeBranch: undefined })).toBe(false);
  });

  test("refuses a source repository that no longer matches", () => {
    expect(relocationPathsTrusted(record(), { ...live, sourceRoot: join("/elsewhere") })).toBe(false);
  });

  test("refuses a worktree outside its own source repository", () => {
    const stray = record({ worktreePath: join("/elsewhere", "worktree") });
    expect(relocationPathsTrusted(stray, { ...live, worktreeBranch: "pum/jade-falcon" })).toBe(false);
  });
});

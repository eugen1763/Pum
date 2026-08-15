import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  MAX_TODOS,
  MAX_TODO_TEXT,
  TODO_STATUSES,
  addTodoTask,
  createTodoTask,
  deleteTodoTask,
  isTodoStatus,
  loadTodoTasks,
  normalizeTodoText,
  saveTodoTasks,
  sortTodoTasks,
  todoFileFor,
  updateTodoTask,
  updateTodoTasks,
  type TodoTask,
} from "./todo";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempSessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pum-todo-"));
  temporaryDirectories.push(directory);
  return join(directory, "session-id.jsonl");
}

function task(partial: Partial<TodoTask> = {}): TodoTask {
  return {
    id: "task-1",
    text: "write the parser",
    status: "pending",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...partial,
  };
}

describe("task creation", () => {
  test("trims the text and defaults to pending", () => {
    expect(createTodoTask("  write the parser  ", undefined, 42, "task-1")).toEqual({
      id: "task-1",
      text: "write the parser",
      status: "pending",
      createdAt: 42,
      updatedAt: 42,
    });
  });

  test("keeps a supplied valid status", () => {
    expect(createTodoTask("ship it", "active", 42, "task-1").status).toBe("active");
  });

  test("rejects empty, blank and overlong text", () => {
    expect(() => createTodoTask("")).toThrow("a task needs text");
    expect(() => createTodoTask("   ")).toThrow("a task needs text");
    expect(() => createTodoTask("\n\t")).toThrow("a task needs text");
    expect(() => createTodoTask("x".repeat(MAX_TODO_TEXT + 1))).toThrow(String(MAX_TODO_TEXT));
  });

  test("rejects NUL and escape, and folds a newline into one space", () => {
    expect(() => createTodoTask("bad\0text")).toThrow("control characters");
    expect(() => createTodoTask("clear\u001b[2Jthe screen")).toThrow("control characters");
    expect(normalizeTodoText("write  the\n\tparser")).toBe("write the parser");
  });

  test("accepts text at exactly the limit", () => {
    expect(normalizeTodoText("x".repeat(MAX_TODO_TEXT))).toHaveLength(MAX_TODO_TEXT);
  });

  test("rejects an unknown status", () => {
    expect(() => createTodoTask("ship it", "done")).toThrow("unknown task status");
    expect(isTodoStatus("done")).toBe(false);
    expect(TODO_STATUSES.every(isTodoStatus)).toBe(true);
  });
});

describe("canonical order", () => {
  test("orders by status, then oldest first, then id", () => {
    const tasks: TodoTask[] = [
      task({ id: "e", status: "cancelled", createdAt: 1 }),
      task({ id: "d", status: "completed", createdAt: 1 }),
      task({ id: "c", status: "blocked", createdAt: 1 }),
      task({ id: "b", status: "pending", createdAt: 1 }),
      task({ id: "a", status: "active", createdAt: 1 }),
    ];
    expect(sortTodoTasks(tasks).map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("breaks a status tie by createdAt then by id", () => {
    const tasks: TodoTask[] = [
      task({ id: "z", createdAt: 5 }),
      task({ id: "a", createdAt: 9 }),
      task({ id: "b", createdAt: 5 }),
    ];
    expect(sortTodoTasks(tasks).map((entry) => entry.id)).toEqual(["b", "z", "a"]);
  });

  test("leaves the input untouched", () => {
    const tasks: TodoTask[] = [task({ id: "b", status: "completed" }), task({ id: "a" })];
    sortTodoTasks(tasks);
    expect(tasks.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("mutation", () => {
  test("appends and rejects a duplicate id", () => {
    const one = addTodoTask([], "first", undefined, 1, "task-1");
    expect(one).toHaveLength(1);
    expect(() => addTodoTask(one, "again", undefined, 2, "task-1")).toThrow("duplicate task id");
  });

  test("updates text and status and bumps updatedAt", () => {
    const tasks = [task()];
    const next = updateTodoTask(tasks, "task-1", { status: "active" }, 99);
    expect(next[0]).toMatchObject({ status: "active", updatedAt: 99 });
    expect(tasks[0]?.status).toBe("pending");
  });

  test("leaves updatedAt alone when nothing changes", () => {
    const next = updateTodoTask([task()], "task-1", { text: "write the parser" }, 99);
    expect(next[0]?.updatedAt).toBe(1_700_000_000_000);
  });

  test("rejects an unknown id, unknown status and bad text", () => {
    expect(() => updateTodoTask([task()], "nope", { status: "active" })).toThrow("unknown task id");
    expect(() => updateTodoTask([task()], "task-1", { status: "done" })).toThrow("unknown task status");
    expect(() => updateTodoTask([task()], "task-1", { text: "" })).toThrow("a task needs text");
    expect(() => deleteTodoTask([task()], "nope")).toThrow("unknown task id");
  });

  test("deletes only the named task", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", status: "completed" })];
    expect(deleteTodoTask(tasks, "a").map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("the task cap", () => {
  function fill(count: number): TodoTask[] {
    return Array.from({ length: count }, (_unused, index) =>
      task({ id: `task-${index}`, createdAt: index }));
  }

  test("accepts the hundredth task and rejects the hundred and first", () => {
    const full = addTodoTask(fill(MAX_TODOS - 1), "last", undefined, 1, "task-last");
    expect(full).toHaveLength(MAX_TODOS);
    expect(() => addTodoTask(full, "one too many", undefined, 2, "task-extra"))
      .toThrow(`at most ${MAX_TODOS}`);
  });

  test("counts completed and cancelled tasks too", () => {
    const finished = fill(MAX_TODOS).map((entry, index) => ({
      ...entry,
      status: index % 2 === 0 ? ("completed" as const) : ("cancelled" as const),
    }));
    expect(() => addTodoTask(finished, "one more", undefined, 1, "task-extra"))
      .toThrow(`at most ${MAX_TODOS}`);
  });
});

describe("the companion file path", () => {
  test("sits beside the session with the host separator", () => {
    const sessionFile = join("some", "dir", "session-id.jsonl");
    const file = todoFileFor(sessionFile);
    expect(basename(file)).toBe("session-id.todo.json");
    expect(dirname(file)).toBe(join("some", "dir"));
  });

  test("strips a .json session suffix as well", () => {
    expect(basename(todoFileFor(join("d", "abc.json")))).toBe("abc.todo.json");
  });
});

describe("persistence", () => {
  test("round-trips a saved list", () => {
    const sessionFile = tempSessionFile();
    const tasks = [task({ id: "a" }), task({ id: "b", status: "completed" })];
    saveTodoTasks(sessionFile, tasks);
    expect(loadTodoTasks(sessionFile)).toEqual(tasks);
  });

  test("leaves no temp file behind and renames into place", () => {
    const sessionFile = tempSessionFile();
    saveTodoTasks(sessionFile, [task()]);
    const written = readdirSync(dirname(sessionFile));
    expect(written).toEqual(["session-id.todo.json"]);
  });

  test("writes nothing for an empty list with no file", () => {
    const sessionFile = tempSessionFile();
    saveTodoTasks(sessionFile, []);
    expect(existsSync(todoFileFor(sessionFile))).toBe(false);
    expect(loadTodoTasks(sessionFile)).toEqual([]);
  });

  test("clears an existing file down to an empty list", () => {
    const sessionFile = tempSessionFile();
    saveTodoTasks(sessionFile, [task()]);
    saveTodoTasks(sessionFile, []);
    expect(loadTodoTasks(sessionFile)).toEqual([]);
    expect(existsSync(todoFileFor(sessionFile))).toBe(true);
  });

  test("holds a sessionless list in memory instead of a file", () => {
    expect(loadTodoTasks(undefined)).toEqual([]);
    saveTodoTasks(undefined, [task()]);
    expect(loadTodoTasks(undefined)).toEqual([task()]);
    saveTodoTasks(undefined, []);
    expect(loadTodoTasks(undefined)).toEqual([]);
  });

  test("returns an empty list for corrupt, non-array and missing files", () => {
    const sessionFile = tempSessionFile();
    expect(loadTodoTasks(sessionFile)).toEqual([]);
    writeFileSync(todoFileFor(sessionFile), "{ not json", "utf8");
    expect(loadTodoTasks(sessionFile)).toEqual([]);
    writeFileSync(todoFileFor(sessionFile), JSON.stringify({ tasks: [] }), "utf8");
    expect(loadTodoTasks(sessionFile)).toEqual([]);
  });

  test("drops invalid entries instead of failing the whole load", () => {
    const sessionFile = tempSessionFile();
    writeFileSync(todoFileFor(sessionFile), JSON.stringify([
      task({ id: "good" }),
      null,
      "task",
      { ...task({ id: "no-status" }), status: "done" },
      { ...task({ id: "blank" }), text: "   " },
      { ...task({ id: "nul" }), text: "bad\0text" },
      { ...task({ id: "long" }), text: "x".repeat(MAX_TODO_TEXT + 1) },
      { ...task({ id: "" }) },
      { ...task({ id: "no-time" }), createdAt: "yesterday" },
      task({ id: "also-good", status: "active" }),
    ]), "utf8");
    expect(loadTodoTasks(sessionFile).map((entry) => entry.id)).toEqual(["good", "also-good"]);
  });

  test("keeps the first of two entries sharing an id", () => {
    const sessionFile = tempSessionFile();
    writeFileSync(todoFileFor(sessionFile), JSON.stringify([
      task({ id: "dupe", text: "first" }),
      task({ id: "dupe", text: "second" }),
    ]), "utf8");
    const loaded = loadTodoTasks(sessionFile);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.text).toBe("first");
  });

  test("caps an oversized file by dropping the lowest-priority tasks", () => {
    const sessionFile = tempSessionFile();
    writeFileSync(todoFileFor(sessionFile), JSON.stringify([
      ...Array.from({ length: MAX_TODOS + 19 }, (_unused, index) =>
        task({ id: `done-${index}`, status: "completed", createdAt: index })),
      task({ id: "still-running", status: "active", createdAt: 5_000 }),
    ]), "utf8");
    const loaded = loadTodoTasks(sessionFile);
    expect(loaded).toHaveLength(MAX_TODOS);
    // The active task sits last in the file and must survive the cap.
    expect(loaded.map((entry) => entry.id)).toContain("still-running");
  });

  test("keeps file order when the file fits", () => {
    const sessionFile = tempSessionFile();
    const tasks = [task({ id: "b", status: "completed" }), task({ id: "a", status: "active" })];
    saveTodoTasks(sessionFile, tasks);
    expect(loadTodoTasks(sessionFile).map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("serialized updates", () => {
  test("keeps every task when writers run in parallel", async () => {
    const sessionFile = tempSessionFile();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        updateTodoTasks(sessionFile, (tasks) =>
          addTodoTask(tasks, `task ${index}`, undefined, index, `task-${index}`))),
    );
    expect(results.at(-1)).toHaveLength(10);
    expect(loadTodoTasks(sessionFile)).toHaveLength(10);
  });

  test("holds the cap against parallel writers", async () => {
    const sessionFile = tempSessionFile();
    saveTodoTasks(sessionFile, Array.from({ length: MAX_TODOS - 1 }, (_unused, index) =>
      task({ id: `seed-${index}`, createdAt: index })));
    const settled = await Promise.allSettled(
      Array.from({ length: 3 }, (_unused, index) =>
        updateTodoTasks(sessionFile, (tasks) =>
          addTodoTask(tasks, `late ${index}`, undefined, index, `late-${index}`))),
    );
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(loadTodoTasks(sessionFile)).toHaveLength(MAX_TODOS);
  });

  test("a rejected mutation leaves the file untouched", async () => {
    const sessionFile = tempSessionFile();
    await updateTodoTasks(sessionFile, (tasks) =>
      addTodoTask(tasks, "keep me", undefined, 1, "task-1"));
    const before = readFileSync(todoFileFor(sessionFile), "utf8");
    await expect(updateTodoTasks(sessionFile, (tasks) =>
      updateTodoTask(tasks, "gone", { status: "completed" }))).rejects.toThrow("unknown task id");
    expect(readFileSync(todoFileFor(sessionFile), "utf8")).toBe(before);
  });

  test("a rejection does not poison later writers", async () => {
    const sessionFile = tempSessionFile();
    const failed = updateTodoTasks(sessionFile, () => {
      throw new Error("boom");
    });
    const added = updateTodoTasks(sessionFile, (tasks) =>
      addTodoTask(tasks, "after the failure", undefined, 1, "task-1"));
    await expect(failed).rejects.toThrow("boom");
    expect(await added).toHaveLength(1);
  });

  test("refuses to store a duplicate id a mutation invents", async () => {
    const sessionFile = tempSessionFile();
    await expect(updateTodoTasks(sessionFile, () => [task({ id: "same" }), task({ id: "same" })]))
      .rejects.toThrow("duplicate task id");
    expect(existsSync(todoFileFor(sessionFile))).toBe(false);
  });

  test("keeps a sessionless list in memory", async () => {
    try {
      expect(await updateTodoTasks(undefined, (tasks) =>
        addTodoTask(tasks, "nowhere", undefined, 1, "task-1"))).toHaveLength(1);
      expect(loadTodoTasks(undefined).map((entry) => entry.text)).toEqual(["nowhere"]);
      expect(await updateTodoTasks(undefined, (tasks) =>
        deleteTodoTask(tasks, "task-1"))).toEqual([]);
      await expect(updateTodoTasks(undefined, (tasks) =>
        deleteTodoTask(tasks, "task-1"))).rejects.toThrow("unknown task id");
    } finally {
      saveTodoTasks(undefined, []);
    }
  });

  test("reports a failed write instead of claiming success", async () => {
    const sessionFile = tempSessionFile();
    // A directory where the companion file belongs fails the rename on every
    // platform, which is the cheapest stand-in for a full or read-only disk.
    mkdirSync(todoFileFor(sessionFile));
    await expect(updateTodoTasks(sessionFile, (tasks) =>
      addTodoTask(tasks, "unwritable", undefined, 1, "task-1"))).rejects.toThrow();
    // The temp file goes with it; a failed write leaves nothing behind.
    expect(readdirSync(dirname(sessionFile))).toEqual(["session-id.todo.json"]);
  });
});

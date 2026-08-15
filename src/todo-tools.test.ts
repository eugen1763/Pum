import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TODO_TEXT, MAX_TODOS, TODO_STATUSES, todoFileFor, type TodoTask } from "./todo";
import { TODO_TOOL_NAMES, TodoToolsController } from "./todo-tools";

const directories: string[] = [];

type Tool = {
  name: string;
  description: string;
  executionMode: string;
  parameters: any;
  execute: (id: string, params: any) => Promise<{ content: { text: string }[]; details: any }>;
};

function register(controller: TodoToolsController) {
  const tools = new Map<string, Tool>();
  controller.registerTool({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  return {
    tools,
    call: (name: string, params: any = {}) => (tools.get(name) as Tool).execute("call", params),
  };
}

function fixture(audience: "main" | "subagent" = "main") {
  const directory = mkdtempSync(join(tmpdir(), "pum-todo-tools-"));
  directories.push(directory);
  const sessionFile = join(directory, "session.jsonl");
  const controller = new TodoToolsController(audience);
  controller.load(sessionFile);
  return {
    controller,
    directory,
    sessionFile,
    todoFile: todoFileFor(sessionFile),
    ...register(controller),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("todo tools", () => {
  test("registers exactly the five todo tools", () => {
    const { tools } = fixture();
    expect([...tools.keys()].sort()).toEqual([...TODO_TOOL_NAMES].sort());
  });

  test("no tool takes an owner, agent, session or path", () => {
    const { tools } = fixture();
    const expected: Record<string, { properties: string[]; required: string[] }> = {
      todo_list: { properties: ["status"], required: [] },
      todo_add: { properties: ["text", "status"], required: ["text"] },
      todo_update: { properties: ["id", "text", "status"], required: ["id"] },
      todo_complete: { properties: ["id"], required: ["id"] },
      todo_delete: { properties: ["id"], required: ["id"] },
    };
    for (const [name, shape] of Object.entries(expected)) {
      const schema = (tools.get(name) as Tool).parameters;
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual([...shape.properties].sort());
      expect([...(schema.required ?? [])].sort()).toEqual([...shape.required].sort());
      for (const key of Object.keys(schema.properties)) {
        expect(/agent|session|owner|path|file|dir/i.test(key)).toBe(false);
      }
    }
  });

  test("the schemas bound text and status", () => {
    const { tools } = fixture();
    const add = (tools.get("todo_add") as Tool).parameters;
    expect(add.properties.text.minLength).toBe(1);
    expect(add.properties.text.maxLength).toBe(MAX_TODO_TEXT);
    expect(add.properties.status.anyOf.map((option: any) => option.const)).toEqual([...TODO_STATUSES]);
  });

  test("every tool runs sequentially, which is what makes a plain read safe", () => {
    const { tools } = fixture();
    for (const tool of tools.values()) expect(tool.executionMode).toBe("sequential");
  });

  test("todo_add defaults to pending and returns the created task", async () => {
    const { call } = fixture();
    const result = await call("todo_add", { text: "  write   the parser  " });
    const task = result.details.task as TodoTask;

    expect(task.id).toBeString();
    expect(task.id.length).toBeGreaterThan(0);
    // Runs of whitespace collapse, so the popup keeps one line per task.
    expect(task.text).toBe("write the parser");
    expect(task.status).toBe("pending");
    expect(task.createdAt).toBe(task.updatedAt);
    expect(result.content[0]!.text).toContain(task.id);
  });

  test("todo_add reports the task it created, not whichever one sorts last", async () => {
    const { call } = fixture();
    await call("todo_add", { text: "sorts first", status: "active" });
    await call("todo_add", { text: "sorts last", status: "cancelled" });

    const added = await call("todo_add", { text: "the new one" });
    expect(added.details.task.text).toBe("the new one");
    const listed = (await call("todo_list")).details.tasks as TodoTask[];
    expect(listed.find((task) => task.id === added.details.task.id)?.text).toBe("the new one");
  });

  test("todo_add refuses text the state layer will not store", async () => {
    const { call, todoFile } = fixture();
    await expect(call("todo_add", { text: "x".repeat(MAX_TODO_TEXT + 1) })).rejects.toThrow(
      `a task is at most ${MAX_TODO_TEXT} characters`,
    );
    await expect(call("todo_add", { text: "repaint \u001b[2J" })).rejects.toThrow(
      "task text cannot hold control characters",
    );
    await expect(call("todo_add", { text: "   " })).rejects.toThrow("a task needs text");
    expect(existsSync(todoFile)).toBe(false);
  });

  test("todo_add takes a status and persists it", async () => {
    const { call, todoFile } = fixture();
    const added = await call("todo_add", { text: "review the diff", status: "active" });

    expect(added.details.task.status).toBe("active");
    const stored = JSON.parse(readFileSync(todoFile, "utf8")) as TodoTask[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("active");
  });

  test("todo_list reports ids, text, status and timestamps in canonical order", async () => {
    const { call } = fixture();
    await call("todo_add", { text: "pending one" });
    await call("todo_add", { text: "blocked one", status: "blocked" });
    const active = await call("todo_add", { text: "active one", status: "active" });

    const listed = await call("todo_list");
    const tasks = listed.details.tasks as TodoTask[];
    expect(tasks.map((task) => task.text)).toEqual(["active one", "pending one", "blocked one"]);
    for (const task of tasks) {
      expect(task.id).toBeString();
      expect(task.createdAt).toBeNumber();
      expect(task.updatedAt).toBeNumber();
    }
    const text = listed.content[0]!.text;
    expect(text).toContain("3 tasks:");
    expect(text).toContain(active.details.task.id);
    expect(text).toContain("[active] active one");
    expect(text).toContain(new Date(tasks[0]!.createdAt).toISOString());
  });

  test("todo_list filters by status", async () => {
    const { call } = fixture();
    await call("todo_add", { text: "one" });
    await call("todo_add", { text: "two", status: "blocked" });

    const blocked = await call("todo_list", { status: "blocked" });
    expect(blocked.details.count).toBe(1);
    expect((blocked.details.tasks as TodoTask[])[0]!.text).toBe("two");

    const cancelled = await call("todo_list", { status: "cancelled" });
    expect(cancelled.details.count).toBe(0);
    expect(cancelled.content[0]!.text).toBe("No cancelled tasks.");
  });

  test("todo_list on an empty list reads as empty and writes nothing", async () => {
    const { call, todoFile } = fixture();
    const listed = await call("todo_list");
    expect(listed.details.count).toBe(0);
    expect(listed.content[0]!.text).toBe("No tasks.");
    expect(existsSync(todoFile)).toBe(false);
  });

  test("todo_update keeps createdAt and moves updatedAt", async () => {
    const { call } = fixture();
    const added = await call("todo_add", { text: "first text" });
    const created = added.details.task as TodoTask;
    await Bun.sleep(2);

    const updated = await call("todo_update", { id: created.id, text: "second text", status: "active" });
    const task = updated.details.task as TodoTask;
    expect(task.id).toBe(created.id);
    expect(task.text).toBe("second text");
    expect(task.status).toBe("active");
    expect(task.createdAt).toBe(created.createdAt);
    expect(task.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  test("todo_update accepts text alone and status alone", async () => {
    const { call } = fixture();
    const created = (await call("todo_add", { text: "one" })).details.task as TodoTask;

    const textOnly = await call("todo_update", { id: created.id, text: "one renamed" });
    expect(textOnly.details.task.status).toBe("pending");
    expect(textOnly.details.task.text).toBe("one renamed");

    const statusOnly = await call("todo_update", { id: created.id, status: "blocked" });
    expect(statusOnly.details.task.text).toBe("one renamed");
    expect(statusOnly.details.task.status).toBe("blocked");
  });

  test("todo_update demands at least one change", async () => {
    const { call, todoFile } = fixture();
    const created = (await call("todo_add", { text: "one" })).details.task as TodoTask;
    const before = readFileSync(todoFile, "utf8");

    await expect(call("todo_update", { id: created.id })).rejects.toThrow(
      "nothing to change: pass text, status, or both",
    );
    expect(readFileSync(todoFile, "utf8")).toBe(before);
  });

  test("todo_update refuses bad text and leaves the file alone", async () => {
    const { call, todoFile } = fixture();
    const created = (await call("todo_add", { text: "one" })).details.task as TodoTask;
    const before = readFileSync(todoFile, "utf8");

    await expect(call("todo_update", { id: created.id, text: "   " })).rejects.toThrow("a task needs text");
    expect(readFileSync(todoFile, "utf8")).toBe(before);
  });

  test("todo_complete is idempotent", async () => {
    const { call } = fixture();
    const created = (await call("todo_add", { text: "ship it" })).details.task as TodoTask;

    const first = await call("todo_complete", { id: created.id });
    expect(first.details.task.status).toBe("completed");
    expect(first.details.changed).toBe(true);
    await Bun.sleep(2);

    const second = await call("todo_complete", { id: created.id });
    expect(second.details.task.status).toBe("completed");
    // A repeat is a no-op, so nothing about the task moves and it says so.
    expect(second.details.changed).toBe(false);
    expect(second.details.task.updatedAt).toBe(first.details.task.updatedAt);
    expect(second.content[0]!.text).toContain("was already completed");
    expect((await call("todo_list")).details.count).toBe(1);
  });

  test("todo_update reports a change that changes nothing as such", async () => {
    const { call } = fixture();
    const created = (await call("todo_add", { text: "same text" })).details.task as TodoTask;

    const again = await call("todo_update", { id: created.id, text: "same text" });
    expect(again.details.changed).toBe(false);
    expect(again.details.task.updatedAt).toBe(created.updatedAt);
    expect(again.content[0]!.text).toContain("nothing changed");
  });

  test("todo_delete removes a task of any status and reports its identity", async () => {
    const { call } = fixture();
    const created = (await call("todo_add", { text: "drop me" })).details.task as TodoTask;
    await call("todo_complete", { id: created.id });

    const deleted = await call("todo_delete", { id: created.id });
    expect(deleted.details.task.id).toBe(created.id);
    expect(deleted.details.task.text).toBe("drop me");
    expect(deleted.details.task.status).toBe("completed");
    expect((await call("todo_list")).details.count).toBe(0);
  });

  test("an unknown id is refused with a recovery hint and changes nothing", async () => {
    const { call, todoFile } = fixture();
    await call("todo_add", { text: "keep me" });
    const before = readFileSync(todoFile, "utf8");

    for (const name of ["todo_update", "todo_complete", "todo_delete"]) {
      const params = name === "todo_update" ? { id: "nope", status: "active" } : { id: "nope" };
      await expect(call(name, params)).rejects.toThrow(
        "unknown task id: nope. Call todo_list for the ids that still exist.",
      );
    }
    expect(readFileSync(todoFile, "utf8")).toBe(before);
  });

  test("a stale id is refused after the task is deleted", async () => {
    const { call, todoFile } = fixture();
    const created = (await call("todo_add", { text: "temporary" })).details.task as TodoTask;
    await call("todo_delete", { id: created.id });
    const before = readFileSync(todoFile, "utf8");

    await expect(call("todo_complete", { id: created.id })).rejects.toThrow("unknown task id");
    expect(readFileSync(todoFile, "utf8")).toBe(before);
  });

  test("todo_add refuses the task past the cap", async () => {
    const { call, todoFile } = fixture();
    for (let index = 0; index < MAX_TODOS; index += 1) {
      await call("todo_add", { text: `task ${index}` });
    }
    expect((await call("todo_list")).details.count).toBe(MAX_TODOS);
    const before = readFileSync(todoFile, "utf8");

    await expect(call("todo_add", { text: "one too many" })).rejects.toThrow(
      `the list holds at most ${MAX_TODOS} tasks. Complete or delete one before adding another.`,
    );
    expect(readFileSync(todoFile, "utf8")).toBe(before);

    // Room reopens the moment a task leaves.
    const first = (await call("todo_list")).details.tasks[0] as TodoTask;
    await call("todo_delete", { id: first.id });
    await call("todo_add", { text: "now it fits" });
    expect((await call("todo_list")).details.count).toBe(MAX_TODOS);
  });

  test("parallel adds all land", async () => {
    const { call } = fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => call("todo_add", { text: `parallel ${index}` })),
    );
    const listed = await call("todo_list");
    expect(listed.details.count).toBe(12);
    expect(new Set((listed.details.tasks as TodoTask[]).map((task) => task.id)).size).toBe(12);
  });

  test("two sessions keep separate lists", async () => {
    const main = fixture("main");
    const child = fixture("subagent");

    const mine = (await main.call("todo_add", { text: "main work" })).details.task as TodoTask;
    await child.call("todo_add", { text: "child work" });

    expect((await main.call("todo_list")).details.tasks.map((task: TodoTask) => task.text)).toEqual(["main work"]);
    expect((await child.call("todo_list")).details.tasks.map((task: TodoTask) => task.text)).toEqual(["child work"]);

    // A child cannot reach the main list even holding a main id.
    await expect(child.call("todo_delete", { id: mine.id })).rejects.toThrow("unknown task id");
    expect((await main.call("todo_list")).details.count).toBe(1);
  });

  test("todo_list drops a task whose timestamp no consumer could format", async () => {
    const { call, todoFile } = fixture();
    const created = (await call("todo_add", { text: "hand edited" })).details.task as TodoTask;
    writeFileSync(
      todoFile,
      JSON.stringify([
        { ...created, createdAt: 1e20, updatedAt: 1e20 },
        { ...created, id: "kept00", text: "intact" },
      ]),
      "utf8",
    );

    // A time past the Date range is corrupt, not merely odd, so it is dropped
    // like any other bad entry rather than kept to break whoever formats it.
    const listed = await call("todo_list");
    expect(listed.details.count).toBe(1);
    expect(listed.content[0]!.text).toContain("intact");
    expect(listed.content[0]!.text).not.toContain(String(1e20));

    // The surviving task still writes cleanly, which drops the bad one for good.
    await call("todo_add", { text: "after" });
    expect((await call("todo_list")).details.count).toBe(2);
  });

  test("load rebinds the controller to a session started later", async () => {
    const { controller, directory } = fixture();
    await controller.add("early task");

    const later = join(directory, "later.jsonl");
    controller.load(later);
    expect(controller.sessionFile).toBe(later);
    expect(controller.list()).toHaveLength(0);
  });

  test("a constructed session file needs no load", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pum-todo-tools-"));
    directories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const controller = new TodoToolsController("subagent", sessionFile);

    expect(controller.sessionFile).toBe(sessionFile);
    await register(controller).call("todo_add", { text: "bound at birth" });
    expect(existsSync(todoFileFor(sessionFile))).toBe(true);
  });

  test("no session file unbinds, so a reused controller never writes to the old one", async () => {
    const { controller, todoFile } = fixture();
    await controller.add("first run");

    controller.load(undefined);
    expect(controller.sessionFile).toBeUndefined();
    controller.load(null);
    expect(controller.sessionFile).toBeUndefined();
    controller.load("");
    expect(controller.sessionFile).toBeUndefined();

    const before = readFileSync(todoFile, "utf8");
    await controller.add("second run");
    expect(readFileSync(todoFile, "utf8")).toBe(before);
    // Clean up the process-wide sessionless list this test just wrote to.
    for (const task of controller.list()) await controller.delete(task.id);
  });

  test("a child with no session file gets no list rather than the main one", async () => {
    const main = new TodoToolsController("main");
    const child = new TodoToolsController("subagent");
    const message = "this agent has no todo list";

    const mine = await main.add("main only");
    try {
      expect(main.list().some((task) => task.id === mine.id)).toBe(true);
      expect(() => child.list()).toThrow(message);
      await expect(child.add("child task")).rejects.toThrow(message);
      await expect(child.complete(mine.id)).rejects.toThrow(message);
      await expect(child.update(mine.id, { status: "cancelled" })).rejects.toThrow(message);
      await expect(child.delete(mine.id)).rejects.toThrow(message);
    } finally {
      await main.delete(mine.id);
    }
  });

  test("the extension name carries the audience", () => {
    expect(new TodoToolsController("main").extension().name).toBe("pum-todo-tools-main");
    expect(new TodoToolsController("subagent").extension().name).toBe("pum-todo-tools-subagent");
  });
});

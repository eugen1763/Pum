import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  addTodoTask,
  deleteTodoTask,
  loadTodoTasks,
  MAX_TODO_TEXT,
  MAX_TODOS,
  sortTodoTasks,
  TODO_STATUSES,
  type TodoStatus,
  type TodoTask,
  updateTodoTask,
  updateTodoTasks,
} from "./todo";

/**
 * The five model tools over one agent's todo list.
 *
 * The controller is bound to the session it serves, so ownership never comes
 * from tool input: the main agent reaches the main list and a child reaches
 * its own, whatever the model asks for. No parameter names an agent, a
 * session, or a file, which leaves nothing for a model to point elsewhere.
 */

export const TODO_TOOL_NAMES = [
  "todo_list",
  "todo_add",
  "todo_update",
  "todo_complete",
  "todo_delete",
] as const;

export type TodoToolName = (typeof TODO_TOOL_NAMES)[number];

export type TodoAudience = "main" | "subagent";

/** A mutation and whether it moved anything. A repeat is success, not change. */
export type TodoChange = { task: TodoTask; changed: boolean };

const StatusSchema = Type.Union(TODO_STATUSES.map((status) => Type.Literal(status)), {
  description: `Task status, one of: ${TODO_STATUSES.join(", ")}`,
});

const TextSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TODO_TEXT,
  description: `Task text, at most ${MAX_TODO_TEXT} characters`,
});

const IdSchema = Type.String({
  minLength: 1,
  description: "Stable task id, exactly as todo_list reports it",
});

/** Widest instant a Date holds. Beyond it toISOString throws a RangeError. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * A hand-edited file can carry a finite but absurd timestamp, which the state
 * layer keeps. Printing it raw beats throwing: an agent that cannot list its
 * tasks cannot find the id that would delete the bad one.
 */
function isoTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) return String(epochMs);
  return new Date(epochMs).toISOString();
}

function taskLine(task: TodoTask): string {
  return `${task.id} [${task.status}] ${task.text}`
    + ` (created ${isoTime(task.createdAt)}, updated ${isoTime(task.updatedAt)})`;
}

function listText(tasks: readonly TodoTask[], status?: TodoStatus): string {
  if (tasks.length === 0) return status ? `No ${status} tasks.` : "No tasks.";
  const label = `${tasks.length} ${status ? `${status} ` : ""}task${tasks.length === 1 ? "" : "s"}`;
  return [`${label}:`, ...tasks.map(taskLine)].join("\n");
}

/** Structured mirror of the text, so a UI never reparses the rendered lines. */
function taskDetails(task: TodoTask) {
  return {
    id: task.id,
    text: task.text,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * The state layer says what went wrong; only the tool layer knows which call
 * recovers it. A stale id and a full list are the two errors a model can fix
 * on its own, so both leave with the next move attached.
 */
function withHint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("unknown task id")) {
    throw new Error(`${message}. Call todo_list for the ids that still exist.`, { cause: error });
  }
  if (message.startsWith("the list holds at most")) {
    throw new Error(
      `${message}. Complete or delete one before adding another.`,
      { cause: error },
    );
  }
  throw error;
}

export class TodoToolsController {
  readonly audience: TodoAudience;
  private file: string | undefined;

  constructor(audience: TodoAudience = "main", sessionFile?: string | null) {
    this.file = sessionFile || undefined;
    this.audience = audience;
  }

  /** The session file currently bound, if any. */
  get sessionFile(): string | undefined {
    return this.file;
  }

  /**
   * Bind the session file. A session names its file only once it starts, so
   * the controller is built first and pointed at the list afterwards. No name
   * unbinds: a controller reused for a fresh run must not keep writing to the
   * list of the session it served before.
   */
  load(sessionFile?: string | null): void {
    this.file = sessionFile || undefined;
  }

  /**
   * The file this agent's list lives in.
   *
   * A run with no session file keeps its list in memory, and every unbound
   * writer in the process shares that one list. The main agent is the only
   * one of its kind, so it can own it; a child with no file of its own would
   * be reading the main agent's tasks, and gets no list at all instead.
   */
  private bound(): string | undefined {
    if (this.file === undefined && this.audience !== "main") {
      throw new Error("this agent has no todo list: its session started without a file to keep one in");
    }
    return this.file;
  }

  /** This agent's tasks in canonical order, optionally one status only. */
  list(status?: TodoStatus): TodoTask[] {
    // A plain read is enough: a write lands whole through a rename, and the
    // tools run one at a time, so there is no half-written list to catch.
    const tasks = sortTodoTasks(loadTodoTasks(this.bound()));
    return status ? tasks.filter((task) => task.status === status) : tasks;
  }

  async add(text: string, status?: TodoStatus): Promise<TodoTask> {
    let created: TodoTask | undefined;
    await updateTodoTasks(this.bound(), (tasks) => {
      // By id, not by position: where the new task lands is not this layer's
      // business, and reporting the wrong one would be silent.
      const before = new Set(tasks.map((task) => task.id));
      const next = addTodoTask(tasks, text, status);
      created = next.find((task) => !before.has(task.id));
      return next;
    }).catch(withHint);
    return created as TodoTask;
  }

  async update(id: string, changes: { text?: string; status?: TodoStatus }): Promise<TodoChange> {
    if (changes.text === undefined && changes.status === undefined) {
      throw new Error("nothing to change: pass text, status, or both");
    }
    return this.apply(id, changes);
  }

  /** Completing a completed task is a no-op, not an error. */
  async complete(id: string): Promise<TodoChange> {
    return this.apply(id, { status: "completed" });
  }

  async delete(id: string): Promise<TodoTask> {
    let deleted: TodoTask | undefined;
    await updateTodoTasks(this.bound(), (tasks) => {
      deleted = tasks.find((task) => task.id === id);
      return deleteTodoTask(tasks, id);
    }).catch(withHint);
    return deleted as TodoTask;
  }

  private async apply(
    id: string,
    changes: { text?: string; status?: TodoStatus },
  ): Promise<TodoChange> {
    let before: TodoTask | undefined;
    const tasks = await updateTodoTasks(this.bound(), (current) => {
      before = current.find((task) => task.id === id);
      return updateTodoTask(current, id, changes);
    }).catch(withHint);
    // The mutation returned, so the id is there.
    const task = tasks.find((candidate) => candidate.id === id) as TodoTask;
    // Comparing the fields, not updatedAt: two changes in one millisecond
    // share a timestamp and the second would read as a no-op.
    const changed = !before || before.text !== task.text || before.status !== task.status;
    return { task, changed };
  }

  registerTool(pi: Pick<ExtensionAPI, "registerTool">): void {
    const controller = this;

    pi.registerTool({
      name: "todo_list",
      label: "Todo List",
      description: "List this agent's tasks in priority order, optionally one status only.",
      promptSnippet: "List the current tasks with their stable ids",
      promptGuidelines: [
        "Call todo_list before todo_update, todo_complete or todo_delete to get current ids.",
        "The list belongs to the calling agent. There is no way to read another agent's tasks.",
      ],
      parameters: Type.Object({
        status: Type.Optional(StatusSchema),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const tasks = controller.list(params.status);
        return {
          content: [{ type: "text" as const, text: listText(tasks, params.status) }],
          details: {
            action: "list",
            count: tasks.length,
            status: params.status,
            tasks: tasks.map(taskDetails),
          },
        };
      },
    });

    pi.registerTool({
      name: "todo_add",
      label: "Todo Add",
      description:
        `Add one task to this agent's list. Status defaults to pending. The list holds at most ${MAX_TODOS} tasks.`,
      promptSnippet: "Add one task to the current agent's list",
      promptGuidelines: [
        "Write one concrete task per call. Do not pack several steps into one text.",
        "Do not put agent, session or file names in the input. PUM binds the calling agent's list.",
      ],
      parameters: Type.Object({
        text: TextSchema,
        status: Type.Optional(StatusSchema),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const task = await controller.add(params.text, params.status);
        return {
          content: [{ type: "text" as const, text: `Added task ${task.id}.\n${taskLine(task)}` }],
          details: { action: "add", count: 1, task: taskDetails(task) },
        };
      },
    });

    pi.registerTool({
      name: "todo_update",
      label: "Todo Update",
      description: "Change the text, the status, or both of one task. At least one of them is required.",
      promptSnippet: "Change the text or status of one task",
      promptGuidelines: [
        "Set status to active when work starts and to blocked when it stops, so the list stays honest.",
        "Use todo_complete rather than todo_update to finish a task.",
      ],
      parameters: Type.Object({
        id: IdSchema,
        text: Type.Optional(TextSchema),
        status: Type.Optional(StatusSchema),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const { task, changed } = await controller.update(params.id, {
          text: params.text,
          status: params.status,
        });
        const headline = changed
          ? `Updated task ${task.id}.`
          : `Task ${task.id} already read that way; nothing changed.`;
        return {
          content: [{ type: "text" as const, text: `${headline}\n${taskLine(task)}` }],
          details: { action: "update", count: 1, changed, task: taskDetails(task) },
        };
      },
    });

    pi.registerTool({
      name: "todo_complete",
      label: "Todo Complete",
      description: "Mark one task completed. Completing an already completed task changes nothing and still succeeds.",
      promptSnippet: "Mark one task completed",
      promptGuidelines: [
        "Complete a task as soon as its work is done, not in a batch at the end.",
      ],
      parameters: Type.Object({ id: IdSchema }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const { task, changed } = await controller.complete(params.id);
        const headline = changed
          ? `Completed task ${task.id}.`
          : `Task ${task.id} was already completed.`;
        return {
          content: [{ type: "text" as const, text: `${headline}\n${taskLine(task)}` }],
          details: { action: "complete", count: 1, changed, task: taskDetails(task) },
        };
      },
    });

    pi.registerTool({
      name: "todo_delete",
      label: "Todo Delete",
      description: "Remove one task from this agent's list, whatever its status.",
      promptSnippet: "Remove one task from the current agent's list",
      promptGuidelines: [
        "Delete a task that turned out to be wrong or duplicated. Completed work is worth keeping.",
      ],
      parameters: Type.Object({ id: IdSchema }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const task = await controller.delete(params.id);
        return {
          content: [{ type: "text" as const, text: `Deleted task ${task.id}.\n${taskLine(task)}` }],
          details: { action: "delete", count: 1, task: taskDetails(task) },
        };
      },
    });
  }

  /** The inline extension that registers the todo tools for one session. */
  extension(): InlineExtension {
    return {
      name: `pum-todo-tools-${this.audience}`,
      factory: (pi) => this.registerTool(pi),
    };
  }
}

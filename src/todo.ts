import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Per-agent todo lists.
 *
 * A pure state layer: validation, canonical ordering, and a companion file
 * beside the session JSONL. Tools and the popup build on this and own no
 * state of their own, so every writer shares one cap and one order.
 */

export type TodoStatus = "pending" | "active" | "blocked" | "completed" | "cancelled";

/**
 * Canonical status order. Sorting and the status guard both read this array,
 * so a new status can only ever be added in one place.
 */
export const TODO_STATUSES: readonly TodoStatus[] = [
  "active",
  "pending",
  "blocked",
  "completed",
  "cancelled",
];

/** Longest task text PUM stores. Longer input is refused, never truncated. */
export const MAX_TODO_TEXT = 500;

/** The list never holds more than this many tasks, whatever their status. */
export const MAX_TODOS = 100;

export type TodoTask = {
  /** Stable opaque identifier. */
  id: string;
  /** Non-empty task text, at most MAX_TODO_TEXT characters. */
  text: string;
  status: TodoStatus;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds of the last accepted change. */
  updatedAt: number;
};

export function isTodoStatus(value: unknown): value is TodoStatus {
  return TODO_STATUSES.includes(value as TodoStatus);
}

/** Companion file next to the session JSONL: <session>.todo.json */
export function todoFileFor(sessionFile: string): string {
  const base = basename(sessionFile).replace(/\.jsonl?$/, "");
  return join(dirname(sessionFile), `${base}.todo.json`);
}

/**
 * NUL truncates the text in C string APIs, and ESC lets task text repaint the
 * terminal the popup draws it into. Tab, newline and return collapse to a
 * space before this runs, so only the harmful controls reach it.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** Flatten and check task text. Throws with the reason the caller should show. */
export function normalizeTodoText(value: unknown): string {
  if (typeof value !== "string") throw new Error("a task needs text");
  // A task is one line in the popup, so runs of whitespace become one space.
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("a task needs text");
  if (CONTROL_CHARACTERS.test(text)) {
    throw new Error("task text cannot hold control characters");
  }
  if (text.length > MAX_TODO_TEXT) {
    throw new Error(`a task is at most ${MAX_TODO_TEXT} characters`);
  }
  return text;
}

function normalizeStatus(value: unknown): TodoStatus {
  if (value === undefined) return "pending";
  if (!isTodoStatus(value)) throw new Error(`unknown task status: ${String(value)}`);
  return value;
}

export function createTodoTask(
  text: string,
  status?: unknown,
  now = Date.now(),
  id = randomUUID().slice(0, 12),
): TodoTask {
  return {
    id,
    text: normalizeTodoText(text),
    status: normalizeStatus(status),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Canonical order: status, then oldest first, then id so two tasks written in
 * the same millisecond never swap places between renders.
 */
export function sortTodoTasks(tasks: readonly TodoTask[]): TodoTask[] {
  return [...tasks].sort((left, right) => {
    const byStatus = TODO_STATUSES.indexOf(left.status) - TODO_STATUSES.indexOf(right.status);
    if (byStatus !== 0) return byStatus;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Append a task. Throws when the text is bad or the list is full. */
export function addTodoTask(
  tasks: readonly TodoTask[],
  text: string,
  status?: unknown,
  now = Date.now(),
  id = randomUUID().slice(0, 12),
): TodoTask[] {
  const task = createTodoTask(text, status, now, id);
  if (tasks.length >= MAX_TODOS) throw new Error(`the list holds at most ${MAX_TODOS} tasks`);
  if (tasks.some((existing) => existing.id === task.id)) {
    throw new Error(`duplicate task id: ${task.id}`);
  }
  return [...tasks, task];
}

/** Change text, status, or both. Throws on an unknown id or bad input. */
export function updateTodoTask(
  tasks: readonly TodoTask[],
  id: string,
  changes: { text?: string; status?: unknown },
  now = Date.now(),
): TodoTask[] {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`unknown task id: ${id}`);
  const current = tasks[index] as TodoTask;
  const text = changes.text === undefined ? current.text : normalizeTodoText(changes.text);
  const status = changes.status === undefined ? current.status : normalizeStatus(changes.status);
  // A no-op must not bump updatedAt, or reordering by time would drift.
  if (text === current.text && status === current.status) return [...tasks];
  const next = [...tasks];
  next[index] = { ...current, text, status, updatedAt: now };
  return next;
}

/** Drop a task. Completed and cancelled ones only leave this way. */
export function deleteTodoTask(tasks: readonly TodoTask[], id: string): TodoTask[] {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new Error(`unknown task id: ${id}`);
  return tasks.filter((_, at) => at !== index);
}

function isTodoTask(value: unknown): value is TodoTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" && task.id.length > 0 && !CONTROL_CHARACTERS.test(task.id) &&
    typeof task.text === "string" &&
    task.text.trim().length > 0 &&
    task.text.length <= MAX_TODO_TEXT &&
    !CONTROL_CHARACTERS.test(task.text) &&
    isTodoStatus(task.status) &&
    typeof task.createdAt === "number" && Number.isFinite(task.createdAt) &&
    typeof task.updatedAt === "number" && Number.isFinite(task.updatedAt)
  );
}

/**
 * A run with no session file still needs a working list, so it keeps one in
 * memory. It dies with the process; there is nothing to persist.
 */
let sessionlessTasks: readonly TodoTask[] = [];

/**
 * Load the persisted list for a session. Never throws: a missing, unreadable
 * or corrupt file reads as an empty list, and single bad entries are dropped.
 */
export function loadTodoTasks(sessionFile: string | undefined): TodoTask[] {
  if (!sessionFile) return [...sessionlessTasks];
  try {
    const file = todoFileFor(sessionFile);
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const tasks: TodoTask[] = [];
    for (const entry of parsed) {
      if (!isTodoTask(entry)) continue;
      // A file edited by hand can repeat an id; the first one wins so every
      // later lookup by id stays unambiguous.
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      tasks.push({
        id: entry.id,
        text: entry.text,
        status: entry.status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    // File order is arbitrary, so an oversized file drops its lowest-priority
    // tasks rather than whatever happens to sit past the hundredth line.
    return tasks.length > MAX_TODOS ? sortTodoTasks(tasks).slice(0, MAX_TODOS) : tasks;
  } catch {
    return [];
  }
}

/** Write the list atomically. Throws so a caller in a transaction can react. */
function writeTodoTasks(sessionFile: string | undefined, tasks: readonly TodoTask[]): void {
  if (!sessionFile) {
    sessionlessTasks = [...tasks];
    return;
  }
  const file = todoFileFor(sessionFile);
  // An empty list with no companion file is nothing to record. Writing it
  // would leave a two-byte "[]" beside every session ever opened.
  if (tasks.length === 0 && !existsSync(file)) return;
  // The temp name carries pid and time so two PUM processes on one session
  // cannot clobber each other's half-written file before the rename.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(tasks.slice(0, MAX_TODOS), null, 2), "utf8");
    renameSync(temporary, file);
  } catch (error) {
    // The name is never reused, so a leftover temp file would sit there forever.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing more to try; the write already failed.
    }
    throw error;
  }
}

/** Persist the list atomically next to the session. Best effort only. */
export function saveTodoTasks(
  sessionFile: string | undefined,
  tasks: readonly TodoTask[],
): void {
  try {
    writeTodoTasks(sessionFile, tasks);
  } catch {
    // A failed todo write never breaks the session.
  }
}

function assertStorable(tasks: readonly TodoTask[]): void {
  if (tasks.length > MAX_TODOS) throw new Error(`the list holds at most ${MAX_TODOS} tasks`);
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!isTodoTask(task)) throw new Error("the list holds an invalid task");
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
}

/** One promise chain per companion file, so writers queue instead of racing. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Serialized read-modify-write. Every mutation reads the file again inside the
 * chain, so two parallel tool calls cannot each save a stale list and lose the
 * other's task or push the total past the cap. A mutation that throws leaves
 * the file exactly as it was, and so does a failed write.
 *
 * The chain covers this process only. Two PUM processes on one session file
 * still race, exactly as they already do for the goal and news companions.
 */
export function updateTodoTasks(
  sessionFile: string | undefined,
  mutate: (tasks: TodoTask[]) => readonly TodoTask[],
): Promise<TodoTask[]> {
  // Sessionless runs share one key, which is also their one in-memory list.
  const key = sessionFile ? todoFileFor(sessionFile) : "";
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(() => {
    const tasks = mutate(loadTodoTasks(sessionFile));
    assertStorable(tasks);
    const stored = [...tasks];
    // Not saveTodoTasks: a caller that just added a task must hear about a
    // failed write, or it reports success over a list that never landed.
    writeTodoTasks(sessionFile, stored);
    return stored;
  });
  // A rejection must not poison the chain, and the key goes once it drains.
  const drained: Promise<void> = result.then(() => {}, () => {}).then(() => {
    if (chains.get(key) === drained) chains.delete(key);
  });
  chains.set(key, drained);
  return result;
}

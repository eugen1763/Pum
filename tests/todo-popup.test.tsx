import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import {
  cycleTodoFilter,
  moveTodoSelection,
  TODO_FILTERS,
  todoEmptyLines,
  todoFooterText,
  todoPopupLayout,
  TodoPopup,
  todoStatusSummary,
  visibleTodoTasks,
  type TodoFilter,
} from "../src/todo-popup";
import { createTodoTask, type TodoStatus, type TodoTask } from "../src/todo";
import { loadTheme } from "../src/theme";

const NOW = 1_700_000_000_000;

function task(id: string, text: string, status: TodoStatus, minutesOld = 0): TodoTask {
  const at = NOW - minutesOld * 60_000;
  return { ...createTodoTask(text, status, at, id), updatedAt: at };
}

const TASKS: TodoTask[] = [
  task("aaa111", "Write the parser", "pending", 30),
  task("bbb222", "Ship the release", "active", 90),
  task("ccc333", "Wait on review", "blocked", 20),
  task("ddd444", "Delete dead code", "completed", 10),
  task("eee555", "Drop the old flag", "cancelled", 5),
  task("fff666", "Write the printer", "pending", 15),
];

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function renderTodo(options: {
  width: number;
  height: number;
  tasks?: readonly TodoTask[];
  filter?: TodoFilter;
  selectedId?: string | null;
  agentName?: string;
}) {
  const { width, height } = options;
  const setup = await createTestRenderer({ width, height });
  destroy = () => setup.renderer.destroy();
  createRoot(setup.renderer).render(
    <box style={{ width, height }}>
      <TodoPopup
        theme={loadTheme("tokyonight")}
        terminalWidth={width}
        terminalHeight={height}
        agentName={options.agentName ?? "Nomad"}
        tasks={options.tasks ?? TASKS}
        filter={options.filter ?? "all"}
        selectedId={options.selectedId === undefined ? "bbb222" : options.selectedId}
        now={NOW}
      />
    </box>,
  );
  await setup.renderOnce();
  await setup.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  await setup.flush();
  return setup.captureCharFrame();
}

describe("todo ordering and filtering", () => {
  test("orders by canonical status, then age, then id", () => {
    const order = visibleTodoTasks(TASKS, "all").map((entry) => entry.id);
    expect(order).toEqual(["bbb222", "aaa111", "fff666", "ccc333", "ddd444", "eee555"]);
  });

  test("each filter keeps only its own status", () => {
    for (const filter of TODO_FILTERS) {
      const visible = visibleTodoTasks(TASKS, filter);
      if (filter === "all") {
        expect(visible).toHaveLength(TASKS.length);
        continue;
      }
      expect(visible).toHaveLength(TASKS.filter((entry) => entry.status === filter).length);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((entry) => entry.status === filter)).toBe(true);
    }
  });

  test("the filter cycle wraps through every status", () => {
    let filter: TodoFilter = "all";
    const seen: TodoFilter[] = [filter];
    for (let step = 0; step < TODO_FILTERS.length - 1; step += 1) {
      filter = cycleTodoFilter(filter);
      seen.push(filter);
    }
    expect(seen).toEqual([...TODO_FILTERS]);
    expect(cycleTodoFilter(filter)).toBe("all");
  });

  test("summarizes the counts it holds", () => {
    expect(todoStatusSummary(TASKS)).toBe(
      "1 active · 2 pending · 1 blocked · 1 completed · 1 cancelled",
    );
    expect(todoStatusSummary([])).toBe("no tasks");
  });
});

describe("todo selection", () => {
  const visible = visibleTodoTasks(TASKS, "all");

  test("steps forward and back", () => {
    expect(moveTodoSelection(visible, "bbb222", 1)).toBe("aaa111");
    expect(moveTodoSelection(visible, "aaa111", -1)).toBe("bbb222");
  });

  test("wraps at both ends", () => {
    expect(moveTodoSelection(visible, "eee555", 1)).toBe("bbb222");
    expect(moveTodoSelection(visible, "bbb222", -1)).toBe("eee555");
  });

  test("a lost selection lands on the near end", () => {
    expect(moveTodoSelection(visible, null, 1)).toBe("bbb222");
    expect(moveTodoSelection(visible, "gone", -1)).toBe("eee555");
  });

  test("an empty list has nothing to select", () => {
    expect(moveTodoSelection([], null, 1)).toBeNull();
    expect(moveTodoSelection([], "bbb222", -1)).toBeNull();
  });
});

describe("todo layout", () => {
  test("keeps the footer and a task row on a short terminal", () => {
    for (const height of [8, 10, 14, 24]) {
      const layout = todoPopupLayout(80, height);
      expect(layout.footerHeight).toBe(1);
      expect(layout.listHeight).toBeGreaterThanOrEqual(1);
      const rows = layout.listHeight + layout.separatorHeight +
        layout.summaryHeight + layout.footerHeight;
      expect(rows).toBe(layout.popupHeight - 4);
    }
  });

  test("drops the separator before the summary as height shrinks", () => {
    const tall = todoPopupLayout(80, 40);
    expect(tall.separatorHeight).toBe(1);
    expect(tall.summaryHeight).toBe(1);
    const short = todoPopupLayout(80, 9);
    expect(short.separatorHeight).toBe(0);
  });

  test("never covers the terminal row the shadow needs", () => {
    for (const height of [3, 6, 12, 30, 60]) {
      const layout = todoPopupLayout(80, height);
      expect(layout.top + layout.popupHeight).toBeLessThan(height);
    }
  });

  test("row columns always sum to the content width", () => {
    for (let width = 4; width <= 200; width += 1) {
      const layout = todoPopupLayout(width, 24);
      const columns = layout.markerWidth + layout.glyphWidth + layout.textWidth +
        layout.idWidth + layout.ageWidth;
      expect(columns).toBeLessThanOrEqual(Math.max(layout.contentWidth, 1));
      expect(layout.margin * 2 + layout.popupWidth).toBeLessThanOrEqual(width);
    }
  });

  test("the footer fits and keeps the close hint at every width", () => {
    for (let width = 30; width <= 200; width += 1) {
      for (const filter of TODO_FILTERS) {
        const layout = todoPopupLayout(width, 24);
        const footer = todoFooterText(layout, filter, 2, 6);
        expect(Bun.stringWidth(footer)).toBeLessThanOrEqual(layout.contentWidth);
        expect(footer).toContain("esc");
        expect(footer).toContain("2/6");
      }
    }
  });
});

describe("todo popup rendering", () => {
  test("shows the agent, the tasks, their ids and ages", async () => {
    const frame = await renderTodo({ width: 80, height: 24 });
    expect(frame).toContain("Nomad");
    expect(frame).toContain("Ship the release");
    expect(frame).toContain("Write the parser");
    expect(frame).toContain("bbb222");
    expect(frame).toContain("1h ago");
    expect(frame).toContain("filter all");
    expect(frame).toContain("1/6");
  });

  test("two tasks with similar text stay apart by id", async () => {
    const frame = await renderTodo({ width: 80, height: 24, filter: "pending" });
    expect(frame).toContain("Write the parser");
    expect(frame).toContain("Write the printer");
    expect(frame).toContain("aaa111");
    expect(frame).toContain("fff666");
  });

  test("a filter narrows the list and the footer total", async () => {
    const frame = await renderTodo({
      width: 80,
      height: 24,
      filter: "completed",
      selectedId: "ddd444",
    });
    expect(frame).toContain("Delete dead code");
    expect(frame).not.toContain("Ship the release");
    expect(frame).toContain("filter completed");
    expect(frame).toContain("1/1");
  });

  test("the empty state points at enable_tools and Todo", async () => {
    const frame = await renderTodo({
      width: 80,
      height: 24,
      tasks: [],
      selectedId: null,
      agentName: "Vega",
    });
    expect(frame).toContain("Vega has no tasks yet");
    // The whole instruction, not just the word Todo in the popup title.
    expect(frame).toContain("Vega can call enable_tools with Todo, then todo_add.");
    expect(frame).toContain("read-only");
  });

  test("an empty filter says how to change it", async () => {
    const frame = await renderTodo({
      width: 80,
      height: 24,
      tasks: [TASKS[0] as TodoTask],
      filter: "blocked",
      selectedId: null,
    });
    expect(frame).toContain("No blocked tasks");
    expect(frame).toContain("change the filter");
  });

  test("long text truncates with an ellipsis, never a split grapheme", async () => {
    const long = task("ggg777", `${"👨‍👩‍👧‍👦".repeat(40)} tail`, "active");
    const frame = await renderTodo({
      width: 80,
      height: 24,
      tasks: [long],
      selectedId: "ggg777",
    });
    expect(frame).toContain("…");
    expect(frame).not.toContain("tail");
    for (const line of frame.split("\n")) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("a narrow terminal keeps the footer and stays inside the width", async () => {
    const frame = await renderTodo({ width: 34, height: 12 });
    const lines = frame.split("\n");
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(34);
    expect(frame).toContain("esc");
    expect(frame).toContain("1/6");
  });

  test("a short terminal still paints a row and the footer", async () => {
    const frame = await renderTodo({ width: 80, height: 9 });
    expect(frame).toContain("Ship the release");
    expect(frame).toContain("esc close");
    expect(frame.split("\n").length).toBeLessThanOrEqual(10);
  });

  test("the visible window follows the selection down the list", async () => {
    const frame = await renderTodo({ width: 80, height: 10, selectedId: "eee555" });
    expect(frame).toContain("Drop the old flag");
    expect(frame).not.toContain("Ship the release");
  });

  test("a mid-list selection still shows the rows after it", async () => {
    const frame = await renderTodo({ width: 80, height: 12, selectedId: "ccc333" });
    expect(frame).toContain("Wait on review");
    // Anchoring the selection to the last visible row would hide these.
    expect(frame).toContain("Delete dead code");
  });

  test("the empty-state lines never spill past the list", () => {
    const layout = todoPopupLayout(80, 9);
    const lines = todoEmptyLines("Vega", "all", false);
    expect(lines.length).toBeGreaterThan(layout.listHeight);
  });
});

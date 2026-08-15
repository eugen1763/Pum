import type { Theme } from "./theme";
import { PopupFrame } from "./popup-frame";
import { sortTodoTasks, TODO_STATUSES, type TodoStatus, type TodoTask } from "./todo";
import { statusTextWidth, truncateStatusText } from "./status-metadata";
import { formatAge } from "./news";

/**
 * The view-only todo popup.
 *
 * It owns layout and nothing else. Every key that drives it belongs to the
 * single useKeyboard in app.tsx, and only the Todo tools ever change a task.
 */

export type TodoFilter = "all" | TodoStatus;

/**
 * Cycle order for the `f` key: "all" first so a fresh popup shows everything,
 * then the canonical status order, so a new status joins the cycle by itself.
 */
export const TODO_FILTERS: readonly TodoFilter[] = ["all", ...TODO_STATUSES];

export function cycleTodoFilter(current: TodoFilter): TodoFilter {
  const at = TODO_FILTERS.indexOf(current);
  return TODO_FILTERS[(at + 1) % TODO_FILTERS.length]!;
}

/**
 * The rows the popup paints, in canonical order. app.tsx moves the selection
 * over this same list, so the key handler and the paint can never disagree.
 */
export function visibleTodoTasks(
  tasks: readonly TodoTask[],
  filter: TodoFilter,
): TodoTask[] {
  const matching = filter === "all" ? tasks : tasks.filter((task) => task.status === filter);
  return sortTodoTasks(matching);
}

/** Wrapping move over the visible rows. Null when there is nothing to select. */
export function moveTodoSelection(
  tasks: readonly TodoTask[],
  selectedId: string | null,
  step: -1 | 1,
): string | null {
  if (tasks.length === 0) return null;
  const current = tasks.findIndex((task) => task.id === selectedId);
  // A lost selection lands on the first row going down, the last going up.
  const start = current < 0 ? (step > 0 ? -1 : 0) : current;
  return tasks[(start + step + tasks.length) % tasks.length]!.id;
}

export type TodoPopupLayout = {
  narrow: boolean;
  margin: number;
  popupWidth: number;
  popupHeight: number;
  top: number;
  /** Columns inside the border and padding. Every row column sums to this. */
  contentWidth: number;
  markerWidth: number;
  glyphWidth: number;
  idWidth: number;
  ageWidth: number;
  textWidth: number;
  summaryHeight: number;
  separatorHeight: number;
  listHeight: number;
  footerHeight: number;
};

const TODO_POPUP_FRAME_ROWS = 4;
const TODO_POPUP_MIN_HEIGHT = 8;
const TODO_POPUP_MAX_HEIGHT = 28;
const TODO_POPUP_HEIGHT_RATIO = 0.8;

/** Short id shown beside the text so two similar tasks stay distinguishable. */
const TODO_ID_LENGTH = 7;

export function todoPopupLayout(terminalWidth: number, terminalHeight: number): TodoPopupLayout {
  const narrow = terminalWidth < 64;
  const margin = terminalWidth < 4 ? 0 : narrow ? 1 : Math.max(2, Math.floor(terminalWidth * 0.1));
  const popupWidth = Math.max(1, terminalWidth - margin * 2);
  const scaledHeight = Math.floor(terminalHeight * TODO_POPUP_HEIGHT_RATIO);
  const desiredHeight = Math.max(
    TODO_POPUP_MIN_HEIGHT,
    Math.min(TODO_POPUP_MAX_HEIGHT, scaledHeight),
  );
  // Reserve the final terminal row for PopupFrame's bottom shadow.
  const availableHeight = Math.max(1, terminalHeight - (terminalHeight > 1 ? 1 : 0));
  const popupHeight = Math.min(availableHeight, desiredHeight);
  const top = Math.max(0, Math.floor((terminalHeight - popupHeight) / 2));
  const innerHeight = Math.max(0, popupHeight - TODO_POPUP_FRAME_ROWS);

  const footerHeight = innerHeight >= 2 ? 1 : 0;
  const minimumListHeight = innerHeight >= 1 ? 1 : 0;
  const optionalRows = Math.max(0, innerHeight - footerHeight - minimumListHeight);
  const summaryHeight = optionalRows >= 2 ? 1 : 0;
  const separatorHeight = optionalRows >= 3 ? 1 : 0;
  const listHeight = Math.max(
    0,
    innerHeight - footerHeight - summaryHeight - separatorHeight,
  );

  // Border and padding take one column on each side.
  const contentWidth = Math.max(1, popupWidth - 4);
  const markerWidth = contentWidth >= 12 ? 2 : 0;
  const glyphWidth = contentWidth >= 4 ? 2 : 0;
  const idWidth = contentWidth >= 32 ? TODO_ID_LENGTH + 1 : 0;
  const ageWidth = contentWidth >= 44 ? 9 : 0;
  const textWidth = Math.max(
    1,
    contentWidth - markerWidth - glyphWidth - idWidth - ageWidth,
  );

  return {
    narrow,
    margin,
    popupWidth,
    popupHeight,
    top,
    contentWidth,
    markerWidth,
    glyphWidth,
    idWidth,
    ageWidth,
    textWidth,
    summaryHeight,
    separatorHeight,
    listHeight,
    footerHeight,
  };
}

/** A glyph, not colour alone, carries the status where colour cannot. */
const STATUS_GLYPHS: Record<TodoStatus, string> = {
  active: "▶",
  pending: "○",
  blocked: "!",
  completed: "✓",
  cancelled: "✗",
};

function statusColor(theme: Theme, status: TodoStatus): string {
  switch (status) {
    case "active": return theme.accent;
    case "blocked": return theme.warn;
    case "completed": return theme.success;
    case "cancelled": return theme.dim;
    default: return theme.fg;
  }
}

/** Cut to rendered columns without splitting a grapheme. */
function fit(text: string, width: number): string {
  return truncateStatusText(text, width) ?? "";
}

export function todoStatusSummary(tasks: readonly TodoTask[]): string {
  if (tasks.length === 0) return "no tasks";
  const parts: string[] = [];
  for (const status of TODO_STATUSES) {
    const count = tasks.filter((task) => task.status === status).length;
    if (count > 0) parts.push(`${count} ${status}`);
  }
  return parts.join(" · ");
}

export function todoEmptyLines(
  agentName: string,
  filter: TodoFilter,
  hasAnyTask: boolean,
): string[] {
  if (hasAnyTask) return [`No ${filter} tasks.`, "Press f to change the filter."];
  return [
    `${agentName} has no tasks yet.`,
    `${agentName} can call enable_tools with Todo, then todo_add.`,
    "This view is read-only.",
  ];
}

export function todoFooterText(
  layout: TodoPopupLayout,
  filter: TodoFilter,
  position: number,
  total: number,
): string {
  const counter = `${position}/${total}`;
  const wide = `filter ${filter}   ${counter}   ↑↓ move   f filter   esc close`;
  const narrow = `${filter}  ${counter}  ↑↓ f esc`;
  // Truncating the wide form would cut the only hint for closing the popup,
  // so it is used only where it fits whole.
  const fits = !layout.narrow && statusTextWidth(wide) <= layout.contentWidth;
  return fit(fits ? wide : narrow, layout.contentWidth);
}

export function TodoPopup({
  theme,
  terminalWidth,
  terminalHeight,
  agentName,
  tasks,
  filter,
  selectedId,
  now = Date.now(),
}: {
  theme: Theme;
  terminalWidth: number;
  terminalHeight: number;
  agentName: string;
  tasks: readonly TodoTask[];
  filter: TodoFilter;
  selectedId: string | null;
  now?: number;
}) {
  const layout = todoPopupLayout(terminalWidth, terminalHeight);
  const visible = visibleTodoTasks(tasks, filter);
  const selectedIndex = visible.findIndex((task) => task.id === selectedId);
  // Centring the selection keeps the rows after it on screen; anchoring it to
  // the last visible row would hide everything below.
  const maxWindowStart = Math.max(0, visible.length - layout.listHeight);
  const windowStart = selectedIndex < 0
    ? 0
    : Math.min(
      maxWindowStart,
      Math.max(0, selectedIndex - Math.floor((layout.listHeight - 1) / 2)),
    );
  const rows = visible.slice(windowStart, windowStart + layout.listHeight);
  const emptyLines = todoEmptyLines(agentName, filter, tasks.length > 0)
    .map((line) => fit(line, layout.contentWidth))
    .slice(0, layout.listHeight);

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={{
        top: layout.top,
        left: layout.margin,
        width: layout.popupWidth,
        height: layout.popupHeight,
      }}
      zIndex={100}
      title={` ${fit(`Todo · ${agentName}`, Math.max(1, layout.popupWidth - 4))} `}
    >
      {layout.listHeight ? <box
        style={{
          height: layout.listHeight,
          width: layout.contentWidth,
          flexShrink: 0,
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {visible.length === 0
          ? emptyLines.map((line, at) => (
            <text
              key={`empty-${at}`}
              content={line}
              fg={theme.dim}
              bg={theme.popupBg}
              wrapMode="none"
              style={{ height: 1, flexShrink: 0 }}
            />
          ))
          : rows.map((task) => {
            const selected = task.id === selectedId;
            const rowBg = selected ? theme.selectionBg : theme.popupBg;
            return (
              <box
                key={task.id}
                id={`todo-${task.id}`}
                style={{
                  height: 1,
                  width: layout.contentWidth,
                  flexShrink: 0,
                  flexDirection: "row",
                  backgroundColor: rowBg,
                  overflow: "hidden",
                }}
              >
                {layout.markerWidth ? <text
                  content={selected ? "› " : "  "}
                  fg={theme.accent}
                  bg={rowBg}
                  wrapMode="none"
                  style={{ width: layout.markerWidth, flexShrink: 0 }}
                /> : null}
                {layout.glyphWidth ? <text
                  content={`${STATUS_GLYPHS[task.status]} `}
                  fg={statusColor(theme, task.status)}
                  bg={rowBg}
                  wrapMode="none"
                  style={{ width: layout.glyphWidth, flexShrink: 0 }}
                /> : null}
                <text
                  content={fit(task.text, layout.textWidth)}
                  fg={selected ? theme.accent : theme.fg}
                  bg={rowBg}
                  wrapMode="none"
                  style={{ width: layout.textWidth, flexShrink: 0 }}
                />
                {layout.idWidth ? <text
                  content={` ${fit(task.id, TODO_ID_LENGTH)}`}
                  fg={theme.dim}
                  bg={rowBg}
                  wrapMode="none"
                  style={{ width: layout.idWidth, flexShrink: 0 }}
                /> : null}
                {layout.ageWidth ? <text
                  content={` ${fit(formatAge(task.updatedAt, now), layout.ageWidth - 1)}`}
                  fg={theme.dim}
                  bg={rowBg}
                  wrapMode="none"
                  style={{ width: layout.ageWidth, flexShrink: 0 }}
                /> : null}
              </box>
            );
          })}
      </box> : null}
      {layout.separatorHeight ? <box style={{ height: layout.separatorHeight, flexShrink: 0 }}>
        <text
          content={"─".repeat(layout.contentWidth)}
          fg={theme.border}
          bg={theme.popupBg}
          wrapMode="none"
        />
      </box> : null}
      {layout.summaryHeight ? <text
        content={fit(todoStatusSummary(tasks), layout.contentWidth)}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ height: layout.summaryHeight, flexShrink: 0 }}
      /> : null}
      {layout.footerHeight ? <text
        content={todoFooterText(
          layout,
          filter,
          selectedIndex < 0 ? 0 : selectedIndex + 1,
          visible.length,
        )}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ height: layout.footerHeight, flexShrink: 0 }}
      /> : null}
    </PopupFrame>
  );
}

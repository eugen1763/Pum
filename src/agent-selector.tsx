import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";
import type { Theme } from "./theme";
import type { SubagentSnapshot } from "./subagents/types";

export type AgentTreeRow = {
  id: string | null;
  name: string;
  status?: SubagentSnapshot["status"];
  depth: number;
};

export function buildAgentTree(agents: readonly SubagentSnapshot[]): AgentTreeRow[] {
  const children = new Map<string | null, SubagentSnapshot[]>();
  const ids = new Set(agents.map((agent) => agent.id));
  for (const agent of agents) {
    const parent = agent.parentAgentId && ids.has(agent.parentAgentId)
      ? agent.parentAgentId
      : null;
    children.set(parent, [...(children.get(parent) ?? []), agent]);
  }
  for (const values of children.values()) values.sort((a, b) => a.startedAt - b.startedAt);

  const rows: AgentTreeRow[] = [{ id: null, name: "main", depth: 0 }];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const agent of children.get(parentId) ?? []) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      rows.push({ id: agent.id, name: agent.name, status: agent.status, depth });
      visit(agent.id, depth + 1);
    }
  };
  visit(null, 1);
  // A corrupt parent cycle must not hide a retained agent.
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    rows.push({ id: agent.id, name: agent.name, status: agent.status, depth: 1 });
  }
  return rows;
}

export function moveAgentSelection(current: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

export function AgentSelectorPopup({
  theme,
  rows,
  cursor,
}: {
  theme: Theme;
  rows: readonly AgentTreeRow[];
  cursor: number;
}) {
  const { width, height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const narrow = width < 50;
  const popupWidth = narrow ? Math.max(12, width - 2) : Math.floor(width * 0.7);
  const popupColumns = Math.max(8, popupWidth - 5);
  const popupHeight = Math.min(
    rows.length + (narrow ? 10 : 7),
    Math.max(7, Math.floor(height * (narrow ? 0.85 : 0.7))),
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollChildIntoView(`agent-tree-${cursor}`);
    }, 0);
    return () => clearTimeout(timer);
  }, [cursor]);

  return (
    <box
      title=" Agents "
      style={{
        position: "absolute",
        top: narrow ? 1 : "15%",
        left: narrow ? 1 : "15%",
        width: popupWidth,
        height: popupHeight,
        zIndex: 100,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <scrollbox
        ref={scrollRef}
        style={{ flexGrow: 1, minHeight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
          {rows.map((row, index) => {
            const selected = index === cursor;
            const label = row.status ? `${row.name} · ${row.status}` : row.name;
            const indent = Math.min(2 + row.depth * 2, Math.max(2, popupColumns - 12));
            return (
              <box
                id={`agent-tree-${index}`}
                key={row.id ?? "main"}
                style={{
                  flexDirection: "row",
                  width: "100%",
                  flexShrink: 0,
                  backgroundColor: selected ? theme.selectionBg : theme.popupBg,
                }}
              >
                <box style={{ width: indent, flexShrink: 0 }}>
                  {selected ? <text content="› " fg={theme.accent} bg={selected ? theme.selectionBg : theme.popupBg} /> : null}
                </box>
                <text
                  content={label}
                  fg={selected ? theme.fg : theme.dim}
                  bg={selected ? theme.selectionBg : theme.popupBg}
                  wrapMode="char"
                  style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
                />
                {/* Reserve the pinned scrollbar column so it cannot cover text. */}
                <box style={{ width: 1, flexShrink: 0 }} />
              </box>
            );
          })}
        </box>
      </scrollbox>
      <box style={{ height: 1, flexShrink: 0 }} />
      <text
        content="↑↓ select   →/enter open   esc close"
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="word"
        style={{ flexShrink: 0, width: "100%" }}
      />
    </box>
  );
}

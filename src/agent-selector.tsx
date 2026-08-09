import { StyledText, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";
import { normalizeAgentUsage } from "./agent-usage";
import {
  fitStatusMetadata,
  statusMetadataChunks,
  statusMetadataItems,
  statusMetadataWidth,
  type StatusMetadataValues,
} from "./status-metadata";
import type { Theme } from "./theme";
import { PopupFrame } from "./popup-frame";
import type { SubagentSnapshot } from "./subagents/types";

export type AgentTreeRow = {
  id: string | null;
  name: string;
  status?: SubagentSnapshot["status"];
  depth: number;
  metadata?: StatusMetadataValues;
};

export type AgentSelectorRowLayout = {
  indent: number;
  label: string;
  labelWidth: number;
  metadata: ReturnType<typeof statusMetadataItems>;
  metadataWidth: number;
};

export function agentSelectorRowLayout(
  row: AgentTreeRow,
  popupColumns: number,
): AgentSelectorRowLayout {
  const indent = Math.min(2 + row.depth * 2, Math.max(2, popupColumns - 12));
  // One column remains clear for the pinned scrollbar.
  const contentColumns = Math.max(1, popupColumns - indent - 1);
  const label = row.status ? `${row.name} · ${row.status}` : row.name;
  const minimumLabelWidth = Math.min(
    label.length,
    Math.max(8, Math.ceil(contentColumns * 0.45)),
  );
  const availableMetadataWidth = Math.max(0, contentColumns - minimumLabelWidth - 2);
  const metadata = fitStatusMetadata(
    row.metadata ? statusMetadataItems(row.metadata) : [],
    availableMetadataWidth,
  );
  const metadataWidth = statusMetadataWidth(metadata);
  const labelWidth = Math.max(1, contentColumns - (metadataWidth ? metadataWidth + 2 : 0));
  return { indent, label, labelWidth, metadata, metadataWidth };
}

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
      const usage = normalizeAgentUsage(agent.usage);
      rows.push({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        depth,
        metadata: {
          branch: agent.worktree.branch ?? null,
          outgoingTokens: usage.outgoing,
          incomingTokens: usage.incoming,
          cacheReadTokens: usage.cacheRead,
          cost: usage.cost,
          contextPct: usage.contextPct,
        },
      });
      visit(agent.id, depth + 1);
    }
  };
  visit(null, 1);
  // A corrupt parent cycle must not hide a retained agent.
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    const usage = normalizeAgentUsage(agent.usage);
    rows.push({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      depth: 1,
      metadata: {
        branch: agent.worktree.branch ?? null,
        outgoingTokens: usage.outgoing,
        incomingTokens: usage.incoming,
        cacheReadTokens: usage.cacheRead,
        cost: usage.cost,
        contextPct: usage.contextPct,
      },
    });
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
  const popupWidth = narrow ? Math.max(1, width - 2) : Math.max(1, Math.floor(width * 0.7));
  const popupColumns = Math.max(8, popupWidth - 5);
  const popupHeight = Math.max(1, Math.min(
    height,
    rows.length + (narrow ? 10 : 7),
    Math.max(7, Math.floor(height * (narrow ? 0.85 : 0.7))),
  ));
  const geometry = {
    top: narrow ? Math.min(1, Math.max(0, height - popupHeight)) : Math.max(0, Math.floor(height * 0.15)),
    left: narrow ? Math.min(1, Math.max(0, width - popupWidth)) : Math.max(0, Math.floor(width * 0.15)),
    width: popupWidth,
    height: popupHeight,
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollChildIntoView(`agent-tree-${cursor}`);
    }, 0);
    return () => clearTimeout(timer);
  }, [cursor]);

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={width}
      terminalHeight={height}
      geometry={geometry}
      zIndex={100}
      title=" Agents "
    >
      <scrollbox
        ref={scrollRef}
        style={{ flexGrow: 1, minHeight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
          {rows.map((row, index) => {
            const selected = index === cursor;
            const layout = agentSelectorRowLayout(row, popupColumns);
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
                <box style={{ width: layout.indent, height: 1, flexShrink: 0 }}>
                  {selected ? <text content="› " fg={theme.accent} bg={theme.selectionBg} /> : null}
                </box>
                <text
                  content={layout.label}
                  fg={selected ? theme.fg : theme.dim}
                  bg={selected ? theme.selectionBg : theme.popupBg}
                  wrapMode="none"
                  style={{ width: layout.labelWidth, height: 1, flexShrink: 0 }}
                />
                {layout.metadataWidth ? (
                  <>
                    <box style={{ width: 2, height: 1, flexShrink: 0 }} />
                    <text
                      content={new StyledText(statusMetadataChunks(layout.metadata, theme))}
                      bg={selected ? theme.selectionBg : theme.popupBg}
                      wrapMode="none"
                      style={{ width: layout.metadataWidth, height: 1, flexShrink: 0 }}
                    />
                  </>
                ) : null}
                {/* Reserve the pinned scrollbar column so it cannot cover text. */}
                <box style={{ width: 1, height: 1, flexShrink: 0 }} />
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
    </PopupFrame>
  );
}

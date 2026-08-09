import { StyledText, fg, type TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useShimmerText, useSpinner } from "./animation";
import type { Theme } from "./theme";

export type StatusProps = {
  theme: Theme;
  modelId: string;
  thinkingLevel: string;
  branch: string | null;
  outgoingTokens: number;
  incomingTokens: number;
  cacheReadTokens: number;
  cost: number;
  contextPct: number | null;
  busy: boolean;
  elapsedSec: number;
  agentCount: number;
  runningAgentCount: number;
  activeAgentName?: string;
};

const fmtTokens = (n: number) => {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
};
const fmtCost = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
const fmtElapsed = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
};

function WorkingPulse({ theme }: { theme: Theme }) {
  const spinner = useSpinner(true);
  return <text ref={spinner} fg={theme.accent} />;
}

function Working({ theme, elapsedSec }: { theme: Theme; elapsedSec: number }) {
  const label = useShimmerText({
    text: "working",
    color: theme.accent,
    highlight: theme.highlight,
    active: true,
  });
  return (
    <box style={{ flexDirection: "row" }}>
      <WorkingPulse theme={theme} />
      <text content=" " />
      <text ref={label} />
      <text content={` ${fmtElapsed(elapsedSec)}  `} fg={theme.dim} />
    </box>
  );
}

export function StatusBar(props: StatusProps) {
  const {
    theme,
    modelId,
    thinkingLevel,
    branch,
    outgoingTokens,
    incomingTokens,
    cacheReadTokens,
    cost,
    contextPct,
    busy,
    agentCount,
    runningAgentCount,
    activeAgentName,
  } = props;
  const { width } = useTerminalDimensions();

  const left = [
    fg(theme.accent)(" pum "),
    fg(theme.dim)("  "),
    fg(theme.fg)(modelId),
    fg(theme.dim)(" · "),
    fg(theme.dim)(thinkingLevel),
  ];
  const idleAgentCount = Math.max(0, agentCount - runningAgentCount);
  const agentPrefix = agentCount > 0 ? " · " : "";
  const idleAgentText = idleAgentCount > 0 ? `◇ ${idleAgentCount}` : "";
  const workingAgentText = runningAgentCount > 0 ? `${idleAgentCount > 0 ? " " : ""}• ${runningAgentCount}` : "";
  const activeAgentText = activeAgentName ? ` · ${activeAgentName}` : "";

  const right: TextChunk[] = [];
  const push = (text: string, color: string) => {
    if (right.length) right.push(fg(theme.dim)(" · "));
    right.push(fg(color)(text));
  };
  if (branch) push(branch, theme.toolArg);
  if (outgoingTokens) push(`↑${fmtTokens(outgoingTokens)}`, theme.dim);
  if (incomingTokens) push(`↓${fmtTokens(incomingTokens)}`, theme.dim);
  if (cacheReadTokens) push(`○${fmtTokens(cacheReadTokens)}`, theme.dim);
  if (cost) push(fmtCost(cost), theme.dim);
  if (contextPct !== null) {
    push(`${contextPct}%`, contextPct > 75 ? theme.warn : theme.dim);
  }

  const plainLen = (chunks: { text: string }[]) => chunks.reduce((n, c) => n + c.text.length, 0);
  // The working indicator is its own element, so allow for it when measuring.
  const needed = plainLen(left) + agentPrefix.length + idleAgentText.length + workingAgentText.length +
    activeAgentText.length + plainLen(right) + (busy ? 16 : 0) + 2;
  const stacked = needed > width;

  const leftRow = (
    <box style={{ flexDirection: "row", flexGrow: 1, minWidth: 0 }}>
      <text content={new StyledText(left)} />
      {agentCount > 0 ? <text content={agentPrefix} fg={theme.dim} /> : null}
      {idleAgentCount > 0 ? <text content={idleAgentText} fg={theme.success} /> : null}
      {runningAgentCount > 0 ? (
        <box style={{ flexDirection: "row" }}>
          {idleAgentCount > 0 ? <text content=" " /> : null}
          <WorkingPulse theme={theme} />
          <text content={` ${runningAgentCount}`} fg={theme.accent} />
        </box>
      ) : null}
      {activeAgentName ? <text content={activeAgentText} fg={theme.dim} /> : null}
    </box>
  );
  const rightRow = (
    <box style={{ flexDirection: "row", height: 1 }}>
      {busy ? <Working theme={theme} elapsedSec={props.elapsedSec} /> : null}
      <text content={new StyledText(right)} />
      <text content=" " />
    </box>
  );

  return (
    // flexShrink 0: an auto-sized box shrinks by default, and when stacked this
    // is three rows tall — without it the rule gets squashed and overdrawn.
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {stacked ? (
        <>
          <box style={{ flexDirection: "row", height: 1 }}>{leftRow}</box>
          <box style={{ flexDirection: "row", height: 1, justifyContent: "flex-end" }}>
            {rightRow}
          </box>
        </>
      ) : (
        <box style={{ flexDirection: "row", height: 1, justifyContent: "space-between" }}>
          {leftRow}
          {rightRow}
        </box>
      )}
      <text content={"─".repeat(Math.max(0, width))} fg={theme.border} />
    </box>
  );
}

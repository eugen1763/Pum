import { StyledText, fg, type TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useShimmerText, useSpinner } from "./animation";
import type { Theme } from "./theme";

export type StatusProps = {
  theme: Theme;
  modelId: string;
  thinkingLevel: string;
  branch: string | null;
  tokens: number;
  cost: number;
  contextPct: number | null;
  busy: boolean;
  elapsedSec: number;
};

const fmtTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
const fmtCost = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

function Working({ theme, elapsedSec }: { theme: Theme; elapsedSec: number }) {
  const spinner = useSpinner(true);
  const label = useShimmerText({
    text: "working",
    color: theme.accent,
    highlight: theme.highlight,
    active: true,
  });
  return (
    <box style={{ flexDirection: "row" }}>
      <text ref={spinner} fg={theme.accent} />
      <text content=" " />
      <text ref={label} />
      <text content={` ${elapsedSec}s  `} fg={theme.dim} />
    </box>
  );
}

export function StatusBar(props: StatusProps) {
  const { theme, modelId, thinkingLevel, branch, tokens, cost, contextPct, busy } = props;
  const { width } = useTerminalDimensions();

  const left = [
    fg(theme.accent)(" pum "),
    fg(theme.dim)("  "),
    fg(theme.fg)(modelId),
    fg(theme.dim)(" · "),
    fg(theme.dim)(thinkingLevel),
  ];

  const right: TextChunk[] = [];
  const push = (text: string, color: string) => {
    if (right.length) right.push(fg(theme.dim)(" · "));
    right.push(fg(color)(text));
  };
  if (branch) push(branch, theme.toolArg);
  if (tokens) push(fmtTokens(tokens), theme.dim);
  if (cost) push(fmtCost(cost), theme.dim);
  if (contextPct !== null) {
    push(`${contextPct}%`, contextPct > 75 ? theme.warn : theme.dim);
  }

  const plainLen = (chunks: { text: string }[]) => chunks.reduce((n, c) => n + c.text.length, 0);
  // The working indicator is its own element, so allow for it when measuring.
  const needed = plainLen(left) + plainLen(right) + (busy ? 16 : 0) + 2;
  const stacked = needed > width;

  const leftRow = <text content={new StyledText(left)} style={{ flexGrow: 1 }} />;
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

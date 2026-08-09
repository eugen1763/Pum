import { StyledText, fg, type TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useShimmerText, useSpinner } from "./animation";
import {
  fitStatusMetadata,
  statusMetadataChunks,
  statusMetadataItems,
  statusMetadataWidth,
  statusTextWidth,
  type StatusMetadataItem,
} from "./status-metadata";
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
  maxActiveAgentCount: number;
  activeAgentName?: string;
};

const fmtElapsed = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
};

const REMOVAL_ORDER: readonly (StatusMetadataItem["key"] | "title")[] = [
  "cost",
  "cacheRead",
  "outgoing",
  "incoming",
  "title",
];

export type StatusBarLayout = {
  stacked: boolean;
  showTitle: boolean;
  metadata: StatusMetadataItem[];
  leftWidth: number;
  rightWidth: number;
};

type StatusBarLayoutInput = Pick<
  StatusProps,
  | "modelId"
  | "thinkingLevel"
  | "branch"
  | "outgoingTokens"
  | "incomingTokens"
  | "cacheReadTokens"
  | "cost"
  | "contextPct"
  | "busy"
  | "elapsedSec"
  | "agentCount"
  | "runningAgentCount"
  | "maxActiveAgentCount"
  | "activeAgentName"
> & { width: number };

function statusLeftWidth(input: StatusBarLayoutInput, showTitle: boolean): number {
  const idleAgentCount = Math.max(0, input.agentCount - input.runningAgentCount);
  const agentPrefix = input.agentCount > 0 ? " · " : "";
  const idleAgentText = idleAgentCount > 0 ? `◇ ${idleAgentCount}` : "";
  const workingAgentText = input.runningAgentCount > 0
    ? `${idleAgentCount > 0 ? " " : ""}• ${input.runningAgentCount}/${input.maxActiveAgentCount}`
    : "";
  const activeAgentText = input.activeAgentName ? ` · ${input.activeAgentName}` : "";
  const titleWidth = showTitle ? statusTextWidth(" pum ") + statusTextWidth("  ") : 0;
  return titleWidth + statusTextWidth(input.modelId) + statusTextWidth(" · ") +
    statusTextWidth(input.thinkingLevel) + statusTextWidth(agentPrefix) + statusTextWidth(idleAgentText) +
    statusTextWidth(workingAgentText) + statusTextWidth(activeAgentText);
}

function statusRightWidth(
  input: StatusBarLayoutInput,
  metadata: readonly StatusMetadataItem[],
): number {
  const workingWidth = input.busy ? 12 + statusTextWidth(fmtElapsed(input.elapsedSec)) : 0;
  return workingWidth + statusMetadataWidth(metadata) + 1;
}

export function statusBarLayout(input: StatusBarLayoutInput): StatusBarLayout {
  let showTitle = true;
  let metadata = statusMetadataItems(input);
  let leftWidth = statusLeftWidth(input, showTitle);
  let rightWidth = statusRightWidth(input, metadata);
  const stacked = leftWidth + rightWidth + 1 > input.width;

  if (stacked) {
    for (const key of REMOVAL_ORDER) {
      if (leftWidth <= input.width && rightWidth <= input.width) break;
      if (key === "title") showTitle = false;
      else metadata = metadata.filter((item) => item.key !== key);
      leftWidth = statusLeftWidth(input, showTitle);
      rightWidth = statusRightWidth(input, metadata);
    }

    if (rightWidth > input.width) {
      const workingWidth = input.busy ? 12 + statusTextWidth(fmtElapsed(input.elapsedSec)) : 0;
      metadata = fitStatusMetadata(metadata, input.width - workingWidth - 1);
      rightWidth = statusRightWidth(input, metadata);
    }
  }

  return { stacked, showTitle, metadata, leftWidth, rightWidth };
}

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
    busy,
    agentCount,
    runningAgentCount,
    maxActiveAgentCount,
    activeAgentName,
  } = props;
  const { width } = useTerminalDimensions();
  const layout = statusBarLayout({ ...props, width });

  const left = [
    ...(layout.showTitle ? [fg(theme.accent)(" pum "), fg(theme.dim)("  ")] : []),
    fg(theme.fg)(modelId),
    fg(theme.dim)(" · "),
    fg(theme.dim)(thinkingLevel),
  ];
  const idleAgentCount = Math.max(0, agentCount - runningAgentCount);
  const agentPrefix = agentCount > 0 ? " · " : "";
  const idleAgentText = idleAgentCount > 0 ? `◇ ${idleAgentCount}` : "";
  const workingAgentText = runningAgentCount > 0 ? `${idleAgentCount > 0 ? " " : ""}• ${runningAgentCount}/${maxActiveAgentCount}` : "";
  const activeAgentText = activeAgentName ? ` · ${activeAgentName}` : "";

  const right: TextChunk[] = statusMetadataChunks(layout.metadata, theme);

  const leftRow = (
    <box style={{ flexDirection: "row", flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
      <text content={new StyledText(left)} wrapMode="none" />
      {agentCount > 0 ? <text content={agentPrefix} fg={theme.dim} /> : null}
      {idleAgentCount > 0 ? <text content={idleAgentText} fg={theme.success} /> : null}
      {runningAgentCount > 0 ? (
        <box style={{ flexDirection: "row" }}>
          {idleAgentCount > 0 ? <text content=" " /> : null}
          <WorkingPulse theme={theme} />
          <text content={` ${runningAgentCount}/${maxActiveAgentCount}`} fg={theme.accent} />
        </box>
      ) : null}
      {activeAgentName ? <text content={activeAgentText} fg={theme.dim} wrapMode="none" /> : null}
    </box>
  );
  const rightRow = (
    <box style={{ flexDirection: "row", height: 1, maxWidth: "100%", overflow: "hidden" }}>
      {busy ? <Working theme={theme} elapsedSec={props.elapsedSec} /> : null}
      <text content={new StyledText(right)} wrapMode="none" />
      <text content=" " />
    </box>
  );

  return (
    // flexShrink 0: an auto-sized box shrinks by default, and when stacked its
    // two rows must remain between the explicit header rules in App.
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {layout.stacked ? (
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
    </box>
  );
}

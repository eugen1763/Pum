import { StyledText, fg } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { Fragment } from "react";
import { useShimmerText, useSpinner } from "./animation";
import {
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
  cwd: string;
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
  runningShellCount?: number;
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

/** The WorkingPulse spinner occupies exactly one terminal column. */
const PULSE_GLYPH_WIDTH = 1;

type WorkingMode = "full" | "compact" | "pulse" | null;
type LeftPart = "model" | "thinking" | "agents" | "shells" | "activeAgent";

export type StatusBarLayout = {
  showTitle: boolean;
  modelText: string | null;
  thinkingText: string | null;
  showIdleAgents: boolean;
  showRunningAgents: boolean;
  showRunningShells: boolean;
  activeAgentText: string | null;
  workingMode: WorkingMode;
  metadata: StatusMetadataItem[];
  trailingSpace: boolean;
  leftWidth: number;
  rightWidth: number;
  totalWidth: number;
};

type StatusBarLayoutInput = Pick<
  StatusProps,
  | "modelId"
  | "thinkingLevel"
  | "cwd"
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
  | "runningShellCount"
  | "activeAgentName"
> & { width: number };

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncate by rendered terminal columns without splitting a Unicode grapheme. */
export function truncateStatusText(text: string, maxWidth: number): string | null {
  if (maxWidth <= 0) return null;
  if (statusTextWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) {
    const first = graphemeSegmenter.segment(text)[Symbol.iterator]().next().value?.segment ?? "";
    return statusTextWidth(first) <= 1 ? first : "…";
  }

  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (statusTextWidth(result + segment) > maxWidth - 1) break;
    result += segment;
  }
  return `${result}…`;
}

function agentTextWidth(input: StatusBarLayoutInput, layout: StatusBarLayout): number {
  const idle = Math.max(0, input.agentCount - input.runningAgentCount);
  let width = 0;
  if (layout.showIdleAgents && idle > 0) width += statusTextWidth(`◇ ${idle}`);
  if (layout.showRunningAgents && input.runningAgentCount > 0) {
    // One space separates the idle block, not the pulse glyph.
    if (width) width += 1;
    // The running block renders as the pulse glyph (PULSE_GLYPH_WIDTH columns)
    // followed by the " N/M" counter. That leading space is inside the text
    // that statusTextWidth measures.
    width += PULSE_GLYPH_WIDTH + statusTextWidth(
      ` ${input.runningAgentCount}/${input.maxActiveAgentCount}`,
    );
  }
  return width;
}

function leftParts(input: StatusBarLayoutInput, layout: StatusBarLayout): LeftPart[] {
  const parts: LeftPart[] = [];
  if (layout.modelText) parts.push("model");
  if (layout.thinkingText) parts.push("thinking");
  if (agentTextWidth(input, layout) > 0) parts.push("agents");
  if (layout.showRunningShells && (input.runningShellCount ?? 0) > 0) parts.push("shells");
  if (layout.activeAgentText) parts.push("activeAgent");
  return parts;
}

function workingWidth(input: StatusBarLayoutInput, mode: WorkingMode): number {
  if (!mode) return 0;
  if (mode === "pulse") return PULSE_GLYPH_WIDTH;
  const elapsedWidth = statusTextWidth(fmtElapsed(input.elapsedSec));
  return mode === "full" ? 12 + elapsedWidth : 4 + elapsedWidth;
}

function measureLayout(input: StatusBarLayoutInput, layout: StatusBarLayout): void {
  const parts = leftParts(input, layout);
  const contentWidth = (layout.modelText ? statusTextWidth(layout.modelText) : 0) +
    (layout.thinkingText ? statusTextWidth(layout.thinkingText) : 0) +
    agentTextWidth(input, layout) +
    (layout.showRunningShells && (input.runningShellCount ?? 0) > 0
      ? statusTextWidth(`▣ ${input.runningShellCount}`)
      : 0) +
    (layout.activeAgentText ? statusTextWidth(layout.activeAgentText) : 0) +
    Math.max(0, parts.length - 1) * statusTextWidth(" · ");
  layout.leftWidth = (layout.showTitle ? statusTextWidth(" pum  ") : 0) + contentWidth;

  layout.rightWidth = workingWidth(input, layout.workingMode) +
    statusMetadataWidth(layout.metadata) + (layout.trailingSpace ? 1 : 0);
  layout.totalWidth = layout.leftWidth + layout.rightWidth +
    (layout.leftWidth > 0 && layout.rightWidth > 0 ? 1 : 0);
}

function truncateLayoutField(
  input: StatusBarLayoutInput,
  layout: StatusBarLayout,
  field: "modelText" | "activeAgentText",
): void {
  const text = layout[field];
  if (!text || layout.totalWidth <= input.width) return;
  const currentWidth = statusTextWidth(text);
  const available = Math.max(0, currentWidth - (layout.totalWidth - input.width));
  layout[field] = truncateStatusText(text, available);
  measureLayout(input, layout);
}

export function statusBarLayout(input: StatusBarLayoutInput): StatusBarLayout {
  const layout: StatusBarLayout = {
    showTitle: true,
    modelText: input.modelId || null,
    thinkingText: input.thinkingLevel || null,
    showIdleAgents: true,
    showRunningAgents: true,
    showRunningShells: true,
    activeAgentText: input.activeAgentName || null,
    workingMode: input.busy ? "full" : null,
    metadata: statusMetadataItems(input),
    trailingSpace: true,
    leftWidth: 0,
    rightWidth: 0,
    totalWidth: 0,
  };
  measureLayout(input, layout);

  // These user-specified optional fields always leave in this exact order.
  for (const key of REMOVAL_ORDER) {
    if (layout.totalWidth <= input.width) break;
    if (key === "title") layout.showTitle = false;
    else layout.metadata = layout.metadata.filter((item) => item.key !== key);
    measureLayout(input, layout);
  }

  // Preserve operational context before decorative padding and secondary data.
  if (layout.totalWidth > input.width) {
    layout.trailingSpace = false;
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.metadata = layout.metadata.filter((item) => item.key !== "cwd");
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.showIdleAgents = false;
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.metadata = layout.metadata.filter((item) => item.key !== "branch");
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.thinkingText = null;
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width && layout.workingMode === "full") {
    layout.workingMode = "compact";
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.metadata = layout.metadata.filter((item) => item.key !== "context");
    measureLayout(input, layout);
  }

  // Keep the selected agent name before the model identifier when space is scarce.
  truncateLayoutField(input, layout, "modelText");
  if (layout.totalWidth > input.width) {
    layout.modelText = null;
    measureLayout(input, layout);
  }
  truncateLayoutField(input, layout, "activeAgentText");
  if (layout.totalWidth > input.width) {
    layout.showRunningShells = false;
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.showRunningAgents = false;
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width && layout.workingMode === "compact") {
    layout.workingMode = "pulse";
    measureLayout(input, layout);
  }
  truncateLayoutField(input, layout, "activeAgentText");
  if (layout.totalWidth > input.width) {
    layout.activeAgentText = null;
    measureLayout(input, layout);
  }
  if (layout.totalWidth > input.width) {
    layout.workingMode = null;
    measureLayout(input, layout);
  }

  return layout;
}

function WorkingPulse({ theme }: { theme: Theme }) {
  const spinner = useSpinner(true);
  return <text ref={spinner} fg={theme.accent} />;
}

function Working({ theme, elapsedSec, mode }: {
  theme: Theme;
  elapsedSec: number;
  mode: Exclude<WorkingMode, null>;
}) {
  const label = useShimmerText({
    text: "working",
    color: theme.accent,
    highlight: theme.highlight,
    active: mode === "full",
  });
  if (mode === "pulse") return <WorkingPulse theme={theme} />;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <WorkingPulse theme={theme} />
      {mode === "full" ? <><text content=" " /><text ref={label} /></> : null}
      <text content={` ${fmtElapsed(elapsedSec)}  `} fg={theme.dim} />
    </box>
  );
}

export function StatusBar(props: StatusProps) {
  const { theme, agentCount, runningAgentCount, maxActiveAgentCount } = props;
  const { width } = useTerminalDimensions();
  const input = { ...props, width: Math.max(0, width) };
  const layout = statusBarLayout(input);
  const idleAgentCount = Math.max(0, agentCount - runningAgentCount);
  const parts = leftParts(input, layout);
  const right = statusMetadataChunks(layout.metadata, theme);

  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, overflow: "hidden", justifyContent: "space-between" }}>
      {layout.leftWidth > 0 ? (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, overflow: "hidden" }}>
          {layout.showTitle ? <text content=" pum  " fg={theme.accent} wrapMode="none" /> : null}
          {parts.map((part, index) => (
            <Fragment key={part}>
              {index > 0 ? <text content=" · " fg={theme.dim} wrapMode="none" /> : null}
              {part === "model" ? <text content={layout.modelText!} fg={theme.fg} wrapMode="none" /> : null}
              {part === "thinking" ? <text content={layout.thinkingText!} fg={theme.dim} wrapMode="none" /> : null}
              {part === "activeAgent" ? <text content={layout.activeAgentText!} fg={theme.dim} wrapMode="none" /> : null}
              {part === "shells" ? <text content={`▣ ${props.runningShellCount ?? 0}`} fg={theme.warn} wrapMode="none" /> : null}
              {part === "agents" ? (
                <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                  {layout.showIdleAgents && idleAgentCount > 0
                    ? <text content={`◇ ${idleAgentCount}`} fg={theme.success} />
                    : null}
                  {layout.showRunningAgents && runningAgentCount > 0 ? (
                    <>
                      {layout.showIdleAgents && idleAgentCount > 0 ? <text content=" " /> : null}
                      <WorkingPulse theme={theme} />
                      <text content={` ${runningAgentCount}/${maxActiveAgentCount}`} fg={theme.accent} />
                    </>
                  ) : null}
                </box>
              ) : null}
            </Fragment>
          ))}
        </box>
      ) : null}
      {layout.rightWidth > 0 ? (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, overflow: "hidden" }}>
          {layout.workingMode
            ? <Working theme={theme} elapsedSec={props.elapsedSec} mode={layout.workingMode} />
            : null}
          <text content={new StyledText(right)} wrapMode="none" />
          {layout.trailingSpace ? <text content=" " /> : null}
        </box>
      ) : null}
    </box>
  );
}

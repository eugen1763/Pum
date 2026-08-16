import {
  StyledText,
  TextAttributes,
  fg,
  type MarkdownRenderable,
  type MouseEvent as OpenTuiMouseEvent,
  type SyntaxStyle,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core";
import type { MarkdownProps } from "@opentui/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  useBlinkingText,
  useMarkdownCaret,
  useShimmerText,
  useSpinner,
} from "./animation";
import {
  goalReviewColor,
  goalReviewGlyph,
  goalReviewHeadline,
  type GoalReviewStatus,
} from "./goal-review";
import type { Theme } from "./theme";
import { bashOutputWindow, type BashOutputWindow, type ToolCall } from "./tool-line";
import type { TranscriptOutputMode } from "./transcript-output";
import type { MinimalToolSummaryLine } from "./output-minimal";
import {
  clipDiffPreview,
  inlineDiffLines,
  INLINE_DIFF_CHANGED_LINES,
  type DiffPreviewLine,
  type PreviewLanguage,
  type ToolResultPreview,
} from "./tool-preview";

export type Role = "user" | "assistant" | "thinking" | "system" | "error";

export type Line =
  | { kind: "text"; role: Role; text: string; newsId?: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "agent-message"; sender: string; recipient: string; text: string; messageId?: string }
  | GoalReviewRow;

/** One goal review: appended while the judge runs, rewritten with its outcome. */
export type GoalReviewRow = {
  kind: "goal-review";
  /** The judge that owns the row, so only its own result can settle it. */
  id: string;
  status: GoalReviewStatus;
  /** Short qualifier on the headline, such as the attempt count. */
  detail?: string;
  /** The judge's summary, or why the review produced nothing. */
  body?: string;
};

export type PendingLine = {
  id: string;
  line: Extract<Line, { kind: "text" | "agent-message" }>;
  /** Text used to match pi's message_start event. */
  deliveryText?: string;
  /** False when the queued user message must not be restored into the draft. */
  recallable?: boolean;
  /** True when the queued user message carries attachments that cannot be restored. */
  hasAttachments?: boolean;
  /** Pi inserted the message, but the active streamed message must finish first. */
  delivered?: boolean;
};

export type PendingTranscriptState = {
  lines: Line[];
  stream: { kind: "assistant" | "thinking"; text: string } | null;
  pending: PendingLine[];
};

/** Hide retained reasoning without changing the authoritative transcript state. */
export function transcriptForThinkingVisibility<T extends PendingTranscriptState>(
  value: T,
  showThinking: boolean,
): T {
  if (showThinking) return value;
  const lines = value.lines.filter(
    (line) => line.kind !== "text" || line.role !== "thinking",
  );
  const stream = value.stream?.kind === "thinking" ? null : value.stream;
  if (lines.length === value.lines.length && stream === value.stream) return value;
  return { ...value, lines, stream };
}

// Top-level blocks flip the table default to borderless columns, so the grid
// style has to be asked for. One frozen object: the setter reapplies the
// options to every block on assignment, without checking whether they changed.
const MARKDOWN_TABLE_OPTIONS: MarkdownProps["tableOptions"] = { style: "grid" };

/**
 * OpenTUI 0.5.1 supports Markdown selection at runtime but omits the React prop.
 *
 * Coalesced blocks also hand the renderer one synthetic token carrying the raw
 * source and no inline children. Its synchronous placeholder then comes from
 * the inline lexer, which does not know block syntax, so heading markers
 * survive until the asynchronous highlight conceals them — and every streamed
 * chunk repaints them. Top-level blocks keep the real heading token, whose
 * placeholder is concealed from the start.
 */
export function SelectableMarkdown({ ref, ...props }: MarkdownProps) {
  const setRef = (renderable: MarkdownRenderable | null) => {
    if (renderable) renderable.selectable = true;
    if (typeof ref === "function") ref(renderable);
    else if (ref) ref.current = renderable;
  };
  return (
    <markdown
      internalBlockMode="top-level"
      tableOptions={MARKDOWN_TABLE_OPTIONS}
      {...props}
      ref={setRef}
    />
  );
}

/** Resolve a delivered message without splitting the active streamed output. */
export function resolvePendingDelivery<T extends PendingTranscriptState>(value: T, id: string): T {
  const pending = value.pending.find((item) => item.id === id);
  if (!pending) return value;
  if (value.stream) {
    return {
      ...value,
      pending: value.pending.map((item) => item.id === id ? { ...item, delivered: true } : item),
    };
  }
  return {
    ...value,
    lines: [...value.lines, pending.line],
    pending: value.pending.filter((item) => item.id !== id),
  };
}

/**
 * Settle one goal-review row in place.
 *
 * Only a row that is still reviewing is rewritten, so the call is idempotent
 * and the first outcome to arrive wins. A cancel racing a verdict then cannot
 * overwrite the verdict the user already read.
 */
export function resolveGoalReview<T extends PendingTranscriptState>(
  value: T,
  id: string,
  patch: { status: GoalReviewStatus; detail?: string; body?: string },
): T {
  const index = value.lines.findIndex(
    (line) => line.kind === "goal-review" && line.id === id && line.status === "reviewing",
  );
  if (index < 0) return value;
  const lines = [...value.lines];
  lines[index] = { kind: "goal-review", id, ...patch };
  return { ...value, lines };
}

/** Finish the stream, then insert messages that arrived while it was active. */
export function settleTranscriptMessage<T extends PendingTranscriptState>(value: T): T {
  const lines = [...value.lines];
  if (value.stream?.text.trim()) {
    lines.push({ kind: "text", role: value.stream.kind, text: value.stream.text.trim() });
  }
  const delivered = value.pending.filter((item) => item.delivered);
  return {
    ...value,
    lines: [...lines, ...delivered.map((item) => item.line)],
    stream: null,
    pending: value.pending.filter((item) => !item.delivered),
  };
}

type LineGroup = "tool" | "thinking" | "summary" | "review" | "other";

/** Gaps are computed over displayed rows, so grouped activity counts as one. */
export type GapLine = Line | MinimalToolSummaryLine;

const lineGroup = (line: GapLine): LineGroup => {
  if (line.kind === "tool-summary") return "summary";
  if (line.kind === "tool") return "tool";
  // A review stands between two turns, so it always gets air on both sides.
  if (line.kind === "goal-review") return "review";
  return line.kind === "text" && line.role === "thinking" ? "thinking" : "other";
};

/**
 * One gap above every tool row, and one around thinking groups.
 *
 * A run of calls reads as separate steps rather than a wall, so each one gets
 * air above it: a tool row, a grouped activity row, and the goal review that
 * stands between two turns all carry their own blank line.
 */
export function needsTranscriptGap(prev: GapLine | undefined, line: GapLine): boolean {
  if (!prev) return false;
  const prevGroup = lineGroup(prev);
  const group = lineGroup(line);

  if (group === "summary" || group === "tool" || group === "review") return true;
  if (prevGroup === "summary" || prevGroup === "tool" || prevGroup === "review") return true;
  if (prevGroup !== group && (prevGroup !== "other" || group !== "other")) return true;
  if (group !== "other") return false;

  // Preserve the normal turn layout for rows outside tool/thinking groups.
  const isUser = line.kind === "text" && line.role === "user";
  const prevIsUser = prev.kind === "text" && prev.role === "user";
  const isAnswer = line.kind === "text" && line.role === "assistant";
  const isAgentMessage = line.kind === "agent-message" || prev.kind === "agent-message";
  return isUser || prevIsUser || isAnswer || isAgentMessage;
}

/**
 * Where to scroll so a revealed row starts at the top of the viewport.
 *
 * Scrolling a row merely "into view" parks one that just grew against the
 * bottom edge, with the content it revealed still below the fold. A row is
 * only ever opened to be read, so anchor its first line at the top and show
 * as much as fits.
 */
export function topAnchorScrollTop(
  rowOffset: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  const furthest = Math.max(0, scrollHeight - viewportHeight);
  return Math.max(0, Math.min(rowOffset, furthest));
}

const GUTTER = "  ";
const PROMPT = "❯ ";

/** Remove provider trace wrappers and compact adjacent thinking entries. */
export function normalizeThinkingText(text: string): string {
  return text
    .replaceAll("**", "")
    .replace(/\n[ \t]*\n+/g, "\n");
}

export function roleColor(theme: Theme, role: Role): string {
  switch (role) {
    case "user":
      return theme.user;
    case "assistant":
      return theme.assistant;
    case "thinking":
      return theme.thinking;
    case "system":
      return theme.dim;
    case "error":
      return theme.error;
  }
}

/**
 * A one-row glyph cell beside a growing text cell. The text wraps inside its
 * own narrower column, so every wrapped row lines up under the first and the
 * glyph appears only once. The background comes from the box, because a text's
 * own `bg` paints glyph cells only.
 */
function Row({
  glyph,
  glyphColor,
  glyphRef,
  background,
  onGlyphClick,
  children,
}: {
  glyph: string;
  glyphColor: string;
  /** An animated gutter glyph writes its own content through this ref. */
  glyphRef?: RefObject<TextRenderable | null>;
  background?: string;
  onGlyphClick?: (event: OpenTuiMouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        backgroundColor: background ?? "transparent",
      }}
    >
      {/* A numeric width pins the gutter: a whitespace-only <text> measures
          inconsistently once the message column wraps, losing a column. */}
      <box style={{ width: 2, flexShrink: 0 }}>
        {/* A blank gutter still renders when it can be clicked, so a row with
            no disclosure glyph keeps its mouse target. */}
        {glyphRef ? <text ref={glyphRef} fg={glyphColor} /> : glyph.trim() || onGlyphClick ? <text
          content={glyph}
          fg={glyphColor}
          onMouseDown={onGlyphClick ? (event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onGlyphClick(event);
          } : undefined}
        /> : null}
      </box>
      {/* The nested flex item gives every transcript type the same measured
          remaining-width column as the tool-row body. */}
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {children}
      </box>
    </box>
  );
}

/** Columns every tool-related row is indented past its tool row. */
export const TOOL_DETAIL_INDENT = 2;

/**
 * Anything a tool row says on a following row: output, a diff, a rejection
 * reason, an expanded detail. One wrapper rather than a constant each renderer
 * remembers to apply, so a row type added later cannot forget the indent.
 */
function DetailRow({
  theme,
  color,
  children,
}: {
  theme: Theme;
  /** Gutter colour. The rows themselves colour their own text. */
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <Row glyph={GUTTER} glyphColor={color ?? theme.dim}>
      <box style={{ width: TOOL_DETAIL_INDENT, flexShrink: 0 }} />
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {children}
      </box>
    </Row>
  );
}

export function TextLine({
  theme,
  syntaxStyle,
  role,
  text,
  workingCaret = false,
  news,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  role: Role;
  text: string;
  workingCaret?: boolean;
  /** News marker for a recorded final answer: unseen circle or seen check. */
  news?: "unseen" | "seen";
}) {
  const color = roleColor(theme, role);
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const displayText = role === "thinking" ? normalizeThinkingText(text) : text;
  const textCaret = useBlinkingText({
    chunks: [fg(color)(displayText)],
    contentKey: `${role}:${displayText}`,
    caretColor: color,
    background: theme.bg,
    active: workingCaret && !isAssistant,
  });
  const markdownCaret = useMarkdownCaret(text, workingCaret && isAssistant);

  // Assistant text is already styled while streaming, so settlement only
  // finalizes Markdown parsing and does not swap through a plain-text phase.
  // User messages are static Markdown. They never get a streaming caret.
  if (isAssistant || isUser) {
    const isNews = isAssistant && news !== undefined;
    const glyph = isNews
      ? news === "seen" ? "✓ " : "◦ "
      : isUser
        ? PROMPT
        : GUTTER;
    const glyphColor = isNews
      ? news === "seen" ? theme.success : theme.dim
      : color;
    return (
      <Row
        glyph={glyph}
        glyphColor={glyphColor}
        background={isUser ? theme.userBg : undefined}
      >
        <SelectableMarkdown
          ref={isAssistant && workingCaret ? markdownCaret.ref : undefined}
          content={isAssistant && workingCaret ? markdownCaret.content : text}
          streaming={false}
          syntaxStyle={syntaxStyle}
          fg={color}
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
        />
      </Row>
    );
  }

  return (
    <Row glyph={GUTTER} glyphColor={color}>
      <text
        ref={workingCaret ? textCaret : undefined}
        // The caret hook repaints this imperatively on the frame clock. Passing
        // the text anyway means the row is never blank while it waits for the
        // first tick, which is a visible flash and an unreliable test.
        content={displayText}
        fg={color}
        selectable
        wrapMode="word"
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
      />
    </Row>
  );
}

/** The line currently streaming in: shimmered, with a caret riding the end. */
export function StreamLine({
  theme,
  syntaxStyle,
  role,
  text,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  role: "assistant" | "thinking";
  text: string;
}) {
  const color = roleColor(theme, role);
  const displayText = role === "thinking" ? normalizeThinkingText(text) : text;
  const shimmer = useShimmerText({
    text: displayText,
    color,
    highlight: theme.highlight,
    background: theme.bg,
    active: role === "thinking",
    caret: true,
  });
  const markdown = useMarkdownCaret(text, role === "assistant");

  return (
    <Row glyph={GUTTER} glyphColor={color}>
      {role === "assistant" ? (
        <SelectableMarkdown
          ref={markdown.ref}
          content={markdown.content}
          streaming
          syntaxStyle={syntaxStyle}
          fg={color}
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
        />
      ) : (
        <text
          ref={shimmer}
          content={displayText}
          selectable
          wrapMode="word"
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
        />
      )}
    </Row>
  );
}

export function PendingMessageLine({
  theme,
  syntaxStyle,
  pending,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  pending: PendingLine;
}) {
  const line = pending.line;
  if (line.kind === "agent-message") {
    return (
      <Row glyph="◇ " glyphColor={theme.dim} background={theme.agentMessageBg}>
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <text
            content={`${line.sender} → ${line.recipient} · queued`}
            fg={theme.dim}
            selectable
            wrapMode="word"
            style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
          />
          <SelectableMarkdown
            content={line.text}
            streaming={false}
            syntaxStyle={syntaxStyle}
            fg={theme.dim}
            style={{ width: "100%", flexGrow: 1, flexShrink: 1, minWidth: 0 }}
          />
        </box>
      </Row>
    );
  }

  return (
    <Row glyph="○ " glyphColor={theme.dim} background={theme.userBg}>
      <SelectableMarkdown
        content={line.text}
        streaming={false}
        syntaxStyle={syntaxStyle}
        fg={theme.dim}
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
      />
    </Row>
  );
}

/**
 * One goal review. While the judge runs the row shimmers under a pulsing
 * gutter glyph; when the verdict lands the same row states the outcome, so the
 * wait and its result never occupy two places in the transcript.
 */
export function GoalReviewLine({
  theme,
  line,
}: {
  theme: Theme;
  line: GoalReviewRow;
}) {
  const reviewing = line.status === "reviewing";
  const color = goalReviewColor(theme, line.status);
  const headline = goalReviewHeadline(line.status, line.detail);
  const spinner = useSpinner(reviewing);
  // The shimmer ref owns the headline in both phases: inactive, the hook still
  // paints the plain text, so the settled row needs no second code path.
  const shimmer = useShimmerText({
    text: headline,
    color,
    highlight: theme.highlight,
    background: theme.bg,
    active: reviewing,
  });

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row
        glyph={goalReviewGlyph(line.status)}
        glyphColor={color}
        {...(reviewing ? { glyphRef: spinner } : {})}
      >
        <text
          ref={shimmer}
          content={headline}
          selectable
          wrapMode="word"
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
        />
      </Row>
      {line.body ? (
        <Row glyph={GUTTER} glyphColor={theme.dim}>
          <text
            content={line.body}
            fg={theme.dim}
            selectable
            wrapMode="word"
            style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
          />
        </Row>
      ) : null}
    </box>
  );
}

export function AgentMessageLine({
  theme,
  syntaxStyle,
  line,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  line: Extract<Line, { kind: "agent-message" }>;
}) {
  return (
    <Row glyph="◇ " glyphColor={theme.agentMessage} background={theme.agentMessageBg}>
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <text
          content={`${line.sender} → ${line.recipient}`}
          fg={theme.agentMessage}
          selectable
          wrapMode="word"
          style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
        />
        <SelectableMarkdown
          content={line.text}
          streaming={false}
          syntaxStyle={syntaxStyle}
          fg={theme.agentMessage}
          style={{ width: "100%", flexGrow: 1, flexShrink: 1, minWidth: 0 }}
        />
      </box>
    </Row>
  );
}

export function toolStateGlyph(state: ToolCall["state"]): string {
  if (state === "ok") return "✓";
  if (state === "rejected") return "!";
  return "✗";
}

const CHECK_MODE_HARD_BLOCK_PREFIX = "Check mode hard block:";
export const VERBOSE_RAW_CHARACTER_LIMIT = 200_000;
/** Lines of result a row shows when it is opened outside Verbose. */
export const COMPACT_DETAIL_LINES = 20;

function jsonText(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `tool(first, second)`, the one spelling every renderer and copy path uses. */
export function toolCallSignature(call: ToolCall): string {
  return `${call.name}(${call.args.join(", ")})`;
}

/** The retained input and result, as text. The row above already names the call. */
export function rawToolDetailText(call: ToolCall): string {
  if (call.input === undefined && call.result === undefined) return "No retained input or result.";
  return [
    "input:",
    jsonText(call.input),
    "result:",
    jsonText(call.result),
  ].join("\n");
}

/** Stable raw text used by transcript-row clipboard copy. */
export function rawToolText(call: ToolCall): string {
  return `${toolCallSignature(call)}\n${rawToolDetailText(call)}`;
}

function RawToolDetails({ theme, call }: { theme: Theme; call: ToolCall }) {
  const raw = rawToolDetailText(call);
  const clipped = raw.length > VERBOSE_RAW_CHARACTER_LIMIT;
  const content = clipped ? raw.slice(0, VERBOSE_RAW_CHARACTER_LIMIT) : raw;
  return (
    <DetailRow theme={theme}>
      <text
        content={content}
        fg={theme.dim}
        selectable
        wrapMode="word"
        style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
      />
      {clipped ? <text
        content={`… raw result capped at ${VERBOSE_RAW_CHARACTER_LIMIT.toLocaleString()} characters; press c to copy the complete data`}
        fg={theme.dim}
        selectable
        wrapMode="word"
        style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
      /> : null}
    </DetailRow>
  );
}

/**
 * The text of a tool result, as a person reads it.
 *
 * A string result is its own text. Anything structured shows the fields that
 * carry the output rather than the envelope around them, because the envelope
 * is what makes a raw dump unreadable.
 */
export function resultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  if (Array.isArray(result)) {
    return result.map((item) => resultText(item)).filter(Boolean).join("\n");
  }
  const record = result as Record<string, unknown>;
  // A pi tool result is content blocks under an envelope. The blocks are the
  // output; the envelope is the part that makes a raw dump unreadable.
  if (Array.isArray(record.content)) {
    const blocks = resultText(record.content);
    if (blocks) return blocks;
  }
  for (const key of ["output", "text", "stdout", "message", "result", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return jsonText(result);
}

/**
 * The tail of a result, capped, with a count of what the cap hid.
 *
 * The same window Bash output uses, over a different source: one rule for
 * keeping the newest lines, including how line endings and a trailing newline
 * are counted.
 */
export function compactResultWindow(
  result: unknown,
  limit = COMPACT_DETAIL_LINES,
): BashOutputWindow {
  const text = resultText(result);
  return text ? bashOutputWindow(text, limit) : { lines: [], hidden: 0 };
}

/**
 * What opening a row shows outside Verbose: the result, capped, and nothing
 * else. No JSON envelope and no echo of the input, which the row above already
 * spells out — a read row carries its own path, offset and limit. Verbose stays
 * the raw view, and copying a row still copies everything retained.
 */
function CompactToolDetails({ theme, call }: { theme: Theme; call: ToolCall }) {
  const window = compactResultWindow(call.result);
  if (window.lines.length === 0) {
    return (
      <DetailRow theme={theme}>
        <text
          content="no result was retained"
          fg={theme.dim}
          selectable
          wrapMode="word"
          style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
        />
      </DetailRow>
    );
  }
  const color = call.isError ? theme.error : theme.bashOutput;
  return (
    <DetailRow theme={theme} color={color}>
      <OmittedLines theme={theme} count={window.hidden} />
      {window.lines.map((line, index) => line ? (
        <text
          key={`${index}:${line}`}
          content={line}
          fg={color}
          selectable
          wrapMode="word"
          style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
        />
      ) : (
        <box key={`${index}:blank`} style={{ height: 1, flexShrink: 0 }} />
      ))}
    </DetailRow>
  );
}

function rejectedDetail(theme: Theme, detail: string): StyledText {
  if (!detail.startsWith(CHECK_MODE_HARD_BLOCK_PREFIX)) {
    return new StyledText([fg(theme.rejection)(detail)]);
  }
  return new StyledText([
    {
      ...fg(theme.rejection)(CHECK_MODE_HARD_BLOCK_PREFIX),
      attributes: TextAttributes.BOLD,
    },
    fg(theme.rejection)(detail.slice(CHECK_MODE_HARD_BLOCK_PREFIX.length)),
  ]);
}

export function ToolLine({
  theme,
  syntaxStyle,
  call,
  workingCaret = false,
  outputMode = "normal",
  expanded,
  onDisclosureClick,
}: {
  theme: Theme;
  syntaxStyle?: SyntaxStyle;
  call: ToolCall;
  workingCaret?: boolean;
  /** Verbose renderers use this without changing canonical call data. */
  outputMode?: TranscriptOutputMode;
  /** Explicit expansion reveals raw retained tool input and result. */
  expanded?: boolean;
  /** Mouse activation on the disclosure glyph; text remains selectable. */
  onDisclosureClick?: () => void;
}) {
  const spinner = useSpinner(call.state === "running");
  const failed = call.state === "error";
  const rejected = call.state === "rejected";
  const toolColor = failed ? theme.error : rejected ? theme.rejection : theme.tool;
  const argColor = failed ? theme.error : rejected ? theme.rejection : theme.toolArg;
  const detailColor = failed ? theme.error : rejected ? theme.rejection : theme.dim;

  // `tool(` never wraps, so the arguments wrap under a stable left edge.
  const prefix = new StyledText([fg(toolColor)(`${call.name}(`)]);
  const bodyChunks: TextChunk[] = [];
  for (const [index, arg] of call.args.entries()) {
    if (index > 0) bodyChunks.push(fg(toolColor)(", "));
    bodyChunks.push(fg(argColor)(arg));
  }
  bodyChunks.push(fg(toolColor)(")"));
  if (call.detail && !rejected) bodyChunks.push(fg(detailColor)(`  ${call.detail}`));
  if (failed && call.name === "bash" && call.exitCode !== undefined) {
    bodyChunks.push(fg(detailColor)(` · exit ${call.exitCode}`));
  }

  const caret = useBlinkingText({
    chunks: bodyChunks,
    contentKey: `${toolCallSignature(call)}:${call.state}:${call.detail ?? ""}`,
    caretColor: failed ? theme.error : rejected ? theme.rejection : theme.accent,
    background: theme.bg,
    active: workingCaret,
  });
  // Whether live output may be shown at all is decided once, in the dwell
  // layer, so a remount cannot reopen a period that already closed.
  const output = call.name === "bash" && call.output
    && outputMode !== "quiet"
    && (call.state === "running" || outputMode !== "verbose")
    ? bashOutputWindow(call.output)
    : null;
  const explicitDetails = expanded === true && outputMode !== "verbose";
  const automaticVerboseDetails = outputMode === "verbose" && expanded !== false;
  // A mutation shows its diff without being asked. Verbose is the raw view and
  // renders no diff at all; expanding one drops the cap rather than hiding it.
  const inlineDiff = call.preview?.kind === "diff"
    && call.state === "ok"
    && outputMode !== "verbose"
    ? call.preview
    : undefined;
  // Bash keeps a preview of its tail, but only when a row is opened by hand.
  // Verbose renders no preview of any kind: it is the raw view.
  const detailedPreview = explicitDetails
    && call.state !== "running"
    && call.state !== "rejected"
    && call.preview?.kind === "bash"
    ? call.preview
    : undefined;
  // No disclosure arrow on a tool row: every one of them expands, so the glyph
  // marked nothing and only added noise down the left edge. The gutter stays
  // clickable, so the mouse still opens a row.

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row glyph={GUTTER} glyphColor={toolColor} onGlyphClick={onDisclosureClick ? () => onDisclosureClick() : undefined}>
        <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <text content={prefix} selectable style={{ flexShrink: 0 }} />
          <text
            ref={workingCaret ? caret : undefined}
            content={new StyledText(bodyChunks)}
            selectable
            wrapMode="word"
            style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
          />
        </box>
        {/* The transcript scrollbox uses two padding columns and one pinned
            scrollbar column. The row then uses a two-column gutter and a
            one-column state marker. Bash reserves one additional column before
            the marker so commands wrap before the terminal-edge boundary. */}
        <box style={{ width: call.name === "bash" ? 2 : 1, flexShrink: 0 }} />
        <box style={{ width: 1, flexShrink: 0 }}>
          {call.state === "running" ? (
            <text ref={spinner} fg={theme.accent} />
          ) : (
            <text
              content={toolStateGlyph(call.state)}
              fg={call.state === "ok" ? theme.success : rejected ? theme.rejection : theme.error}
            />
          )}
        </box>
      </Row>
      {rejected && call.detail ? (
        <DetailRow theme={theme} color={theme.rejection}>
          <text
            content={rejectedDetail(theme, call.detail)}
            selectable
            wrapMode="word"
            style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
          />
        </DetailRow>
      ) : null}
      {output && (output.hidden > 0 || output.lines.length > 0) ? (
        <DetailRow theme={theme} color={theme.bashOutput}>
          {output.hidden > 0 ? (
            <text
              content={`... ${output.hidden} more line${output.hidden === 1 ? "" : "s"}`}
              fg={theme.bashOutput}
              selectable
              wrapMode="word"
              style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
            />
          ) : null}
          {output.lines.map((line, index) => line ? (
            <text
              key={`${index}:${line}`}
              content={line}
              fg={theme.bashOutput}
              selectable
              wrapMode="word"
              style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
            />
          ) : (
            <box key={`${index}:blank`} style={{ height: 1, flexShrink: 0 }} />
          ))}
        </DetailRow>
      ) : null}
      {inlineDiff ? (
        <DetailedToolPreview
          theme={theme}
          syntaxStyle={syntaxStyle}
          preview={inlineDiff}
          {...(expanded === true ? {} : { changedLineLimit: INLINE_DIFF_CHANGED_LINES })}
        />
      ) : null}
      {detailedPreview ? (
        <DetailedToolPreview theme={theme} syntaxStyle={syntaxStyle} preview={detailedPreview} />
      ) : null}
      {explicitDetails && call.state !== "running"
        ? <CompactToolDetails theme={theme} call={call} />
        : null}
      {automaticVerboseDetails && call.state !== "running"
        ? <RawToolDetails theme={theme} call={call} />
        : null}
    </box>
  );
}

/** Compact grouped routine activity with optional raw child expansion. */
export function ActivitySummaryLine({
  theme,
  syntaxStyle,
  summary,
  expanded,
  outputMode,
  onDisclosureClick,
}: {
  theme: Theme;
  syntaxStyle?: SyntaxStyle;
  summary: MinimalToolSummaryLine;
  expanded: boolean;
  outputMode: TranscriptOutputMode;
  onDisclosureClick?: () => void;
}) {
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {/* No arrow: every activity row expands, so the glyph marked nothing and
          only added noise down the left edge. The gutter stays clickable. */}
      <Row
        glyph={GUTTER}
        glyphColor={theme.dim}
        onGlyphClick={onDisclosureClick ? () => onDisclosureClick() : undefined}
      >
        <text
          content={summary.text}
          fg={theme.dim}
          selectable
          wrapMode="word"
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
        />
      </Row>
      {/* The calls belong to the row above, so they sit under the same indent
          every other tool-related row uses. */}
      {expanded ? (
        <box style={{ flexDirection: "row", width: "100%" }}>
          <box style={{ width: TOOL_DETAIL_INDENT, flexShrink: 0 }} />
          <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
            {summary.calls.map((call) => (
              <ToolLine
                key={call.id}
                theme={theme}
                syntaxStyle={syntaxStyle}
                call={call}
                outputMode={outputMode}
                expanded
              />
            ))}
          </box>
        </box>
      ) : null}
    </box>
  );
}

function previewColor(theme: Theme, kind: DiffPreviewLine["kind"]): string {
  if (kind === "add") return theme.success;
  if (kind === "remove") return theme.error;
  if (kind === "context") return theme.dim;
  return theme.tool;
}

function previewBackground(theme: Theme, kind: DiffPreviewLine["kind"]): string {
  if (kind === "add") return theme.diffAddedBg;
  if (kind === "remove") return theme.diffRemovedBg;
  return "transparent";
}

function PreviewSource({
  content,
  language,
  syntaxStyle,
  fallbackColor,
  background,
}: {
  content: string;
  language?: PreviewLanguage;
  syntaxStyle?: SyntaxStyle;
  fallbackColor: string;
  background?: string;
}) {
  if (!content) return <box style={{ height: 1, flexShrink: 0, backgroundColor: background ?? "transparent" }} />;
  if (language && syntaxStyle) {
    return (
      <code
        content={content}
        filetype={language}
        syntaxStyle={syntaxStyle}
        bg={background}
        selectable
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
      />
    );
  }
  return (
    <text
      content={content}
      fg={fallbackColor}
      bg={background}
      selectable
      wrapMode="word"
      style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
    />
  );
}

function OmittedLines({ theme, count }: { theme: Theme; count: number }) {
  if (count <= 0) return null;
  return (
    <text
      content={`... ${count} more line${count === 1 ? "" : "s"}`}
      fg={theme.dim}
      selectable
      wrapMode="word"
      style={{ width: "100%", flexShrink: 0, minWidth: 0 }}
    />
  );
}

/** Display-only detailed preview. The model-facing tool result stays unchanged. */
export function DetailedToolPreview({
  theme,
  syntaxStyle,
  preview,
  changedLineLimit,
}: {
  theme: Theme;
  syntaxStyle?: SyntaxStyle;
  preview: ToolResultPreview;
  /** Changed lines shown before the rest collapses to a count. */
  changedLineLimit?: number;
}) {
  if (preview.kind === "diff") {
    const lines = inlineDiffLines(preview.lines);
    const window = changedLineLimit === undefined
      ? { lines, hidden: 0 }
      : clipDiffPreview(lines, changedLineLimit);
    return (
      <DetailRow theme={theme}>
        {window.lines.map((line: DiffPreviewLine, index: number) => {
            const color = previewColor(theme, line.kind);
            if (line.kind === "header") {
              return line.text ? (
                <text
                  key={`${index}:${line.text}`}
                  content={line.text}
                  fg={color}
                  selectable
                  wrapMode="word"
                  style={{ width: "100%", flexShrink: 0, minWidth: 0 }}
                />
              ) : <box key={`${index}:blank`} style={{ height: 1, flexShrink: 0 }} />;
            }
            return (
              <box
                key={`${index}:${line.text}`}
                style={{
                  flexDirection: "row",
                  width: "100%",
                  flexShrink: 0,
                  backgroundColor: previewBackground(theme, line.kind),
                }}
              >
                <box style={{ width: 1, flexShrink: 0 }}>
                  <text
                    content={line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                    fg={color}
                    bg={previewBackground(theme, line.kind)}
                  />
                </box>
                <PreviewSource
                  content={line.source}
                  language={line.language}
                  syntaxStyle={syntaxStyle}
                  fallbackColor={color}
                  background={previewBackground(theme, line.kind)}
                />
              </box>
            );
        })}
        <OmittedLines theme={theme} count={window.hidden} />
      </DetailRow>
    );
  }

  return (
    <DetailRow theme={theme}>
      {preview.window.lines.map((line, index) => line ? (
        <text
          key={`${index}:${line}`}
          content={line}
          fg={theme.bashOutput}
          selectable
          wrapMode="word"
          style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
        />
      ) : (
        <box key={`${index}:blank`} style={{ height: 1, flexShrink: 0 }} />
      ))}
      <OmittedLines theme={theme} count={preview.window.hidden} />
    </DetailRow>
  );
}

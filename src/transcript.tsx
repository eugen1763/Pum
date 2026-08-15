import {
  StyledText,
  TextAttributes,
  fg,
  type MarkdownRenderable,
  type SyntaxStyle,
} from "@opentui/core";
import type { MarkdownProps } from "@opentui/react";
import {
  useBlinkingText,
  useMarkdownCaret,
  useShimmerText,
  useSpinner,
} from "./animation";
import type { Theme } from "./theme";
import type { ToolCall } from "./tool-line";

export type Role = "user" | "assistant" | "thinking" | "system" | "error";

export type Line =
  | { kind: "text"; role: Role; text: string; newsId?: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "agent-message"; sender: string; recipient: string; text: string };

export type PendingLine = {
  id: string;
  line: Extract<Line, { kind: "text" | "agent-message" }>;
  /** Text used to match pi's message_start event. */
  deliveryText?: string;
  /** False when the queued user message has attachments that cannot be restored. */
  recallable?: boolean;
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

/** OpenTUI 0.5.1 supports Markdown selection at runtime but omits the React prop. */
function SelectableMarkdown({ ref, ...props }: MarkdownProps) {
  const setRef = (renderable: MarkdownRenderable | null) => {
    if (renderable) renderable.selectable = true;
    if (typeof ref === "function") ref(renderable);
    else if (ref) ref.current = renderable;
  };
  return <markdown {...props} ref={setRef} />;
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

type LineGroup = "tool" | "thinking" | "other";

const lineGroup = (line: Line): LineGroup => {
  if (line.kind === "tool") return "tool";
  return line.kind === "text" && line.role === "thinking" ? "thinking" : "other";
};

/** Exactly one gap around tool/thinking groups, but none inside either group. */
export function needsTranscriptGap(prev: Line | undefined, line: Line): boolean {
  if (!prev) return false;
  const prevGroup = lineGroup(prev);
  const group = lineGroup(line);

  if (prevGroup !== group && (prevGroup !== "other" || group !== "other")) return true;
  if (group !== "other") return false;

  // Preserve the normal turn layout for rows outside tool/thinking groups.
  const isUser = line.kind === "text" && line.role === "user";
  const prevIsUser = prev.kind === "text" && prev.role === "user";
  const isAnswer = line.kind === "text" && line.role === "assistant";
  const isAgentMessage = line.kind === "agent-message" || prev.kind === "agent-message";
  return isUser || prevIsUser || isAnswer || isAgentMessage;
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
  background,
  children,
}: {
  glyph: string;
  glyphColor: string;
  background?: string;
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
        {glyph.trim() ? <text content={glyph} fg={glyphColor} /> : null}
      </box>
      {/* The nested flex item gives every transcript type the same measured
          remaining-width column as the tool-row body. */}
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {children}
      </box>
    </box>
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
        content={workingCaret ? undefined : displayText}
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
  call,
  workingCaret = false,
}: {
  theme: Theme;
  call: ToolCall;
  workingCaret?: boolean;
}) {
  const spinner = useSpinner(call.state === "running");
  const failed = call.state === "error";
  const rejected = call.state === "rejected";
  const toolColor = failed ? theme.error : rejected ? theme.rejection : theme.tool;
  const argColor = failed ? theme.error : rejected ? theme.rejection : theme.toolArg;
  const detailColor = failed ? theme.error : rejected ? theme.rejection : theme.dim;

  const prefix = call.arg
    ? new StyledText([fg(toolColor)(call.name), fg(detailColor)(" · ")])
    : null;
  const bodyChunks = call.arg
    ? [fg(argColor)(call.arg)]
    : [fg(toolColor)(call.name)];
  if (call.detail && !rejected) bodyChunks.push(fg(detailColor)(`  ${call.detail}`));

  const caret = useBlinkingText({
    chunks: bodyChunks,
    contentKey: `${call.name}:${call.arg}:${call.state}:${call.detail ?? ""}`,
    caretColor: failed ? theme.error : rejected ? theme.rejection : theme.accent,
    active: workingCaret,
  });

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row glyph={GUTTER} glyphColor={toolColor}>
        <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          {prefix ? <text content={prefix} selectable style={{ flexShrink: 0 }} /> : null}
          <text
            ref={workingCaret ? caret : undefined}
            content={workingCaret ? undefined : new StyledText(bodyChunks)}
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
        <Row glyph={GUTTER} glyphColor={theme.rejection}>
          <text
            content={rejectedDetail(theme, call.detail)}
            selectable
            wrapMode="word"
            style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
          />
        </Row>
      ) : null}
    </box>
  );
}

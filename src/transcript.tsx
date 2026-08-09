import { StyledText, fg, type SyntaxStyle } from "@opentui/core";
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
  | { kind: "text"; role: Role; text: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "agent-message"; sender: string; recipient: string; text: string };

export type PendingLine = {
  id: string;
  line: Extract<Line, { kind: "text" | "agent-message" }>;
  /** Text used to match pi's message_start event. */
  deliveryText?: string;
  /** Pi inserted the message, but the active streamed message must finish first. */
  delivered?: boolean;
};

export type PendingTranscriptState = {
  lines: Line[];
  stream: { kind: "assistant" | "thinking"; text: string } | null;
  pending: PendingLine[];
};

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
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  role: Role;
  text: string;
  workingCaret?: boolean;
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
    return (
      <Row
        glyph={isUser ? PROMPT : GUTTER}
        glyphColor={color}
        background={isUser ? theme.userBg : undefined}
      >
        <markdown
          ref={isAssistant && workingCaret ? markdownCaret : undefined}
          content={isAssistant && workingCaret ? undefined : text}
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
        <markdown
          ref={markdown}
          streaming
          syntaxStyle={syntaxStyle}
          fg={color}
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}
        />
      ) : (
        <text
          ref={shimmer}
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
            wrapMode="word"
            style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
          />
          <markdown
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
      <markdown
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
          wrapMode="word"
          style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
        />
        <markdown
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
  if (call.detail) bodyChunks.push(fg(detailColor)(`  ${call.detail}`));

  const caret = useBlinkingText({
    chunks: bodyChunks,
    contentKey: `${call.name}:${call.arg}:${call.state}:${call.detail ?? ""}`,
    caretColor: failed ? theme.error : rejected ? theme.rejection : theme.accent,
    active: workingCaret,
  });

  return (
    <Row
      glyph={GUTTER}
      glyphColor={toolColor}
      background={rejected ? theme.rejectionBg : undefined}
    >
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {prefix ? <text content={prefix} style={{ flexShrink: 0 }} /> : null}
        <text
          ref={workingCaret ? caret : undefined}
          content={workingCaret ? undefined : new StyledText(bodyChunks)}
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
  );
}

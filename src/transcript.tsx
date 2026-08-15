import {
  StyledText,
  TextAttributes,
  fg,
  type MarkdownRenderable,
  type SyntaxStyle,
} from "@opentui/core";
import type { MarkdownProps } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
  useBlinkingText,
  useMarkdownCaret,
  useShimmerText,
  useSpinner,
} from "./animation";
import type { Theme } from "./theme";
import { bashOutputWindow, type ToolCall } from "./tool-line";
import type { TranscriptOutputMode } from "./transcript-output";
import type { DiffPreviewLine, PreviewLanguage, ToolResultPreview } from "./tool-preview";

export type Role = "user" | "assistant" | "thinking" | "system" | "error";

export type Line =
  | { kind: "text"; role: Role; text: string; newsId?: string }
  | { kind: "tool"; call: ToolCall }
  | { kind: "agent-message"; sender: string; recipient: string; text: string; messageId?: string };

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
        content={workingCaret ? "" : displayText}
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
const BASH_OUTPUT_DELAY_MS = 500;
const BASH_OUTPUT_MIN_VISIBLE_MS = 2_000;

function useBashOutputVisible(call: ToolCall): boolean {
  const initiallyVisible = call.name === "bash"
    && call.state === "running"
    && Boolean(call.output)
    && (call.startedAt === undefined || Date.now() - call.startedAt >= BASH_OUTPUT_DELAY_MS);
  const [visible, setVisible] = useState(initiallyVisible);
  const visibleSince = useRef<number | undefined>(initiallyVisible ? Date.now() : undefined);

  useEffect(() => {
    if (call.name !== "bash" || !call.output) {
      visibleSince.current = undefined;
      setVisible(false);
      return;
    }

    const show = () => {
      visibleSince.current ??= Date.now();
      setVisible(true);
    };

    if (call.state === "running") {
      if (call.startedAt === undefined) {
        show();
        return;
      }
      const delay = BASH_OUTPUT_DELAY_MS - (Date.now() - call.startedAt);
      if (delay <= 0) {
        show();
        return;
      }
      visibleSince.current = undefined;
      setVisible(false);
      const timer = setTimeout(show, delay);
      return () => clearTimeout(timer);
    }

    if (visibleSince.current === undefined) {
      if (call.startedAt === undefined || Date.now() - call.startedAt < BASH_OUTPUT_DELAY_MS) {
        setVisible(false);
        return;
      }
      show();
    }

    const remaining = BASH_OUTPUT_MIN_VISIBLE_MS - (Date.now() - visibleSince.current!);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [call.id, call.name, call.output, call.startedAt, call.state]);

  return visible;
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
  outputMode = "default",
}: {
  theme: Theme;
  syntaxStyle?: SyntaxStyle;
  call: ToolCall;
  workingCaret?: boolean;
  /** Detailed-mode renderers use this without changing canonical call data. */
  outputMode?: TranscriptOutputMode;
}) {
  const spinner = useSpinner(call.state === "running");
  const failed = call.state === "error";
  const rejected = call.state === "rejected";
  const bashOutputVisible = useBashOutputVisible(call);
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
  if (failed && call.name === "bash" && call.exitCode !== undefined) {
    bodyChunks.push(fg(detailColor)(` · exit ${call.exitCode}`));
  }

  const caret = useBlinkingText({
    chunks: bodyChunks,
    contentKey: `${call.name}:${call.arg}:${call.state}:${call.detail ?? ""}`,
    caretColor: failed ? theme.error : rejected ? theme.rejection : theme.accent,
    active: workingCaret,
  });
  const output = call.name === "bash" && call.output && bashOutputVisible
    && (call.state === "running" || outputMode !== "detailed")
    ? bashOutputWindow(call.output)
    : null;
  const detailedPreview = outputMode === "detailed"
    && call.state !== "running"
    && call.state !== "rejected"
    && call.preview
    && (call.state === "ok" || call.preview.kind === "bash")
    ? call.preview
    : undefined;

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row glyph={GUTTER} glyphColor={toolColor}>
        <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          {prefix ? <text content={prefix} selectable style={{ flexShrink: 0 }} /> : null}
          <text
            ref={workingCaret ? caret : undefined}
            content={workingCaret ? "" : new StyledText(bodyChunks)}
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
      {output && (output.hidden > 0 || output.lines.length > 0) ? (
        <Row glyph={GUTTER} glyphColor={theme.bashOutput}>
          <box style={{ width: call.arg ? Bun.stringWidth(`${call.name} · `) : 0, flexShrink: 0 }} />
          <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
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
          </box>
        </Row>
      ) : null}
      {detailedPreview ? (
        <DetailedToolPreview theme={theme} syntaxStyle={syntaxStyle} preview={detailedPreview} />
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

function PreviewSource({
  content,
  language,
  syntaxStyle,
  fallbackColor,
}: {
  content: string;
  language?: PreviewLanguage;
  syntaxStyle?: SyntaxStyle;
  fallbackColor: string;
}) {
  if (!content) return <box style={{ height: 1, flexShrink: 0 }} />;
  if (language && syntaxStyle) {
    return (
      <code
        content={content}
        filetype={language}
        syntaxStyle={syntaxStyle}
        selectable
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, width: "100%" }}
      />
    );
  }
  return (
    <text
      content={content}
      fg={fallbackColor}
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
      style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
    />
  );
}

/** Display-only detailed preview. The model-facing tool result stays unchanged. */
export function DetailedToolPreview({
  theme,
  syntaxStyle,
  preview,
}: {
  theme: Theme;
  syntaxStyle?: SyntaxStyle;
  preview: ToolResultPreview;
}) {
  if (preview.kind === "diff") {
    return (
      <Row glyph={GUTTER} glyphColor={theme.dim}>
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          {preview.lines.map((line, index) => {
            const color = previewColor(theme, line.kind);
            if (line.kind === "header") {
              return line.text ? (
                <text
                  key={`${index}:${line.text}`}
                  content={line.text}
                  fg={color}
                  selectable
                  wrapMode="word"
                  style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
                />
              ) : <box key={`${index}:blank`} style={{ height: 1, flexShrink: 0 }} />;
            }
            return (
              <box key={`${index}:${line.text}`} style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
                <box style={{ width: 1, flexShrink: 0 }}>
                  <text content={line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} fg={color} />
                </box>
                <PreviewSource
                  content={line.source}
                  language={line.language}
                  syntaxStyle={syntaxStyle}
                  fallbackColor={color}
                />
              </box>
            );
          })}
        </box>
      </Row>
    );
  }

  return (
    <Row glyph={GUTTER} glyphColor={theme.dim}>
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {preview.kind === "write" && preview.language && syntaxStyle ? (
          preview.window.lines.length > 0 ? (
            <code
              content={preview.window.lines.join("\n")}
              filetype={preview.language}
              syntaxStyle={syntaxStyle}
              selectable
              style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
            />
          ) : null
        ) : preview.window.lines.map((line, index) => line ? (
          <text
            key={`${index}:${line}`}
            content={line}
            fg={preview.kind === "bash" ? theme.bashOutput : theme.dim}
            selectable
            wrapMode="word"
            style={{ width: "100%", flexShrink: 1, minWidth: 0 }}
          />
        ) : (
          <box key={`${index}:blank`} style={{ height: 1, flexShrink: 0 }} />
        ))}
        <OmittedLines theme={theme} count={preview.window.hidden} />
      </box>
    </Row>
  );
}

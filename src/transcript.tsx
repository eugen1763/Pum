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
      {children}
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
  if (isAssistant) {
    return (
      <Row glyph={GUTTER} glyphColor={color}>
        <markdown
          ref={workingCaret ? markdownCaret : undefined}
          content={workingCaret ? undefined : text}
          syntaxStyle={syntaxStyle}
          fg={color}
          style={{ flexGrow: 1, minWidth: 0 }}
        />
      </Row>
    );
  }

  return (
    <Row
      glyph={isUser ? PROMPT : GUTTER}
      glyphColor={color}
      background={isUser ? theme.userBg : undefined}
    >
      <text
        ref={workingCaret ? textCaret : undefined}
        content={workingCaret ? undefined : displayText}
        fg={color}
        wrapMode="word"
        style={{ flexGrow: 1, minWidth: 0 }}
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
          style={{ flexGrow: 1, minWidth: 0 }}
        />
      ) : (
        <text ref={shimmer} wrapMode="word" style={{ flexGrow: 1, minWidth: 0 }} />
      )}
    </Row>
  );
}

export function AgentMessageLine({ theme, line }: { theme: Theme; line: Extract<Line, { kind: "agent-message" }> }) {
  return (
    <Row glyph="◇ " glyphColor={theme.agentMessage} background={theme.agentMessageBg}>
      <box style={{ flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
        <text content={`${line.sender} → ${line.recipient}`} fg={theme.agentMessage} />
        <text
          content={line.text}
          fg={theme.agentMessage}
          wrapMode="word"
          style={{ flexGrow: 1, minWidth: 0 }}
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
  const toolColor = failed ? theme.error : rejected ? theme.warn : theme.tool;
  const argColor = failed ? theme.error : rejected ? theme.warn : theme.toolArg;
  const detailColor = failed ? theme.error : rejected ? theme.warn : theme.dim;

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
    caretColor: failed ? theme.error : rejected ? theme.warn : theme.accent,
    active: workingCaret,
  });

  return (
    <Row glyph={GUTTER} glyphColor={toolColor}>
      <box style={{ flexDirection: "row", flexGrow: 1, minWidth: 0 }}>
        {prefix ? <text content={prefix} style={{ flexShrink: 0 }} /> : null}
        <text
          ref={workingCaret ? caret : undefined}
          content={workingCaret ? undefined : new StyledText(bodyChunks)}
          wrapMode="word"
          style={{ flexGrow: 1, minWidth: 0 }}
        />
      </box>
      <box style={{ width: 1, flexShrink: 0 }} />
      <box style={{ width: 1, flexShrink: 0 }}>
        {call.state === "running" ? (
          <text ref={spinner} fg={theme.accent} />
        ) : (
          <text
            content={toolStateGlyph(call.state)}
            fg={call.state === "ok" ? theme.success : call.state === "rejected" ? theme.warn : theme.error}
          />
        )}
      </box>
    </Row>
  );
}

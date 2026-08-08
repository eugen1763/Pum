import { StyledText, fg, type SyntaxStyle } from "@opentui/core";
import { useShimmerText, useSpinner } from "./animation";
import type { Theme } from "./theme";
import type { ToolCall } from "./tool-line";

export type Role = "user" | "assistant" | "thinking" | "system" | "error";

export type Line =
  | { kind: "text"; role: Role; text: string }
  | { kind: "tool"; call: ToolCall };

const GUTTER = "  ";
const PROMPT = "❯ ";

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
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  role: Role;
  text: string;
}) {
  const color = roleColor(theme, role);
  const isUser = role === "user";

  // Only a finished answer is rendered as markdown. Prompts are shown as
  // typed, and thinking, tool and error lines are not markdown to begin with.
  if (role === "assistant") {
    return (
      <Row glyph={GUTTER} glyphColor={color}>
        <markdown
          content={text}
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
      <text content={text} fg={color} wrapMode="word" style={{ flexGrow: 1, minWidth: 0 }} />
    </Row>
  );
}

/** The line currently streaming in: shimmered, with a caret riding the end. */
export function StreamLine({
  theme,
  role,
  text,
}: {
  theme: Theme;
  role: "assistant" | "thinking";
  text: string;
}) {
  const color = roleColor(theme, role);
  const ref = useShimmerText({
    text,
    color,
    highlight: theme.highlight,
    active: true,
    caret: true,
  });
  return (
    <Row glyph={GUTTER} glyphColor={color}>
      <text ref={ref} wrapMode="word" style={{ flexGrow: 1, minWidth: 0 }} />
    </Row>
  );
}

export function ToolLine({ theme, call }: { theme: Theme; call: ToolCall }) {
  const spinner = useSpinner(call.state === "running");

  const chunks = [fg(theme.tool)(`⚒ ${call.name}`)];
  if (call.arg) {
    chunks.push(fg(theme.dim)(" · "), fg(theme.toolArg)(call.arg));
  }
  if (call.detail) {
    chunks.push(fg(theme.dim)(`  ${call.detail}`));
  }

  return (
    <Row glyph={GUTTER} glyphColor={theme.tool}>
      <text content={new StyledText(chunks)} style={{ flexGrow: 1 }} />
      <text content=" " />
      {call.state === "running" ? (
        <text ref={spinner} fg={theme.accent} />
      ) : (
        <text
          content={call.state === "ok" ? "✓" : "✗"}
          fg={call.state === "ok" ? theme.success : theme.error}
        />
      )}
    </Row>
  );
}

import type { Theme } from "./theme";
import { PopupFrame } from "./popup-frame";
import { chartBarWidths, type SessionStatsSnapshot, type ToolOutcome } from "./session-stats";
import { formatCost, formatTokens } from "./status-metadata";

export type StatsLine = { text: string; tone: "fg" | "dim" | "accent" | "success" | "error" | "blocked" | "warn" };

export function statsPopupGeometry(width: number, height: number) {
  const compact = width < 58 || height < 18;
  const marginX = width < 4 ? 0 : compact ? 1 : Math.max(2, Math.floor(width * 0.06));
  const marginY = height < 4 ? 0 : compact ? 1 : Math.max(1, Math.floor(height * 0.07));
  const popupWidth = Math.max(1, width - marginX * 2);
  const popupHeight = Math.max(1, height - marginY * 2);
  // Reserve the header, footer, and the frame rows. OpenTUI can retain frame
  // rows in very short surfaces even when the compact border is disabled.
  const chrome = 4;
  return {
    compact,
    left: marginX,
    top: marginY,
    width: popupWidth,
    height: popupHeight,
    pageSize: Math.max(1, popupHeight - chrome),
  };
}

function metric(value: number | null, kind: "tokens" | "cost" | "count" = "count"): string {
  if (value === null) return "—";
  if (kind === "tokens") return formatTokens(value);
  if (kind === "cost") return formatCost(value);
  return value.toLocaleString();
}

function fit(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  if (width <= 1) return "…".slice(0, width);
  let result = "";
  for (const char of text) {
    if (Bun.stringWidth(result + char + "…") > width) break;
    result += char;
  }
  return `${result}…`;
}

const OUTCOME_LABELS: Array<[ToolOutcome, string, StatsLine["tone"]]> = [
  ["successful", "Successful", "success"],
  ["failed", "Failed", "error"],
  ["blocked", "Blocked", "blocked"],
  ["runningInterrupted", "Running/Interrupted", "warn"],
];

export function statsLines(snapshot: SessionStatsSnapshot, width: number): StatsLine[] {
  const contentWidth = Math.max(1, width);
  const lines: StatsLine[] = [{ text: "Models", tone: "accent" }];
  if (snapshot.models.length === 0) lines.push({ text: "No model activity.", tone: "dim" });
  else if (contentWidth >= 86) {
    const modelWidth = Math.max(18, contentWidth - 66);
    lines.push({
      text: `${"Model / role".padEnd(modelWidth)} ${"Req".padStart(5)} ${"Up".padStart(9)} ${"Down".padStart(9)} ${"Cache".padStart(9)} ${"Cost".padStart(9)} ${"Cmp".padStart(5)}`,
      tone: "dim",
    });
    for (const row of snapshot.models) {
      const label = fit(`${row.model} · ${row.role}`, modelWidth).padEnd(modelWidth);
      lines.push({
        text: `${label} ${metric(row.attempts).padStart(5)} ${metric(row.outgoing, "tokens").padStart(9)} ${metric(row.incoming, "tokens").padStart(9)} ${metric(row.cacheRead, "tokens").padStart(9)} ${metric(row.cost, "cost").padStart(9)} ${metric(row.compressions).padStart(5)}`,
        tone: row.role === "Check" ? "warn" : "fg",
      });
    }
  } else {
    for (const row of snapshot.models) {
      lines.push({ text: fit(`${row.model} · ${row.role}`, contentWidth), tone: row.role === "Check" ? "warn" : "fg" });
      const detail = contentWidth >= 48
        ? `  req ${metric(row.attempts)}  up ${metric(row.outgoing, "tokens")}  down ${metric(row.incoming, "tokens")}  cache ${metric(row.cacheRead, "tokens")}  ${metric(row.cost, "cost")}  cmp ${metric(row.compressions)}`
        : `  r ${metric(row.attempts)} ↑${metric(row.outgoing, "tokens")} ↓${metric(row.incoming, "tokens")} c${metric(row.cacheRead, "tokens")} ${metric(row.cost, "cost")} x${metric(row.compressions)}`;
      lines.push({ text: fit(detail, contentWidth), tone: "dim" });
    }
  }

  lines.push({ text: "", tone: "dim" }, { text: "Tool outcomes", tone: "accent" });
  const chartLabelWidth = contentWidth >= 50 ? 20 : 10;
  const barWidth = Math.max(1, contentWidth - chartLabelWidth - 8);
  const bars = chartBarWidths(snapshot.outcomes, barWidth);
  for (const [outcome, label, tone] of OUTCOME_LABELS) {
    const short = contentWidth < 50 ? label.replace("Running/Interrupted", "Run/Int") : label;
    lines.push({
      text: `${short.padEnd(chartLabelWidth)} ${"█".repeat(bars[outcome])} ${snapshot.outcomes[outcome]}`,
      tone,
    });
  }

  lines.push({ text: "", tone: "dim" });
  if (snapshot.tools.length === 0) lines.push({ text: "No tool calls.", tone: "dim" });
  else if (contentWidth >= 72) {
    const toolWidth = Math.max(12, contentWidth - 48);
    lines.push({ text: `${"Tool".padEnd(toolWidth)} ${"Successful".padStart(10)} ${"Failed".padStart(7)} ${"Blocked".padStart(8)} ${"Run/Int".padStart(8)} ${"Total".padStart(6)}`, tone: "dim" });
    for (const row of snapshot.tools) {
      lines.push({
        text: `${fit(row.tool, toolWidth).padEnd(toolWidth)} ${String(row.successful).padStart(10)} ${String(row.failed).padStart(7)} ${String(row.blocked).padStart(8)} ${String(row.runningInterrupted).padStart(8)} ${String(row.total).padStart(6)}`,
        tone: "fg",
      });
    }
  } else {
    for (const row of snapshot.tools) {
      lines.push({
        text: fit(`${row.tool}  ok ${row.successful}  fail ${row.failed}  block ${row.blocked}  run/int ${row.runningInterrupted}  total ${row.total}`, contentWidth),
        tone: "fg",
      });
    }
  }
  return lines;
}

export function maxStatsScrollOffset(snapshot: SessionStatsSnapshot, width: number, height: number): number {
  const geometry = statsPopupGeometry(width, height);
  const innerWidth = Math.max(1, geometry.width - (geometry.compact ? 0 : 4));
  return Math.max(0, statsLines(snapshot, innerWidth).length - geometry.pageSize);
}

export function StatsPopup({
  theme,
  snapshot,
  terminalWidth,
  terminalHeight,
  scrollOffset,
}: {
  theme: Theme;
  snapshot: SessionStatsSnapshot;
  terminalWidth: number;
  terminalHeight: number;
  scrollOffset: number;
}) {
  const geometry = statsPopupGeometry(terminalWidth, terminalHeight);
  const innerWidth = Math.max(1, geometry.width - (geometry.compact ? 0 : 4));
  const lines = statsLines(snapshot, innerWidth);
  const visible = lines.slice(scrollOffset, scrollOffset + geometry.pageSize);
  const color = (tone: StatsLine["tone"]): string => tone === "fg" ? theme.fg
    : tone === "accent" ? theme.accent
      : tone === "success" ? theme.success
        : tone === "error" ? theme.error
          : tone === "blocked" ? theme.rejection
            : tone === "warn" ? theme.warn
              : theme.dim;
  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={geometry}
      zIndex={105}
      title={geometry.compact ? undefined : " Session statistics "}
      border={!geometry.compact}
      padding={geometry.compact ? 0 : 1}
    >
      {geometry.compact ? <text content="Session statistics" fg={theme.accent} bg={theme.popupBg} style={{ height: 1, flexShrink: 0 }} /> : null}
      <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 1, overflow: "hidden" }}>
        {visible.map((line, index) => (
          <text
            key={`${scrollOffset + index}:${line.text}`}
            content={line.text}
            fg={color(line.tone)}
            bg={theme.popupBg}
            wrapMode="none"
            style={{ width: "100%", height: 1, flexShrink: 0 }}
          />
        ))}
      </box>
      <text
        content="↑↓ scroll  pgup/pgdn  home/end  esc close"
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ width: "100%", height: 1, flexShrink: 0 }}
      />
    </PopupFrame>
  );
}

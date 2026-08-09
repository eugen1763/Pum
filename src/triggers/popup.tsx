import type { Theme } from "../theme";

export type TriggerState =
  | "idle"
  | "running"
  | "paused"
  | "waiting"
  | "expired"
  | "cancelled"
  | "unavailable";

export type TriggerOutputMetadata = {
  path: string;
  bytes: number;
  truncated: boolean;
  exists: boolean;
};

export type TriggerSnapshot = {
  id: string;
  name: string;
  state: TriggerState;
  target: { sessionId: string; agentId: string | null; label: string };
  executable: string;
  args: string[];
  cwd: string;
  mode: "once" | "repeat";
  restartDelayMs: number | null;
  createdAt: number;
  expiresAt: number;
  nextRestartAt: number | null;
  fireCount: number;
  maxFires: number;
  pendingCount: number;
  coalescedCount: number;
  output?: TriggerOutputMetadata;
  lastResult?: {
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    exitCode: number | null;
    signal: string | null;
    synthetic: boolean;
    manual: boolean;
    output?: TriggerOutputMetadata;
  };
  paused: boolean;
};

/** Kept structural so the trigger runtime can integrate without a shared class. */
export type TriggerManagerLike = {
  subscribe: (listener: () => void) => () => void;
  getTriggers: () => TriggerSnapshot[];
  pause: (id: string) => Promise<unknown> | unknown;
  resume: (id: string) => Promise<unknown> | unknown;
  invoke: (id: string, mode: "run" | "fire") => Promise<unknown> | unknown;
  cancel: (id: string) => Promise<unknown> | unknown;
};

export type TriggerAction = "pause" | "resume" | "run" | "fire" | "cancel";

export function sortTriggers(triggers: readonly TriggerSnapshot[]): TriggerSnapshot[] {
  return triggers
    .map((trigger, index) => ({ trigger, index }))
    .sort((a, b) => a.trigger.createdAt - b.trigger.createdAt || a.index - b.index)
    .map(({ trigger }) => trigger);
}

export function moveTriggerSelection(current: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

export function triggerActionForKey(
  key: { name: string; sequence?: string },
  trigger?: TriggerSnapshot,
): TriggerAction | null {
  if (key.name === "p" || key.sequence === "p") {
    return trigger?.paused || trigger?.state === "paused" ? "resume" : "pause";
  }
  if (key.name === "r" || key.sequence === "r") return "run";
  if (key.name === "f" || key.sequence === "f") return "fire";
  if (key.name === "c" || key.sequence === "c") return "cancel";
  return null;
}

export function triggerPopupGeometry(width: number, height: number) {
  const compact = width < 48 || height < 18;
  const marginX = width < 4 ? 0 : compact ? 1 : Math.max(2, Math.floor(width * 0.08));
  const marginY = height < 4 ? 0 : compact ? 1 : Math.max(1, Math.floor(height * 0.08));
  return {
    compact,
    left: marginX,
    top: marginY,
    width: Math.max(1, width - marginX * 2),
    height: Math.max(1, height - marginY * 2),
  };
}

function timeText(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleString();
}

export function triggerFields(trigger: TriggerSnapshot): Array<[string, string]> {
  const command = [trigger.executable, ...trigger.args].join(" ");
  return [
    ["State", trigger.state],
    ["Target", trigger.target.label],
    ["Command", command],
    ["Directory", trigger.cwd],
    ["Mode", trigger.mode],
    ["Fires", `${trigger.fireCount}/${trigger.maxFires}`],
    ["Pending", `${trigger.pendingCount} (${trigger.coalescedCount} coalesced)`],
    ["Created", timeText(trigger.createdAt)],
    ["Expires", timeText(trigger.expiresAt)],
  ];
}

function TriggerRow({
  trigger,
  index,
  selected,
  theme,
}: {
  trigger: TriggerSnapshot;
  index: number;
  selected: boolean;
  theme: Theme;
}) {
  const statusColor = trigger.state === "running"
    ? theme.warn
    : trigger.state === "paused" || trigger.state === "cancelled" || trigger.state === "expired"
      ? theme.dim
      : trigger.state === "unavailable"
        ? theme.error
        : theme.success;
  return (
    <box
      id={`trigger-row-${index}`}
      style={{
        width: "100%",
        flexDirection: "row",
        height: 1,
        flexShrink: 0,
        backgroundColor: selected ? theme.selectionBg : theme.popupBg,
      }}
    >
      <box style={{ width: 2, height: 1, flexShrink: 0 }}>
        {selected ? <text content="› " fg={theme.accent} bg={theme.selectionBg} /> : null}
      </box>
      <text
        content={trigger.name || trigger.id}
        fg={selected ? theme.fg : theme.dim}
        bg={selected ? theme.selectionBg : theme.popupBg}
        wrapMode="none"
        style={{ flexGrow: 1, minWidth: 0, height: 1 }}
      />
      <text
        content={` ${trigger.state} `}
        fg={statusColor}
        bg={selected ? theme.selectionBg : theme.popupBg}
        wrapMode="none"
        style={{ flexShrink: 0, height: 1 }}
      />
      <box style={{ width: 1, height: 1, flexShrink: 0 }} />
    </box>
  );
}

export function TriggersPopup({
  theme,
  triggers,
  cursor,
  terminalWidth,
  terminalHeight,
}: {
  theme: Theme;
  triggers: readonly TriggerSnapshot[];
  cursor: number;
  terminalWidth: number;
  terminalHeight: number;
}) {
  const geometry = triggerPopupGeometry(terminalWidth, terminalHeight);
  const trigger = triggers[cursor];
  const detailVisible = !geometry.compact;

  return (
    <box
      title={geometry.compact ? undefined : " External triggers "}
      style={{
        position: "absolute",
        top: geometry.top,
        left: geometry.left,
        width: geometry.width,
        height: geometry.height,
        zIndex: 110,
        border: !geometry.compact,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: geometry.compact ? 0 : 1,
      }}
    >
      {geometry.compact ? (
        <text content="External triggers" fg={theme.accent} bg={theme.popupBg} style={{ height: 1, flexShrink: 0 }} />
      ) : null}
      <scrollbox
        style={{ flexGrow: 1, minHeight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
        renderBefore={function () {
          if (triggers.length > 0) this.scrollChildIntoView(`trigger-row-${cursor}`);
        }}
      >
        <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
          {triggers.length ? triggers.map((item, index) => (
            <TriggerRow
              key={item.id}
              trigger={item}
              index={index}
              selected={index === cursor}
              theme={theme}
            />
          )) : (
            <text content="No external triggers." fg={theme.dim} bg={theme.popupBg} />
          )}
        </box>
      </scrollbox>
      {detailVisible && trigger ? (
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: geometry.compact ? 0 : 1 }}>
          <text content={trigger.name || trigger.id} fg={theme.accent} bg={theme.popupBg} wrapMode="none" />
          {triggerFields(trigger).map(([label, value]) => (
            <box key={label} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
              <box style={{ width: 10, height: 1, flexShrink: 0 }}>
                <text content={label} fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
              </box>
              <text content={value} fg={theme.fg} bg={theme.popupBg} wrapMode="none" style={{ flexGrow: 1, minWidth: 0 }} />
            </box>
          ))}
        </box>
      ) : null}
      <text
        content={geometry.compact
          ? "↑↓ select  p pause/resume  r run  f fire  c cancel  esc close"
          : "↑↓ select   p pause/resume   r run   f fire   c cancel   esc close"}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ width: "100%", height: 1, flexShrink: 0 }}
      />
    </box>
  );
}

import type { Theme } from "./theme";
import { PopupFrame } from "./popup-frame";
import type {
  PublicShellManager,
  ShellSnapshot,
} from "./shells/types";
import {
  displayTriggerCommand,
  triggerFields,
  triggerPopupGeometry,
  type TriggerSnapshot,
} from "./triggers/popup";

export type ProcessTab = "triggers" | "shells";
export type ManagedShellSnapshot = ShellSnapshot;

/** Process-local UI access intentionally omits requester arguments. */
export type ShellManagerLike = Pick<
  PublicShellManager,
  "subscribe" | "list" | "inspect" | "getOutput" | "terminate"
>;

export function sortShells(shells: readonly ManagedShellSnapshot[]): ManagedShellSnapshot[] {
  return shells
    .map((shell, index) => ({ shell, index }))
    .sort((a, b) => a.shell.createdAt - b.shell.createdAt || a.index - b.index)
    .map(({ shell }) => shell);
}

export function moveProcessSelection(current: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

export function processTabForKey(
  key: { name: string; sequence?: string; shift?: boolean },
  current: ProcessTab,
): ProcessTab | null {
  if (key.name === "left") return "triggers";
  if (key.name === "right") return "shells";
  if (key.name === "tab") return current === "triggers" ? "shells" : "triggers";
  return null;
}

function durationText(startedAt?: number | null, finishedAt?: number | null): string {
  if (startedAt == null) return "—";
  const duration = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  if (duration < 1_000) return `${duration}ms`;
  return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`;
}

function timeText(value?: number | null): string {
  return value == null ? "—" : new Date(value).toLocaleString();
}

export function displayShellCommand(shell: ManagedShellSnapshot): string {
  return displayTriggerCommand(shell);
}

export function shellFields(shell: ManagedShellSnapshot): Array<[string, string]> {
  const output = `${shell.output.bytes} bytes${shell.output.truncated ? " · truncated" : ""}${shell.output.exists ? "" : " · cleaned"}`;
  const result = shell.exitCode != null
    ? `exit ${shell.exitCode}`
    : shell.signal
      ? `signal ${shell.signal}`
      : "—";
  return [
    ["State", shell.state],
    ["Owner", shell.owner.label],
    ["Command", displayShellCommand(shell)],
    ["Directory", shell.cwd],
    ["Runtime", durationText(shell.startedAt, shell.finishedAt)],
    ["Ready", shell.ready ? timeText(shell.readyAt) : "no"],
    ["Created", timeText(shell.createdAt)],
    ["Finished", timeText(shell.finishedAt)],
    ["Result", result],
    ["Output", output],
  ];
}

function statusColor(state: string, theme: Theme): string {
  if (state === "running" || state === "starting") return theme.warn;
  if (state === "failed" || state === "unavailable") return theme.error;
  if (state === "exited" || state === "idle" || state === "waiting") return theme.success;
  return theme.dim;
}

function ProcessRow({
  id,
  label,
  state,
  index,
  selected,
  theme,
}: {
  id: string;
  label: string;
  state: string;
  index: number;
  selected: boolean;
  theme: Theme;
}) {
  return (
    <box
      id={`process-row-${id}-${index}`}
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
        content={label}
        fg={selected ? theme.fg : theme.dim}
        bg={selected ? theme.selectionBg : theme.popupBg}
        wrapMode="none"
        style={{ flexGrow: 1, minWidth: 0, height: 1 }}
      />
      <text
        content={` ${state} `}
        fg={statusColor(state, theme)}
        bg={selected ? theme.selectionBg : theme.popupBg}
        wrapMode="none"
        style={{ flexShrink: 0, height: 1 }}
      />
      <box style={{ width: 1, height: 1, flexShrink: 0 }} />
    </box>
  );
}

function Tabs({ theme, active }: { theme: Theme; active: ProcessTab }) {
  return (
    <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
      <text
        content=" Triggers "
        fg={active === "triggers" ? theme.fg : theme.dim}
        bg={active === "triggers" ? theme.selectionBg : theme.popupBg}
      />
      <text content=" " bg={theme.popupBg} />
      <text
        content=" Shells "
        fg={active === "shells" ? theme.fg : theme.dim}
        bg={active === "shells" ? theme.selectionBg : theme.popupBg}
      />
    </box>
  );
}

export function ProcessesPopup({
  theme,
  tab,
  triggers,
  shells,
  triggerCursor,
  shellCursor,
  shellTail,
  terminalWidth,
  terminalHeight,
}: {
  theme: Theme;
  tab: ProcessTab;
  triggers: readonly TriggerSnapshot[];
  shells: readonly ManagedShellSnapshot[];
  triggerCursor: number;
  shellCursor: number;
  shellTail?: string;
  terminalWidth: number;
  terminalHeight: number;
}) {
  const geometry = triggerPopupGeometry(terminalWidth, terminalHeight);
  const trigger = triggers[triggerCursor];
  const shell = shells[shellCursor];
  const items = tab === "triggers" ? triggers : shells;
  const cursor = tab === "triggers" ? triggerCursor : shellCursor;
  const detailVisible = !geometry.compact;

  return (
    <PopupFrame
      theme={theme}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      geometry={geometry}
      zIndex={110}
      title={geometry.compact ? undefined : " Processes "}
      border={!geometry.compact}
      padding={geometry.compact ? 0 : 1}
    >
      {geometry.compact ? (
        <text content="Processes" fg={theme.accent} bg={theme.popupBg} style={{ height: 1, flexShrink: 0 }} />
      ) : null}
      <Tabs theme={theme} active={tab} />
      <scrollbox
        style={{ flexGrow: 1, minHeight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
        renderBefore={function () {
          const selected = items[cursor];
          if (selected) this.scrollChildIntoView(`process-row-${selected.id}-${cursor}`);
        }}
      >
        <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
          {items.length ? items.map((item, index) => (
            <ProcessRow
              key={item.id}
              id={item.id}
              label={"target" in item ? item.name || item.id : item.name || item.id}
              state={item.state}
              index={index}
              selected={index === cursor}
              theme={theme}
            />
          )) : (
            <text
              content={tab === "triggers" ? "No external triggers." : "No managed shells."}
              fg={theme.dim}
              bg={theme.popupBg}
            />
          )}
        </box>
      </scrollbox>
      {detailVisible && tab === "triggers" && trigger ? (
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
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
      {detailVisible && tab === "shells" && shell ? (
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
          <text content={shell.name || shell.id} fg={theme.accent} bg={theme.popupBg} wrapMode="none" />
          {shellFields(shell).map(([label, value]) => (
            <box key={label} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
              <box style={{ width: 10, height: 1, flexShrink: 0 }}>
                <text content={label} fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
              </box>
              <text content={value} fg={theme.fg} bg={theme.popupBg} wrapMode="none" style={{ flexGrow: 1, minWidth: 0 }} />
            </box>
          ))}
          <text content="Tail" fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
          <text
            content={shellTail?.trimEnd() || "—"}
            fg={theme.bashOutput}
            bg={theme.popupBg}
            wrapMode="word"
            style={{ maxHeight: 4, flexShrink: 0 }}
          />
        </box>
      ) : null}
      <text
        content={tab === "triggers"
          ? "←→/tab switch   ↑↓ select   p pause/resume   r run   c cancel   esc close"
          : "←→/tab switch   ↑↓ select   k kill   esc close"}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ width: "100%", height: 1, flexShrink: 0 }}
      />
    </PopupFrame>
  );
}

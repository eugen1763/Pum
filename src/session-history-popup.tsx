import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { Theme } from "./theme";

function optionFor(session: SessionInfo) {
  const title = session.name || session.firstMessage || "(empty session)";
  const modified = session.modified.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    name: title.replace(/\s+/g, " ").slice(0, 80),
    description: `${modified} · ${session.messageCount} messages`,
    value: session.path,
  };
}

export function SessionHistoryPopup({
  theme,
  sessions,
  onSelect,
}: {
  theme: Theme;
  sessions: readonly SessionInfo[];
  onSelect: (path: string) => void;
}) {
  return (
    <box
      title=" Session history "
      style={{
        position: "absolute",
        top: "10%",
        left: "10%",
        width: "80%",
        height: "80%",
        zIndex: 100,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: 1,
      }}
    >
      {sessions.length > 0 ? (
        <select
          focused
          backgroundColor={theme.popupBg}
          focusedBackgroundColor={theme.popupBg}
          selectedBackgroundColor={theme.popupBg}
          style={{ flexGrow: 1 }}
          options={sessions.map(optionFor)}
          onSelect={(_index, option) => {
            if (option) onSelect(option.value as string);
          }}
        />
      ) : (
        <text content="No saved sessions for this directory." fg={theme.dim} bg={theme.popupBg} />
      )}
      <text
        content="↑↓ select   enter open   esc close"
        fg={theme.dim}
        bg={theme.popupBg}
        style={{ flexShrink: 0 }}
      />
    </box>
  );
}

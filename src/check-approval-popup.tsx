import type { Theme } from "./theme";

export type CheckApprovalDecision =
  | "allowOnce"
  | "allowSession"
  | "allowProject"
  | "deny";

export type CheckApprovalPreview = {
  kind: "command" | "diff";
  /** Redacted display text. Never pass raw tool arguments or credentials. */
  text: string;
};

export type PendingCheckApproval = {
  tool: string;
  summary: string;
  reason: string;
  paths: readonly string[];
  preview: CheckApprovalPreview;
  agentLabel: string;
};

export type CheckApprovalPopupProps = {
  theme: Theme;
  request: PendingCheckApproval;
  selectedDecision: CheckApprovalDecision;
  terminalWidth: number;
  terminalHeight: number;
  onAllowOnce: () => void;
  onAllowSession: () => void;
  onAllowProject: () => void;
  onDeny: () => void;
};

export type CheckApprovalLayout = {
  narrow: boolean;
  short: boolean;
  margin: number;
  popupWidth: number;
  popupHeight: number;
  optionColumns: 1 | 2 | 4;
  detailHeight: number;
};

const OPTIONS: readonly {
  id: CheckApprovalDecision;
  label: string;
  compactLabel: string;
}[] = [
  { id: "allowOnce", label: "Allow once", compactLabel: "Once" },
  { id: "allowSession", label: "Allow for session", compactLabel: "Session" },
  { id: "allowProject", label: "Allow for project", compactLabel: "Project" },
  { id: "deny", label: "Deny", compactLabel: "Deny" },
];

export function checkApprovalLayout(
  terminalWidth: number,
  terminalHeight: number,
): CheckApprovalLayout {
  const narrow = terminalWidth < 64;
  const short = terminalHeight < 18;
  const margin = terminalWidth < 3
    ? 0
    : narrow ? 1 : Math.max(2, Math.floor(terminalWidth * 0.1));
  const popupWidth = Math.max(1, terminalWidth - margin * 2);
  const desiredHeight = short ? 12 : 22;
  const popupHeight = Math.max(1, Math.min(terminalHeight, desiredHeight));
  const optionColumns: 1 | 2 | 4 = short ? 2 : narrow ? 1 : 4;
  const optionRows = Math.ceil(OPTIONS.length / optionColumns);
  // Four rows are the border and padding. Three rows hold identity, summary, and footer.
  const detailHeight = Math.max(0, popupHeight - 4 - 3 - optionRows);
  return { narrow, short, margin, popupWidth, popupHeight, optionColumns, detailHeight };
}

export function invokeCheckApprovalDecision(
  decision: CheckApprovalDecision,
  callbacks: Pick<
    CheckApprovalPopupProps,
    "onAllowOnce" | "onAllowSession" | "onAllowProject" | "onDeny"
  >,
): void {
  if (decision === "allowOnce") callbacks.onAllowOnce();
  else if (decision === "allowSession") callbacks.onAllowSession();
  else if (decision === "allowProject") callbacks.onAllowProject();
  else callbacks.onDeny();
}

function ApprovalOption({
  theme,
  id,
  label,
  selected,
  onChoose,
}: {
  theme: Theme;
  id: CheckApprovalDecision;
  label: string;
  selected: boolean;
  onChoose: (decision: CheckApprovalDecision) => void;
}) {
  const background = selected ? theme.selectionBg : theme.popupBg;
  return (
    <box
      style={{
        height: 1,
        flexGrow: 1,
        minWidth: 0,
        flexShrink: 0,
        backgroundColor: background,
      }}
      onMouseDown={() => onChoose(id)}
    >
      <text
        content={`${selected ? "› " : "  "}${label}`}
        fg={id === "deny" ? theme.error : selected ? theme.accent : theme.fg}
        bg={background}
        wrapMode="none"
      />
    </box>
  );
}

/**
 * This component owns layout only. The parent owns keyboard navigation and
 * calls the same explicit decision callbacks used by mouse selection.
 */
export function CheckApprovalPopup(props: CheckApprovalPopupProps) {
  const {
    theme,
    request,
    selectedDecision,
    terminalWidth,
    terminalHeight,
  } = props;
  const layout = checkApprovalLayout(terminalWidth, terminalHeight);
  const optionRows = Array.from(
    { length: Math.ceil(OPTIONS.length / layout.optionColumns) },
    (_, row) => OPTIONS.slice(
      row * layout.optionColumns,
      (row + 1) * layout.optionColumns,
    ),
  );
  const choose = (decision: CheckApprovalDecision) =>
    invokeCheckApprovalDecision(decision, props);
  const pathText = request.paths.length > 0
    ? request.paths.join(" · ")
    : "No project paths reported";
  const previewLabel = request.preview.kind === "command" ? "Command" : "Diff";

  return (
    <box
      title=" Approval required "
      style={{
        position: "absolute",
        top: Math.max(0, Math.floor((terminalHeight - layout.popupHeight) / 2)),
        left: layout.margin,
        width: layout.popupWidth,
        height: layout.popupHeight,
        zIndex: 140,
        border: true,
        borderColor: theme.warn,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text content={request.tool} fg={theme.warn} bg={theme.popupBg} wrapMode="none" />
        <text content={` · ${request.agentLabel}`} fg={theme.dim} bg={theme.popupBg} wrapMode="none" />
      </box>
      <text
        content={request.summary}
        fg={theme.fg}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ height: 1, flexShrink: 0 }}
      />
      {layout.detailHeight > 0 ? (
        <scrollbox
          style={{ height: layout.detailHeight, flexShrink: 0 }}
          verticalScrollbarOptions={{ visible: true }}
        >
          <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
            <text content={`Reason: ${request.reason}`} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
            <text content={`Paths: ${pathText}`} fg={theme.toolArg} bg={theme.popupBg} wrapMode="word" />
            <box style={{ height: 1, flexShrink: 0 }} />
            <text content={previewLabel} fg={theme.dim} bg={theme.popupBg} />
            <text
              content={request.preview.text}
              fg={theme.toolArg}
              bg={theme.popupBg}
              selectable
              wrapMode="word"
            />
          </box>
        </scrollbox>
      ) : null}
      <box style={{ flexGrow: 1, minHeight: 0 }} />
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        {optionRows.map((row, rowIndex) => (
          <box key={rowIndex} style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            {row.map((option) => (
              <ApprovalOption
                key={option.id}
                theme={theme}
                id={option.id}
                label={layout.optionColumns === 4 ? option.compactLabel : option.label}
                selected={selectedDecision === option.id}
                onChoose={choose}
              />
            ))}
          </box>
        ))}
      </box>
      <text
        content={layout.narrow ? "↑↓ move  enter choose  esc deny" : "←→ move   enter choose   esc deny"}
        fg={theme.dim}
        bg={theme.popupBg}
        wrapMode="none"
        style={{ height: 1, flexShrink: 0 }}
      />
    </box>
  );
}

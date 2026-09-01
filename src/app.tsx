import {
  decodePasteBytes,
  stripAnsiSequences,
  type PasteEvent,
  type ScrollBoxRenderable,
  type SyntaxStyle,
  type TextareaRenderable,
} from "@opentui/core";
import { randomUUID } from "node:crypto";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, BashOperations, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Component, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AnimationProvider,
  PlaceholderWave,
  supportsTrueColor,
  useWorkingRule,
  type WorkingRuleLabel,
  type WorkingRuleRole,
} from "./animation";
import {
  filterModels,
  filterSettingsRows,
  isModelSearchShortcut,
  isSettingsSearchShortcut,
  moveSettingSelection,
  SettingsPopup,
  SETTINGS_ROWS,
  type SettingRowId,
  type ThinkingLevel,
} from "./settings-popup";
import {
  CHECK_MODE_PROFILES,
  checkPathsForProject,
  cycleOutputMode,
  MAX_ACTIVE_SUBAGENTS,
  MIN_ACTIVE_SUBAGENTS,
  OUTPUT_MODE_LABELS,
  SANDBOX_MODES,
  normalizeSettings,
  saveSettings,
  WORKING_RULE_ANIMATION_LABELS,
  WORKING_RULE_ANIMATION_MODES,
  type PumSettings,
  type WorkingRuleAnimationMode,
} from "./settings";
import { StatusBar } from "./status-bar";
import {
  ActivitySummaryLine,
  AgentMessageLine,
  GoalReviewLine,
  needsTranscriptGap,
  topAnchorScrollTop,
  PendingMessageLine,
  flushStream,
  rawToolText,
  resolveGoalReview,
  resolvePendingDelivery,
  settleTranscriptMessage,
  streamedDelta,
  StreamLine,
  TextLine,
  ToolLine,
  transcriptForThinkingVisibility,
  type Line,
  type PendingLine,
  type Role,
} from "./transcript";
import { bashOutput, bashResultDisplay, editCounts, toolArgs, type ToolCall } from "./tool-line";
import { interruptedToolCall, settledToolCall, startedToolCall } from "./tool-row";
import { toolPreviewFromResult, toolPreviewFromStart } from "./tool-preview";
import { readBranch, watchBranch } from "./git-branch";
import { HelpPopup, maxHelpScrollOffset } from "./help-popup";
import { appendHistory, loadHistory, removeHistory } from "./history";
import {
  appendPromptStash,
  loadPromptStash,
  markPromptStashExecuted,
  markPromptStashExecutedMany,
  removePromptStash,
  replacePromptStash,
  type StashedPrompt,
} from "./prompt-stash";
import { replayEntries } from "./replay";
import { loadTheme, PRESET_NAMES, type Theme } from "./theme";
import { buildSyntaxStyle } from "./syntax";
import {
  observeSearchCalls,
  persistSearchCall,
  webSearch,
  withSearchRoute,
} from "./web-search";
import {
  isCommandInput,
  matchingCommandsForTarget,
  moveCommandSelection,
  SUGGESTION_ROWS,
  suggestionWindowStart,
} from "./commands";
import { truncateStatusText } from "./status-metadata";
import { modeLineLabels } from "./mode-line";
import { RULE_LABEL_TRAILING_RULE_COLUMNS } from "./goal-line";
import {
  loadRelocation,
  relocationPathsTrusted,
  relocationTargetDirectory,
  returnRelocationBlockReason,
  saveRelocation,
  startRelocationBlockReason,
  type RelocationRecord,
} from "./relocation";
import {
  settleSessionResumeAliasesAtSource,
  syncSessionResumeAliases,
} from "./session-resume-alias";
import { AGENT_NOTICE_CUSTOM_TYPE } from "./subagents/types";
import {
  loadSessionSettings,
  mergeSessionSettings,
  saveSessionSettings,
  sessionSettingsDiff,
  type SessionSettings,
} from "./session-settings";
import { AfkController, type AfkStatus } from "./afk";
import { parseAfkCommand } from "./afk-command";
import { parseBackgroundCommand } from "./background-command";
import {
  afkAnswerFailureText,
  buildAfkTask,
  validateAfkAnswer,
} from "./afk-delegate";
import type {
  QuestionnaireRequest,
  QuestionnaireResult,
} from "./questionnaire";
import { loadTodoTasks } from "./todo";
import {
  cycleTodoFilter,
  moveTodoSelection,
  TodoPopup,
  todoPopupLayout,
  visibleTodoTasks,
  type TodoFilter,
} from "./todo-popup";
import {
  applyPathCompletion,
  pathCompletions,
  shouldAutoShowPathCompletions,
  type PathCompletion,
} from "./path-autocomplete";
import { setBashOutputSettingsIfPresent } from "./bash-output";
import { settingsCompletions } from "./settings-autocomplete";
import {
  applySettingChange,
  listSettingsMessage,
  parseSettingsCommand,
  showSettingMessage,
} from "./settings-command";
import { isRejectedToolResult, rejectedToolReason } from "./check-mode";
import { SessionHistoryPopup } from "./session-history-popup";
import type { SessionHistoryItem } from "./session-history-metadata";
import { setWritingStyle, WRITING_STYLES } from "./writing-style";
import {
  EXPLANATION_STRENGTHS,
  setExplanationStrength,
} from "./explanation-strength";
import { setCheckModeConfig } from "./check-mode";
import { applyCheckPathCommand, parseCheckPathCommand } from "./check-paths";
import { pruneEditedMarkers, reindexMarkers } from "./attachment-markers";
import {
  captureClipboardImage,
  cleanupPendingImages,
  imageContent,
  removePendingImage,
  type PendingImage,
} from "./image-paste";
import {
  cleanupPendingPastedTexts,
  pastedTextReadBlock,
  removePendingPastedText,
  shouldStagePastedText,
  stagePastedText as stagePastedTextDefault,
  type PendingPastedText,
} from "./pasted-text";
import { countActiveSubagents, type SubagentManager } from "./subagents/manager";
import type { SpawnPreviewManager } from "./subagents/spawn-preview";
import { SpawnPreviewPopup } from "./subagents/spawn-preview-popup";
import { recallNewestQueuedUserMessage } from "./queue-recall";
import { parseWorktreeCommand, runWorktreeCommand } from "./worktree-command";
import { startWorktree } from "./worktree-start";
import { existsSync } from "node:fs";
import { pathIdentity } from "./platform";
import { CANCEL_WINDOW_MS, confirmsCancellation } from "./cancel-confirmation";
import { buildStashBatchPrompt, selectedRange } from "./stash-batch";
import {
  messageCacheDetail,
  MessageCacheController,
  type MessageCacheSendRequest,
  type MessageCacheSendResult,
} from "./message-cache";
import { addTurnUsage, usageFromEntries } from "./agent-usage";
import { AgentSelectorPopup, buildAgentTree, moveAgentSelection } from "./agent-selector";
import { LoginPopup, type LoginPage } from "./login-popup";
import { LoginController } from "./login-controller";
import { providerLoginMethods } from "./login-flow";
import { ProvidersPopup, type ProvidersPage } from "./providers-popup";
import { ProvidersController } from "./providers-controller";
import { parseProvidersCommand, type ProviderEntry } from "./providers-command";
import { providersCompletions } from "./providers-autocomplete";
import {
  deleteProvider,
  modelAfterRemoval,
  providerEntries,
  readCustomProviderIds,
} from "./providers-flow";
import { questionnaireDetail, QuestionnaireManager } from "./questionnaire";
import { QuestionnairePopup } from "./questionnaire-popup";
import {
  moveTriggerSelection,
  sortTriggers,
  triggerActionForKey,
  type TriggerAction,
  type TriggerManagerLike,
} from "./triggers/popup";
import {
  moveProcessSelection,
  processTabForKey,
  ProcessesPopup,
  sortShells,
  type ProcessTab,
  type ShellManagerLike,
} from "./processes-popup";
import type { TerminalTitleController } from "./terminal-title";
import { resolveOrcaStatusState, type OrcaStatusController } from "./orca-status";
import { readClipboardText } from "./text-paste";
import { copyTextToClipboard } from "./clipboard";
import { NewsPopup } from "./news-popup";
import {
  NEWS_CAPACITY,
  loadNewsItems,
  saveNewsItems,
  tagNewsLines,
  type NewsItem,
  type NewsPrompt,
} from "./news";
import {
  statsFromEntries,
  type SessionStatsManager,
  type SessionStatsSnapshot,
} from "./session-stats";
import {
  applyJudgeResult,
  continuationDelivered,
  continueGoal,
  createGoal,
  formatGoalStatus,
  goalContinuePrompt,
  goalFormulationPrompt,
  goalStartPrompt,
  isTerminalGoalState,
  judgeTicketFor,
  loadGoal,
  noteSettledWork,
  MAX_GOAL_RETRY_LIMIT,
  MIN_GOAL_RETRY_LIMIT,
  normalizeGoalRetryLimit,
  parseGoalVerdict,
  parseProposedGoal,
  saveGoal,
  shouldScheduleGoalJudge,
  steerGoal,
  stopGoal,
  type GoalContinuation,
  type GoalJudgeTicket,
  type GoalRecord,
} from "./goal";
import { parseGoalCommand, type GoalControl } from "./goal-command";
import { goalLabel, goalLabelColor } from "./goal-line";
import { goalReviewHeadline, retryDetail, type GoalReviewStatus } from "./goal-review";
import { buildJudgeTask, collectRepositoryState, judgeTranscript } from "./goal-judge";
import { settledUserBashCall, userBashReaction } from "./user-bash";

/** Placeholder while the stats popup is closed, so no snapshot is built per event. */
const EMPTY_STATS_SNAPSHOT: SessionStatsSnapshot = {
  models: [],
  tools: [],
  outcomes: { successful: 0, failed: 0, blocked: 0, running: 0, interrupted: 0 },
};
import { maxStatsScrollOffset, StatsPopup } from "./stats-popup";
import {
  projectPendingTranscriptLines,
  projectTranscriptLines,
  transcriptOutputMode,
  type TranscriptOutputMode,
} from "./transcript-output";
import type { MinimalTranscriptLine } from "./output-minimal";
import { heldTranscriptLines, type DwellMemory } from "./transcript-dwell";
import {
  atWindowBottom,
  atWindowTop,
  clampWindowStart,
  extendedWindowStart,
  nearWindowTop,
  tailWindowStart,
  transcriptWindowRows,
  windowStartForRow,
} from "./transcript-window";

type Stream = { kind: "assistant" | "thinking"; text: string } | null;
type Transcript = { lines: Line[]; stream: Stream; pending: PendingLine[] };

function projectedLineKey(line: MinimalTranscriptLine, index: number): string {
  if (line.kind === "tool-summary") return `summary:${line.calls.map((call) => call.id).join(":")}`;
  if (line.kind === "tool") return `tool:${line.call.id}`;
  if (line.kind === "agent-message") return `agent:${line.messageId ?? `${index}:${line.text}`}`;
  // The judge id, not the status: the row is rewritten in place, and a key that
  // changed with it would remount the row and drop the animation mid-review.
  if (line.kind === "goal-review") return `review:${line.id}`;
  return `text:${line.newsId ?? `${line.role}:${index}:${line.text}`}`;
}

function projectedLineRawText(line: MinimalTranscriptLine): string {
  if (line.kind === "tool-summary") return line.calls.map(rawToolText).join("\n\n");
  if (line.kind === "tool") return rawToolText(line.call);
  if (line.kind === "agent-message") return `${line.sender} → ${line.recipient}\n${line.text}`;
  if (line.kind === "goal-review") {
    return [goalReviewHeadline(line.status, line.detail), line.body].filter(Boolean).join("\n");
  }
  return line.text;
}

const QUIT_WINDOW_MS = 2000;
const MAX_INPUT_ROWS = 8;
/** How long a scroll to a row waits between tries for React to draw it. */
const ROW_DRAW_RETRY_MS = 30;
/**
 * How many of those tries it makes before it gives up.
 *
 * A busy machine with a long session can take most of a second to draw a row
 * that had to be mounted first, and a jump that gives up before then looks to
 * the reader exactly like a dead key.
 */
const ROW_DRAW_TRIES = 30;
/** Frames a scroll correction waits for its rows before it gives up. */
const ANCHOR_FRAME_BUDGET = 30;
/** Keys that move around without changing the text. */
const NAV_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

type PromptTextareaAction =
  | "visual-line-home"
  | "visual-line-end"
  | "buffer-home"
  | "buffer-end"
  | "select-visual-line-home"
  | "select-visual-line-end"
  | "select-buffer-home"
  | "select-buffer-end";

/** Half of OpenTUI's default drag auto-scroll rate. */
export const PROMPT_SCROLL_SPEED = 8;

/** Standard editor navigation, with wrapped rows treated as visible lines. */
export const PROMPT_TEXTAREA_KEY_BINDINGS: Array<{
  name: string;
  action: PromptTextareaAction;
  ctrl?: boolean;
  shift?: boolean;
}> = [
  { name: "home", action: "visual-line-home" },
  { name: "end", action: "visual-line-end" },
  { name: "home", shift: true, action: "select-visual-line-home" },
  { name: "end", shift: true, action: "select-visual-line-end" },
  { name: "home", ctrl: true, action: "buffer-home" },
  { name: "end", ctrl: true, action: "buffer-end" },
  { name: "home", ctrl: true, shift: true, action: "select-buffer-home" },
  { name: "end", ctrl: true, shift: true, action: "select-buffer-end" },
  { name: "up", ctrl: true, action: "buffer-home" },
  { name: "down", ctrl: true, action: "buffer-end" },
  { name: "up", ctrl: true, shift: true, action: "select-buffer-home" },
  { name: "down", ctrl: true, shift: true, action: "select-buffer-end" },
];

/**
 * An Enter carrying an explicit modifier, encoded in the escape sequence.
 * Windows Terminal under PowerShell can emit kitty `ESC[13;Nu` or
 * modifyOtherKeys `ESC[27;N;13~` forms before OpenTUI negotiates the
 * keyboard protocol, so the parser leaves `key.name` empty. `N` is one more
 * than a bit mask: Shift=1, Alt=2, Ctrl=4.
 */
const MODIFIED_ENTER_SEQUENCE = /^\x1b\[(?:13;(\d+)u|27;(\d+);13~)$/;
const KITTY_PRINTABLE_SEQUENCE = /^\x1b\[(\d+)(?:;\d+(?::\d+)?)?u$/;
const MODIFY_OTHER_KEYS_PRINTABLE_SEQUENCE = /^\x1b\[27;\d+;(\d+)~$/;

function printableKeyCharacter(
  name: string | undefined,
  sequence: string,
  raw = sequence,
): string | undefined {
  if (name?.length === 1) return name.toLowerCase();
  for (const candidate of [sequence, raw]) {
    if (candidate.length === 1) return candidate.toLowerCase();
    const kitty = KITTY_PRINTABLE_SEQUENCE.exec(candidate);
    const modifyOtherKeys = MODIFY_OTHER_KEYS_PRINTABLE_SEQUENCE.exec(candidate);
    const codePoint = Number(kitty?.[1] ?? modifyOtherKeys?.[1]);
    if (!Number.isInteger(codePoint) || codePoint < 0x20 || codePoint > 0x10FFFF) continue;
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) continue;
    return String.fromCodePoint(codePoint).toLowerCase();
  }
  return undefined;
}

function modifiedEnterFromSequence(sequence: string) {
  const match = MODIFIED_ENTER_SEQUENCE.exec(sequence);
  if (!match) return null;
  const mask = parseInt(match[1] ?? match[2]!, 10) - 1;
  return {
    shift: (mask & 1) !== 0,
    alt: (mask & 2) !== 0,
    ctrl: (mask & 4) !== 0,
  };
}

export function historyOpenBlockReason(options: {
  hasPendingImages: boolean;
  hasPendingPastedText?: boolean;
  busy: boolean;
}): string | null {
  if (options.hasPendingImages) return "send or remove attached images before switching sessions";
  if (options.hasPendingPastedText) return "send or remove attached pasted text before switching sessions";
  if (options.busy) return "wait for the current turn to finish before opening history";
  return null;
}

/** The steer note the wave leaves alone. Kept flat so it reads as a fixed hint. */
export const PLACEHOLDER_STEER_HINT = " (send to steer)";
const PLACEHOLDER_TOOL = "Working...";
const PLACEHOLDER_THINKING = "Forming a thought...";

export function promptPlaceholder(options: {
  activeAgentName?: string;
  busy: boolean;
  stashOpen: boolean;
  /** A tool call is running, rather than the model composing an answer. */
  toolRunning?: boolean;
}): string {
  // A busy prompt says what the agent is doing, in every transcript. The agent
  // name is already on the rule above the prompt, so repeating it here would
  // cost the room the state needs.
  const busy = `${options.toolRunning ? PLACEHOLDER_TOOL : PLACEHOLDER_THINKING}${PLACEHOLDER_STEER_HINT}`;
  if (options.activeAgentName) {
    return options.busy ? busy : `Message ${options.activeAgentName}…`;
  }
  if (options.stashOpen) return "Cache…";
  return options.busy ? busy : "Ask something…";
}

/** Rows scanned back from the end for a running tool call. */
const TOOL_SCAN_DEPTH = 30;

/**
 * Is a tool running right now?
 *
 * The canonical rows answer this, not the projected ones: Quiet and Normal
 * aggregate routine calls into one activity row, and how much detail the
 * transcript shows must not change what the prompt says the agent is doing.
 */
export function hasRunningToolCall(
  lines: readonly { kind: string; call?: { state?: string } }[],
): boolean {
  const stop = Math.max(0, lines.length - TOOL_SCAN_DEPTH);
  for (let index = lines.length - 1; index >= stop; index--) {
    const line = lines[index]!;
    if (line.kind === "tool" && line.call?.state === "running") return true;
  }
  return false;
}

/** How much of a placeholder the wave crosses: the phrase, never the hint. */
export function placeholderCrestEnd(text: string): number {
  return text.endsWith(PLACEHOLDER_STEER_HINT)
    ? text.length - PLACEHOLDER_STEER_HINT.length
    : text.length;
}

/** A blank row. An empty <text> measures to nothing, so this needs a height. */
const Gap = () => <box style={{ height: 1, flexShrink: 0 }} />;

/**
 * One rendered transcript row.
 *
 * Memoized on purpose. The transcript is a child of the same component that
 * holds the prompt draft, so without this every keystroke re-rendered every
 * row, and the cost of a keypress grew with the length of the session. Each
 * prop here must therefore stay identity-stable while the row is unchanged:
 * pass the row index and one shared handler rather than a fresh closure.
 */
const TranscriptRow = memo(function TranscriptRow({
  theme,
  syntaxStyle,
  line,
  index,
  selected,
  expanded,
  outputMode,
  workingCaret,
  gapBefore,
  news,
  onDisclosure,
}: {
  theme: Theme;
  syntaxStyle: SyntaxStyle;
  line: MinimalTranscriptLine;
  index: number;
  selected: boolean;
  expanded: boolean;
  outputMode: TranscriptOutputMode;
  workingCaret: boolean;
  gapBefore: boolean;
  news?: "seen" | "unseen";
  onDisclosure: (index: number) => void;
}) {
  const onDisclosureClick = () => onDisclosure(index);
  const row =
    line.kind === "tool-summary" ? (
      <ActivitySummaryLine
        theme={theme}
        syntaxStyle={syntaxStyle}
        summary={line}
        expanded={expanded}
        outputMode={outputMode}
        onDisclosureClick={onDisclosureClick}
      />
    ) : line.kind === "tool" ? (
      <ToolLine
        theme={theme}
        syntaxStyle={syntaxStyle}
        call={line.call}
        workingCaret={workingCaret}
        outputMode={outputMode}
        expanded={expanded}
        onDisclosureClick={onDisclosureClick}
      />
    ) : line.kind === "agent-message" ? (
      <AgentMessageLine theme={theme} syntaxStyle={syntaxStyle} line={line} />
    ) : line.kind === "goal-review" ? (
      <GoalReviewLine theme={theme} line={line} />
    ) : (
      <TextLine
        theme={theme}
        syntaxStyle={syntaxStyle}
        role={line.role as Role}
        text={line.text}
        workingCaret={workingCaret}
        news={news}
      />
    );
  return (
    <box
      id={`transcript-line-${index}`}
      style={{
        flexDirection: "column",
        width: "100%",
        flexShrink: 0,
        backgroundColor: selected ? theme.selectionBg : "transparent",
      }}
    >
      {gapBefore ? <Gap /> : null}
      {row}
    </box>
  );
});

type RenderErrorBoundaryProps = {
  theme: Theme;
  label: string;
  /** A new value clears a shown error, so later state can render again. */
  resetKey: string;
  children: ReactNode;
};

/**
 * A throw during a React commit escapes root.render, and nothing above it
 * leaves the alternate screen or raw mode, so one bad transcript row or popup
 * would wedge the terminal. This turns that into a single error row.
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, { message: string | null }> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(previous: RenderErrorBoundaryProps) {
    if (this.state.message !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ message: null });
    }
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <text
        content={`${this.props.label} failed to render: ${this.state.message}`}
        fg={this.props.theme.error}
        style={{ flexShrink: 0 }}
      />
    );
  }
}

function WorkingRule({
  theme,
  width,
  busy,
  dimmed = false,
  mode,
  role,
  label = null,
  trailingRuleColumns = 0,
  color,
}: {
  theme: Theme;
  width: number;
  busy: boolean;
  dimmed?: boolean;
  mode: WorkingRuleAnimationMode;
  role: WorkingRuleRole;
  label?: WorkingRuleLabel | readonly WorkingRuleLabel[] | null;
  trailingRuleColumns?: number;
  color?: string;
}) {
  const ref = useWorkingRule({
    width,
    color: color ?? (dimmed ? theme.dim : theme.border),
    highlight: theme.highlight,
    active: busy,
    mode,
    role,
    label,
    trailingRuleColumns,
  });
  return <text ref={ref} style={{ flexShrink: 0 }} />;
}

type StashedPromptView = Pick<StashedPrompt, "text" | "executed">;

export function PromptStashRow({
  theme,
  prompt,
  index,
  selected,
}: {
  theme: Theme;
  prompt: StashedPromptView;
  index: number;
  selected: boolean;
}) {
  const color = prompt.executed ? theme.dim : theme.fg;

  return (
    <box
      id={`stash-prompt-${index}`}
      style={{
        flexDirection: "row",
        width: "100%",
        flexShrink: 0,
        backgroundColor: selected ? theme.selectionBg : "transparent",
      }}
    >
      <box style={{ width: 2, flexShrink: 0 }}>
        <text content={prompt.executed ? "✓ " : "○ "} fg={prompt.executed ? theme.success : theme.dim} />
      </box>
      <text
        content={prompt.text}
        fg={color}
        wrapMode="word"
        style={{ flexGrow: 1, minWidth: 0 }}
      />
    </box>
  );
}

export function PromptStash({
  theme,
  prompts,
  cursor,
  selectedIndices,
  height,
}: {
  theme: Theme;
  prompts: StashedPromptView[];
  cursor: number;
  selectedIndices: ReadonlySet<number>;
  height: number;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    // Reconcile after OpenTUI has measured appended or wrapped rows.
    const timer = setTimeout(() => {
      if (!scrollRef.current) return;
      const target = cursor < 0 ? prompts.length - 1 : cursor;
      if (target >= 0) scrollRef.current.scrollChildIntoView(`stash-prompt-${target}`);
    }, 0);
    return () => clearTimeout(timer);
  }, [cursor, prompts.length]);

  return (
    <scrollbox
      ref={scrollRef}
      style={{
        height: Math.min(15, Math.max(1, height - 7)),
        flexShrink: 0,
      }}
      verticalScrollbarOptions={{ visible: true }}
      stickyScroll
      stickyStart="bottom"
    >
      <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
      {prompts.map((prompt, i) => (
        <PromptStashRow
          key={`${i}:${prompt.text}`}
          theme={theme}
          prompt={prompt}
          index={i}
          selected={selectedIndices.size > 0 ? selectedIndices.has(i) : i === cursor}
        />
      ))}
      </box>
    </scrollbox>
  );
}

function sessionUsage(session: AgentSession) {
  const manager = session.sessionManager as any;
  const entries = typeof manager.getEntries === "function"
    ? manager.getEntries()
    : manager.buildContextEntries();
  return usageFromEntries(entries, session.agent.state.model.contextWindow);
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("")
    .trim();
}

/** Match recallable pending user lines to the cleared steering queue in queue order. */
export function queuedUserSteersInOrder(
  steering: readonly string[],
  pending: readonly PendingLine[],
): string[] {
  const candidates = pending.filter((item) =>
    !item.delivered &&
    item.recallable !== false &&
    item.line.kind === "text" &&
    item.line.role === "user" &&
    Boolean(item.deliveryText),
  );
  const remaining = [...candidates];
  return steering.flatMap((deliveryText) => {
    const index = remaining.findIndex((item) => item.deliveryText === deliveryText);
    if (index < 0) return [];
    const [item] = remaining.splice(index, 1);
    return item?.line.kind === "text" ? [item.line.text] : [];
  });
}

export type PromptHistoryStore = {
  load: (cwd: string) => string[];
  append: (cwd: string, prompt: string) => string[];
  remove: (cwd: string, prompt: string) => string[];
};

const DEFAULT_PROMPT_HISTORY_STORE: PromptHistoryStore = {
  load: loadHistory,
  append: appendHistory,
  remove: removeHistory,
};

export type PromptStashStore = {
  load: (cwd: string) => StashedPromptView[];
  append: (cwd: string, prompt: string, executed?: boolean) => StashedPromptView[];
  markExecuted: (cwd: string, index: number) => StashedPromptView[];
  markExecutedMany: (cwd: string, indices: Iterable<number>) => StashedPromptView[];
  replace: (cwd: string, index: number, prompt: string, executed: boolean) => StashedPromptView[];
  remove: (cwd: string, index: number) => StashedPromptView[];
};

const DEFAULT_PROMPT_STASH_STORE: PromptStashStore = {
  load: loadPromptStash,
  append: appendPromptStash,
  markExecuted: markPromptStashExecuted,
  markExecutedMany: markPromptStashExecutedMany,
  replace: replacePromptStash,
  remove: removePromptStash,
};

/** Move any buffered stream into the transcript so later lines land in order. */
function flushed(t: Transcript): Transcript {
  return flushStream(t);
}

export function App({
  session: initialSession,
  modelRuntime,
  onNewSession,
  loadSessions,
  onSwitchSession,
  onRelocate,
  settings: initial,
  searchProviders,
  subagentManager,
  statsManager,
  questionnaireManager,
  spawnPreviewManager,
  loginRequired = false,
  promptHistoryStore = DEFAULT_PROMPT_HISTORY_STORE,
  promptStashStore = DEFAULT_PROMPT_STASH_STORE,
  captureImage = captureClipboardImage,
  readPastedText = readClipboardText,
  stagePastedText = stagePastedTextDefault,
  copyNewsAnswerText = copyTextToClipboard,
  copyTranscriptText = copyTextToClipboard,
  onExit = () => process.exit(0),
  triggerManager,
  shellManager,
  messageCacheController,
  terminalTitle,
  orcaStatus,
  startupWarnings = [],
  onSandboxModeChange,
  sandboxWarningSource,
  forcedSandboxMode,
  forcedCheckPaths = [],
  initialRelocation,
  initialCwd,
  userBashOperations,
}: {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  onNewSession: () => Promise<AgentSession | null>;
  loadSessions: (cwd?: string) => Promise<SessionHistoryItem[]>;
  onSwitchSession: (path: string) => Promise<AgentSession | null>;
  /** Move this same session to another directory. Null when it could not move. */
  onRelocate?: (targetCwd: string) => Promise<AgentSession | null>;
  settings: PumSettings;
  /** Provider ids that carry the hosted web-search tool; empty means none. */
  searchProviders: string[];
  subagentManager: SubagentManager;
  statsManager?: SessionStatsManager;
  questionnaireManager?: QuestionnaireManager;
  spawnPreviewManager?: SpawnPreviewManager;
  loginRequired?: boolean;
  promptHistoryStore?: PromptHistoryStore;
  promptStashStore?: PromptStashStore;
  captureImage?: typeof captureClipboardImage;
  readPastedText?: typeof readClipboardText;
  /** Store large or multiline pasted text in a temp file and show a marker. */
  stagePastedText?: typeof stagePastedTextDefault;
  /** Copies the selected news answer for the popup. */
  copyNewsAnswerText?: typeof copyTextToClipboard;
  /** Copies raw data for the selected transcript row. */
  copyTranscriptText?: typeof copyTextToClipboard;
  onExit?: () => void | Promise<void>;
  triggerManager?: TriggerManagerLike;
  shellManager?: ShellManagerLike;
  messageCacheController?: MessageCacheController;
  terminalTitle?: TerminalTitleController;
  orcaStatus?: OrcaStatusController;
  /** Visible process-local warnings. These lines never enter pi session context. */
  startupWarnings?: readonly string[];
  onSandboxModeChange?: (mode: NonNullable<PumSettings["sandboxMode"]>) => void;
  sandboxWarningSource?: { subscribeWarnings(listener: (warning: string) => void): () => void };
  /** Process-local sandbox floor that does not overwrite persisted user settings. */
  forcedSandboxMode?: NonNullable<PumSettings["sandboxMode"]>;
  forcedCheckPaths?: readonly string[];
  /** Relocation created before the TUI mounted, such as a `pum worktree` launch. */
  initialRelocation?: RelocationRecord;
  /** Directory the session starts in. Defaults to the process working directory. */
  initialCwd?: string;
  /** User commands bypass Check mode but use this native sandbox execution path. */
  userBashOperations?: BashOperations;
}) {
  // The one authoritative active directory. Everything directory-dependent
  // reads this rather than process.cwd(), so a live move rebinds by re-render
  // instead of by each module happening to ask again.
  const [cwd, setCwd] = useState(() => initialCwd ?? process.cwd());
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const [session, setSession] = useState(initialSession);
  // Load the news companion file exactly once on mount. The transcript
  // initializer reads these items from the ref instead of re-reading the file.
  const newsRef = useRef<NewsItem[]>([]);
  const [news, setNews] = useState<NewsItem[]>(() => {
    const items = loadNewsItems(initialSession.sessionFile);
    newsRef.current = items;
    return items;
  });
  const [tx, setTx] = useState<Transcript>(() => {
    // A resumed session already holds messages; show them instead of a blank pane.
    // Reasoning is always replayed and the display filters it, the way a
    // subagent transcript already works. Dropping it here would make the
    // setting reveal a resumed subagent's reasoning but never the main
    // agent's, so one session would read two ways.
    const replayedLines = replayEntries(
      initialSession.sessionManager.buildContextEntries(),
      cwd,
      true,
    );
    return {
      lines: [
        ...tagNewsLines(replayedLines, newsRef.current),
        ...startupWarnings.map((text): Line => ({ kind: "text", role: "system", text })),
      ],
      stream: null,
      pending: [],
    };
  });
  const txRef = useRef<Transcript>({ lines: [], stream: null, pending: [] });
  // Layout effect: commit may hand control to a user handler before paint, so
  // the mirror must update synchronously to avoid a stale transcript read.
  useLayoutEffect(() => {
    txRef.current = tx;
  }, [tx]);
  // Autonomous goal mode. The ref is authoritative: keyboard handlers, session
  // events, and the judge callback all read it before React has re-rendered.
  const goalRef = useRef<GoalRecord | null>(null);
  const [goal, setGoalState] = useState<GoalRecord | null>(() => {
    const loaded = loadGoal(initialSession.sessionFile);
    goalRef.current = loaded;
    return loaded;
  });
  /** The live review, held as a promise so a fast verdict cannot outrun the spawn. */
  const judgeRef = useRef<{
    ticket: GoalJudgeTicket;
    agent: Promise<{ id: string }>;
    /** Set the moment the verdict tool runs, so a settle cannot report it missing. */
    verdictSeen: boolean;
  } | null>(null);
  const judgeAgentIdRef = useRef<string | null>(null);
  const judgeStartingRef = useRef(false);
  // Bumped by every drop. A start that was still collecting the repository
  // state when the goal was stopped, cleared, or replaced sees the change and
  // abandons its spawn, rather than leaving a judge nobody can act on.
  const judgeEpochRef = useRef(0);
  /** Set while a `/goalf` interview turn is running, so no judge reviews it. */
  const goalFormulationRef = useRef<{ draft: string } | null>(null);
  /** Managed workers in flight, judges excluded. Mirrored for event handlers. */
  const activeWorkersRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScrollOffset, setHelpScrollOffset] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsScrollOffset, setStatsScrollOffset] = useState(0);
  const [statsRevision, setStatsRevision] = useState(0);
  const [historySessions, setHistorySessions] = useState<SessionHistoryItem[]>([]);
  const [page, setPage] = useState<"main" | "models" | "checkModels">("main");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsSearchFocused, setSettingsSearchFocused] = useState(true);
  const [selectedSettingId, setSelectedSettingId] = useState<SettingRowId | null>(SETTINGS_ROWS[0]!.id);
  // `initial` is the global config. A session lays its own overrides over it,
  // so both have to be tracked: one to write back on `s`, one to persist here.
  // Normalize the baseline: comparing raw props against normalized state would
  // report every default the normalizer filled in as a session override.
  const globalSettingsRef = useRef(normalizeSettings(initial));
  const [sessionOverrides, setSessionOverrides] = useState<SessionSettings>(
    () => loadSessionSettings(initialSession.sessionFile),
  );
  const sessionOverridesRef = useRef(sessionOverrides);
  const [settings, setSettings] = useState(
    () => mergeSessionSettings(globalSettingsRef.current, sessionOverridesRef.current),
  );
  const [transcriptFocused, setTranscriptFocused] = useState(false);
  const transcriptFocusedRef = useRef(false);
  const [transcriptCursor, setTranscriptCursor] = useState(0);
  const transcriptCursorRef = useRef(0);
  const [detailOverrides, setDetailOverrides] = useState<Map<string, boolean>>(() => new Map());
  const detailOverridesRef = useRef(detailOverrides);
  // Disclosure clicks reach the memoized rows through one stable function, so a
  // re-render of the app cannot invalidate every row by handing it a new one.
  const clickTranscriptDisclosureRef = useRef<(index: number) => void>(() => {});
  const onTranscriptDisclosure = useRef(
    (index: number) => clickTranscriptDisclosureRef.current(index),
  ).current;
  // Mirrors settings for update(): a keypress or an async .then can fire a
  // second update before React commits the first, so update() must build the
  // next value from the latest pending settings, not the render closure.
  const settingsRef = useRef(settings);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    session.agent.state.thinkingLevel as ThinkingLevel,
  );
  const [modelId, setModelId] = useState(session.agent.state.model.id);
  const [branch, setBranch] = useState<string | null>(null);
  const [usage, setUsage] = useState(() => sessionUsage(initialSession));
  const [elapsedSec, setElapsedSec] = useState(0);
  const [stash, setStash] = useState<StashedPromptView[]>(() => promptStashStore.load(cwd));
  /** -1 means the input is selected; non-negative values select stash rows. */
  const [stashCursor, setStashCursor] = useState(-1);
  const [stashSelection, setStashSelection] = useState<Set<number>>(() => new Set());
  const [stashOpen, setStashOpen] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const [inputCursorOffset, setInputCursorOffset] = useState(0);
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandSuggestionsDismissed, setCommandSuggestionsDismissed] = useState(false);
  const [editingStashIndexState, setEditingStashIndexState] = useState<number | null>(null);
  const [inputRows, setInputRows] = useState(1);
  const [inputCursorRow, setInputCursorRow] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const [shellMode, setShellMode] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentSelectorOpen, setAgentSelectorOpen] = useState(false);
  const [agentSelectorCursor, setAgentSelectorCursor] = useState(0);
  const [agentElapsedSec, setAgentElapsedSec] = useState(0);
  const [loginOpen, setLoginOpen] = useState(loginRequired);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [providersPage, setProvidersPage] = useState<ProvidersPage>({
    kind: "working",
    message: "Loading providers…",
  });
  // Kept beside the popup so /providers can complete names before it opens.
  const [managedProviders, setManagedProviders] = useState<ProviderEntry[]>([]);
  const [, setQuestionnaireRevision] = useState(0);
  const [, setSpawnPreviewRevision] = useState(0);
  const [loginPage, setLoginPage] = useState<LoginPage>(() => ({
    kind: "providers",
    methods: providerLoginMethods((modelRuntime as any).getProviders?.() ?? []),
    cursor: 0,
    query: "",
    searchFocused: true,
    customVisible: true,
  }));
  const [modelQuery, setModelQuery] = useState("");
  const [modelSearchFocused, setModelSearchFocused] = useState(false);
  const [, setAgentRevision] = useState(0);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [processTab, setProcessTab] = useState<ProcessTab>("triggers");
  const [triggerCursor, setTriggerCursor] = useState(0);
  const [shellCursor, setShellCursor] = useState(0);
  const [triggerRevision, setTriggerRevision] = useState(0);
  const [shellRevision, setShellRevision] = useState(0);
  const [shellTails, setShellTails] = useState<Record<string, string>>({});

  const [newsOpen, setNewsOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const todoOpenRef = useRef(false);
  const [todoFilter, setTodoFilter] = useState<TodoFilter>("all");
  const todoFilterRef = useRef<TodoFilter>("all");
  const [todoSelectedId, setTodoSelectedId] = useState<string | null>(null);
  const todoSelectedIdRef = useRef<string | null>(null);
  const newsOpenRef = useRef(false);
  const [newsCursor, setNewsCursor] = useState(0);
  const newsCursorRef = useRef(0);
  const statsOpenRef = useRef(false);

  const theme = useMemo(() => loadTheme(settings.theme), [settings.theme]);
  const { width, height } = useTerminalDimensions();
  const syntaxStyle = useMemo(() => buildSyntaxStyle(theme), [theme]);
  const newsReadById = useMemo(
    () => new Map(news.map((item) => [item.id, item.read])),
    [news],
  );
  const animations = settings.animations && supportsTrueColor();
  // The goal rides the input-top rule, not the status bar. It is rebuilt only
  // when the goal, the terminal width, or the theme changes.
  const agents = subagentManager.getAgents();
  const activeSubagentCount = countActiveSubagents(agents);
  // Layout effect, like the transcript mirror: an event handler can read this
  // before React has painted the render that produced the new count.
  useLayoutEffect(() => {
    activeWorkersRef.current = activeSubagentCount;
  }, [activeSubagentCount]);
  const activeAgent = activeAgentId
    ? agents.find((agent) => agent.id === activeAgentId)
    : undefined;
  const questionnaire = questionnaireManager?.current();
  const spawnPreview = spawnPreviewManager?.current();
  // One controller for the process. It lives in a ref so /clear, session
  // switches and transcript switches leave it alone; only an explicit toggle,
  // or the process ending, can stop AFK.
  const afkRef = useRef<AfkController | undefined>(undefined);
  afkRef.current ??= new AfkController();
  const afk = afkRef.current;
  const [afkStatus, setAfkStatus] = useState<AfkStatus>(() => afk.status());
  useEffect(() => afk.subscribe(() => setAfkStatus(afk.status())), [afk]);

  // While a delegate answers, the popup stays down but the prompt stays live,
  // so the user can always type /afk to take the questionnaire back.
  const afkAnswering = Boolean(questionnaire) && afkStatus.active;
  const visibleQuestionnaire = afkAnswering ? undefined : questionnaire;

  const ruleLabels = useMemo<WorkingRuleLabel[]>(() => modeLineLabels({
    goal,
    afk: afkStatus.active
      ? { state: afkAnswering ? "answering" : "on", instructions: afkStatus.instructions }
      : null,
    ruleWidth: Math.max(0, width),
    theme,
  }), [
    goal?.text, goal?.state, width, theme,
    afkStatus.active, afkStatus.instructions, afkAnswering,
  ]);

  // Every other popup outranks this one. Deriving visibility instead of closing
  // it from each opener means a popup added later cannot forget a line here.
  const todoVisible = todoOpen
    && !settingsOpen && !helpOpen && !historyOpen && !statsOpen && !agentSelectorOpen
    && !triggersOpen && !loginOpen && !providersOpen && !newsOpen && !visibleQuestionnaire && !spawnPreview;
  // Memoized because the filtered result is a new object every call whenever
  // the transcript holds reasoning. That new identity would re-run the dwell
  // and projection passes below on every render, keystrokes included.
  const sourceTx = activeAgent?.transcript ?? tx;
  const visibleTx = useMemo(
    () => transcriptForThinkingVisibility(sourceTx, settings.showThinking),
    [sourceTx, settings.showThinking],
  );
  const outputMode = transcriptOutputMode(settings);
  const showAgentMessages = settings.showAgentMessages !== false;
  // The dwell rules run before grouping, so an activity row inherits them from
  // the calls it folds. The memory is per agent and lives outside the rows, so
  // switching views cannot restart a period the user already watched end.
  const dwellMemories = useRef<Map<string, DwellMemory>>(new Map());
  const [dwellTick, setDwellTick] = useState(0);
  const held = useMemo(() => {
    const key = activeAgentId ?? "main";
    const result = heldTranscriptLines(
      visibleTx.lines,
      dwellMemories.current.get(key) ?? new Map(),
      Date.now(),
    );
    dwellMemories.current.set(key, result.memory);
    return result;
    // dwellTick re-runs this when a deadline falls due; nothing else changes.
  }, [visibleTx.lines, activeAgentId, dwellTick]);
  useEffect(() => {
    if (held.nextDeadline === undefined) return;
    const timer = setTimeout(
      () => setDwellTick((tick) => tick + 1),
      Math.max(0, held.nextDeadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [held]);
  const visibleLines = useMemo(
    () => projectTranscriptLines(held.lines, outputMode, showAgentMessages),
    [held, outputMode, showAgentMessages],
  );
  // The rows as they are drawn. A callback that has to find a row needs these,
  // not the transcript lines: folding and hidden kinds mean the two lists have
  // different lengths, so a line index is not a row index.
  const visibleLinesRef = useRef(visibleLines);
  visibleLinesRef.current = visibleLines;
  const visiblePending = useMemo(
    () => projectPendingTranscriptLines(visibleTx.pending, showAgentMessages),
    [visibleTx.pending, showAgentMessages],
  );

  // Which rows are mounted. See `transcript-window.ts` for the rules; these
  // three refs are the state they run on.
  //
  // The start is derived during render rather than stored in state, so a
  // resumed session mounts its tail on the first render instead of mounting
  // everything and then trimming. Both derivations are idempotent, so a
  // repeated render cannot walk the window anywhere.
  const transcriptWindowStartRef = useRef(0);
  /** True while the last row is on screen. Only then may the window advance. */
  const transcriptAtBottomRef = useRef(true);
  /** Lowest start the reader has asked for. Released on returning to the end. */
  const transcriptWindowFloorRef = useRef(Number.POSITIVE_INFINITY);
  /**
   * The row to hold still while history is mounted above it.
   *
   * Rows appearing above the viewport would otherwise push the reader's place
   * down the screen. `contentOffset` is where the row sat before the mount, so
   * the restore can tell a laid-out frame from one that still shows the old
   * tree, and `viewportOffset` is the screen position to put it back at.
   */
  const transcriptWindowAnchorRef = useRef<
    { index: number; viewportOffset: number; contentOffset: number; frames: number } | null
  >(null);
  /**
   * Did the reader just finish dragging the transcript somewhere?
   *
   * Only a drag raises this: every scroll the app makes is a property
   * assignment, which raises no mouse event, and a wheel raises a different
   * event. The window needs the difference. A drag that ends against the top
   * of the mounted rows is a reader asking for the history above them, while a
   * reveal that lands a row in the same place is asking for nothing.
   */
  /** Reveals still waiting for React to draw the row they asked for. */
  const transcriptRevealsRef = useRef(0);
  const transcriptReaderDragRef = useRef(false);
  const onTranscriptReaderDrag = useRef(() => {
    transcriptReaderDragRef.current = true;
  }).current;
  const transcriptWindowRowCount = transcriptWindowRows(height);
  const transcriptWindowRowsRef = useRef(transcriptWindowRowCount);
  transcriptWindowRowsRef.current = transcriptWindowRowCount;
  // Another agent's transcript is another conversation, shown from its end. Its
  // scrollbox is a new one, so none of the positions collected for the previous
  // view mean anything against it.
  const transcriptWindowAgentRef = useRef(activeAgentId);
  if (transcriptWindowAgentRef.current !== activeAgentId) {
    transcriptWindowAgentRef.current = activeAgentId;
    transcriptAtBottomRef.current = true;
    transcriptWindowFloorRef.current = Number.POSITIVE_INFINITY;
    transcriptWindowAnchorRef.current = null;
  }
  const transcriptWindowStart = clampWindowStart(
    Math.min(
      transcriptAtBottomRef.current
        ? tailWindowStart(visibleLines.length, transcriptWindowRowCount)
        : transcriptWindowStartRef.current,
      transcriptWindowFloorRef.current,
    ),
    visibleLines.length,
  );
  transcriptWindowStartRef.current = transcriptWindowStart;
  /** Bumped to re-render when the reader changes the window from a callback. */
  const [, setTranscriptWindowTick] = useState(0);
  useLayoutEffect(() => {
    const next = Math.max(0, Math.min(transcriptCursorRef.current, visibleLines.length - 1));
    transcriptCursorRef.current = next;
    setTranscriptCursor(next);
  }, [visibleLines.length, activeAgentId]);
  const visibleBusy = activeAgent
    ? activeAgent.status === "starting" || activeAgent.status === "running"
    : busy;
  // A running tool sits at the end of the transcript, so the scan stops well
  // short of walking a long session on every render.
  const toolRunning = useMemo(() => hasRunningToolCall(held.lines), [held]);
  const placeholderText = promptPlaceholder({
    activeAgentName: activeAgent?.name,
    busy: visibleBusy,
    stashOpen,
    toolRunning,
  });
  const visibleModelId = activeAgent?.modelId.split("/").slice(1).join("/") || modelId;
  const visibleThinkingLevel = activeAgent?.thinkingLevel ?? thinkingLevel;
  const visibleBranch = activeAgent?.usesWorktree === false
    ? branch
    : activeAgent?.worktree.branch ?? branch;
  const visibleElapsedSec = activeAgent ? agentElapsedSec : elapsedSec;
  const visibleUsage = activeAgent?.usage ?? usage;
  const agentTreeRows = buildAgentTree(agents);
  const triggers = sortTriggers(triggerManager?.getTriggers() ?? []);
  const shells = sortShells(shellManager?.list() ?? []);
  const runningShellCount = shells.filter(
    (shell) => shell.state === "starting" || shell.state === "running",
  ).length;
  // Only the stats popup reads this, and building it walks every agent's entries.
  // Computing it on each tool event put that work on the render thread, so it is
  // built only while the popup is open.
  const statsSnapshot = useMemo(() => (statsOpen
    ? statsManager?.snapshot() ?? statsFromEntries(
      (session.sessionManager as any).getEntries?.() ?? session.sessionManager.buildContextEntries(),
      `${session.agent.state.model.provider}/${session.agent.state.model.id}`,
    )
    : EMPTY_STATS_SNAPSHOT), [statsOpen, statsManager, session, statsRevision]);
  const inputHint = transcriptFocused
    ? " transcript  j/k move  enter details  c copy  esc prompt "
    : cancelArmed
    ? " esc again to cancel "
    : quitArmed
      ? " ctrl+c again to quit "
      : editingStashIndexState !== null
        ? ` editing cache #${editingStashIndexState + 1} `
        : "";
  const promptRightColumns = width >= 12 ? 6 : Math.max(2, width - 3);
  const availableHintColumns = Math.max(0, width - 2 - promptRightColumns - 1);
  const visibleInputHint = inputHint.length <= availableHintColumns ? inputHint : "";
  const promptInputColumns = Math.max(
    1,
    width - 2 - promptRightColumns - visibleInputHint.length,
  );
  // Most slash commands belong to main. A selected mutable agent can still own
  // a descendant started with /background, so expose only that command there.
  const commandSuggestions = shellMode || stashOpen || commandSuggestionsDismissed
    ? []
    : matchingCommandsForTarget(
      commandInput,
      activeAgentId ? "subagent" : "main",
    );
  // /providers and /settings are the commands whose arguments come from closed
  // sets, so they complete them. Every other command still stops at its name.
  const argumentSuggestionsOff = shellMode || stashOpen || commandSuggestionsDismissed
    || Boolean(activeAgentId);
  const providersSuggestions = argumentSuggestionsOff
    ? []
    : providersCompletions(commandInput, inputCursorOffset, managedProviders);
  const settingsSuggestions = argumentSuggestionsOff
    ? []
    : settingsCompletions(commandInput, inputCursorOffset, cwd);
  const pathSuggestions = (!shellMode && activeAgentId) || stashOpen || commandSuggestionsDismissed
    || isCommandInput(commandInput)
    || !shouldAutoShowPathCompletions(commandInput, inputCursorOffset)
    ? []
    : pathCompletions(
      commandInput,
      inputCursorOffset,
      shellMode && activeAgent ? activeAgent.worktree.path : cwd,
    );
  const suggestionCount = commandSuggestions.length
    || providersSuggestions.length
    || settingsSuggestions.length
    || pathSuggestions.length;
  // Every match stays selectable. Only SUGGESTION_ROWS of them are on screen,
  // and the window scrolls with the selection.
  const suggestionIndex = Math.min(commandCursor, Math.max(0, suggestionCount - 1));
  const suggestionStart = suggestionWindowStart(suggestionIndex, suggestionCount);
  const visibleSettingRows = filterSettingsRows(settingsQuery);
  const visibleModels = useMemo(() => filterModels(
    modelRuntime.getAvailableSnapshot(),
    modelQuery,
    (providerId) => (modelRuntime as any).getProvider?.(providerId)?.name ?? "",
  ), [modelRuntime, modelId, modelQuery, loginPage]);

  const inputRef = useRef<TextareaRenderable>(null);
  const inputModeRef = useRef(false);
  const shellModeRef = useRef(false);
  const transcriptScrollRef = useRef<ScrollBoxRenderable>(null);
  const questionnaireInputRef = useRef<TextareaRenderable>(null);
  const spawnPreviewInputRef = useRef<TextareaRenderable>(null);
  const settingsOpenRef = useRef(settingsOpen);
  const triggersOpenRef = useRef(false);
  const processTabRef = useRef<ProcessTab>("triggers");
  const settingsPageRef = useRef(page);
  const settingsSearchFocusedRef = useRef(settingsSearchFocused);
  const focusInputAfterSwitch = useRef(false);
  const activeAgentIdRef = useRef<string | null>(null);
  const agentSelectorCursorRef = useRef(0);
  const triggerCursorRef = useRef(0);
  const shellCursorRef = useRef(0);
  const commandCursorRef = useRef(0);
  const commandSuggestionsDismissedRef = useRef(false);
  const pathCompletionCycle = useRef<{
    sourceValue: string;
    completions: PathCompletion[];
    index: number;
    currentValue: string;
    currentCursor: number;
  } | null>(null);
  const stashRef = useRef(stash);
  const stashOpenRef = useRef(false);
  const stashCursorRef = useRef(-1);
  const stashSelectionRef = useRef<Set<number>>(new Set());
  const stashSelectionAnchor = useRef<number | null>(null);
  const pendingImages = useRef<PendingImage[]>([]);
  const nextImageId = useRef(1);
  const lastInputValue = useRef("");
  const pendingPastedTexts = useRef<PendingPastedText[]>([]);
  const nextPastedTextId = useRef(1);
  /** Pasted-text files consumed by a send whose turn has not settled yet. */
  const postTurnPastedTexts = useRef(new Map<string, PendingPastedText[]>());
  const previousSubagentStatus = useRef(new Map<string, string>());
  const imagePasteBusy = useRef(false);
  const loginTextPasteBusy = useRef(false);
  const viewDrafts = useRef(new Map<string, string>());
  const viewEditingStashIndices = useRef(new Map<string, number | null>());
  const spawnPreviewRestoreView = useRef<{ active: boolean; agentId: string | null }>({
    active: false,
    agentId: null,
  });
  /** Cache row currently checked out into the selected transcript input. */
  const editingStashIndex = useRef<number | null>(null);
  /**
   * Text to install after the cache view closes.
   *
   * Closing the cache changes the textarea placeholder. OpenTUI can apply that
   * placeholder commit after an imperative setText call and restore the empty
   * input on Windows. A layout effect orders the text write after that commit.
   */
  const pendingStashCheckout = useRef<{ index: number; text: string } | null>(null);
  const quitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastQuitPress = useRef(0);
  const cancelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastCancelPress = useRef<number | null>(null);
  const cancelTarget = useRef<string | null>(null);
  // Prompt history. `cursor` is null while editing a fresh line; `draft` holds
  // that line so walking back down restores it.
  const history = useRef<string[]>(promptHistoryStore.load(cwd));
  const histCursor = useRef<number | null>(null);
  const draft = useRef("");
  /** The prompt in flight, so Esc can hand it back for editing. */
  const inFlight = useRef("");
  // Mirrors `busy` for the keyboard handler: a keypress can land before React
  // has re-rendered, and the handler's closure would still read the old value.
  const busyRef = useRef(false);
  // True only while the main agent really runs a turn. `busy` also covers UI
  // work such as /compress, /clear, /worktree, /check-path and a session
  // switch, and steering into an idle session only queues text that no turn
  // picks up, so steer-versus-prompt must read this instead.
  const streamingRef = useRef(false);
  /** True while a session switch or /clear is replacing the session object. */
  const sessionSwitchRef = useRef(false);
  /** True while the running main-agent turn started from a direct user prompt. */
  const userTurnActiveRef = useRef(false);
  /** Text of the final assistant message; reset at each assistant message start. */
  const answerBufRef = useRef("");
  /** User prompt and steer texts of the running main turn, oldest first. */
  const turnPromptsRef = useRef<NewsPrompt[]>([]);
  const resetQuitArm = () => {
    lastQuitPress.current = 0;
    clearTimeout(quitTimer.current);
    setQuitArmed(false);
  };
  const resetCancelArm = () => {
    lastCancelPress.current = null;
    cancelTarget.current = null;
    clearTimeout(cancelTimer.current);
    setCancelArmed(false);
  };
  const setEditingStash = (index: number | null) => {
    editingStashIndex.current = index;
    setEditingStashIndexState(index);
  };
  const setCommandSuggestionsClosed = (closed: boolean) => {
    commandSuggestionsDismissedRef.current = closed;
    setCommandSuggestionsDismissed(closed);
  };
  const setWorking = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  const setShellInputMode = (value: boolean) => {
    shellModeRef.current = value;
    setShellMode(value);
    if (!value) return;
    inputModeRef.current = false;
    setInputMode(false);
    setStashMode(false);
  };
  const closeSettings = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    queueMicrotask(() => inputRef.current?.focus());
  };
  const setTriggerPopup = (open: boolean, restoreFocus = true) => {
    triggersOpenRef.current = open;
    setTriggersOpen(open);
    if (!open && restoreFocus) queueMicrotask(() => inputRef.current?.focus());
  };
  const openTriggers = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setNewsOpen(false);
    newsOpenRef.current = false;
    setStatsOpen(false);
    statsOpenRef.current = false;
    setStashMode(false);
    processTabRef.current = "triggers";
    setProcessTab("triggers");
    const nextCursor = Math.min(triggerCursorRef.current, Math.max(0, triggers.length - 1));
    triggerCursorRef.current = nextCursor;
    setTriggerCursor(nextCursor);
    setTriggerPopup(true);
  };
  const openProcesses = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setNewsOpen(false);
    newsOpenRef.current = false;
    setStatsOpen(false);
    statsOpenRef.current = false;
    setStashMode(false);
    const nextTriggerCursor = Math.min(triggerCursorRef.current, Math.max(0, triggers.length - 1));
    const nextShellCursor = Math.min(shellCursorRef.current, Math.max(0, shells.length - 1));
    triggerCursorRef.current = nextTriggerCursor;
    shellCursorRef.current = nextShellCursor;
    setTriggerCursor(nextTriggerCursor);
    setShellCursor(nextShellCursor);
    setTriggerPopup(true);
  };
  const startupWarningsRef = useRef([...startupWarnings]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loginControllerRef = useRef<LoginController | null>(null);

  if (!loginControllerRef.current) {
    loginControllerRef.current = new LoginController(modelRuntime, () => sessionRef.current, setLoginPage, (id) => id && setModelId(id), () => setLoginOpen(false));
  }
  // Built on first use, because its dependencies close over helpers that this
  // component defines further down.
  const providersControllerRef = useRef<ProvidersController | null>(null);
  // The key handler runs outside render, so it reads the providers from a ref.
  const managedProvidersRef = useRef<ProviderEntry[]>([]);

  const setSelectedStashRange = (indices: Set<number>, anchor: number | null) => {
    stashSelectionRef.current = indices;
    stashSelectionAnchor.current = anchor;
    setStashSelection(indices);
  };

  const clearStashSelection = () => setSelectedStashRange(new Set(), null);

  const setStashMode = (open: boolean) => {
    stashOpenRef.current = open;
    stashCursorRef.current = -1;
    clearStashSelection();
    setStashOpen(open);
    setStashCursor(-1);
  };

  const setSelectedStash = (index: number) => {
    stashCursorRef.current = index;
    setStashCursor(index);
  };

  const refreshHistoryAfterStashMutation = () => {
    history.current = promptHistoryStore.load(cwd);
    histCursor.current = null;
  };

  const addToStash = (prompt: string, executed = false) => {
    const next = promptStashStore.append(cwd, prompt, executed);
    stashRef.current = next;
    setStash(next);
    refreshHistoryAfterStashMutation();
    if (stashOpenRef.current) setSelectedStash(-1);
  };

  const executeStashedPrompt = (index: number) => {
    const next = promptStashStore.markExecuted(cwd, index);
    stashRef.current = next;
    setStash(next);
    refreshHistoryAfterStashMutation();
  };

  const replaceStashedPrompt = (index: number, prompt: string, executed: boolean) => {
    const next = promptStashStore.replace(cwd, index, prompt, executed);
    stashRef.current = next;
    setStash(next);
    refreshHistoryAfterStashMutation();
  };

  const deleteStashedPrompt = (index: number) => {
    clearStashSelection();
    const prompt = stashRef.current[index];
    if (!prompt) return;
    const next = promptStashStore.remove(cwd, index);
    stashRef.current = next;
    setStash(next);
    history.current = promptHistoryStore.load(cwd);
    histCursor.current = null;

    const editingIndex = editingStashIndex.current;
    if (editingIndex === index) setEditingStash(null);
    else if (editingIndex !== null && editingIndex > index) {
      setEditingStash(editingIndex - 1);
    }
    // The stash is shared across agent views, so a delete shifts the indices
    // that every other view checked out. Reindex the saved per-view values too,
    // or a later submit in another view would overwrite the wrong cached row.
    for (const [key, value] of viewEditingStashIndices.current) {
      if (value === index) viewEditingStashIndices.current.set(key, null);
      else if (value !== null && value > index) viewEditingStashIndices.current.set(key, value - 1);
    }

    if (next.length === 0) setStashMode(false);
    else setSelectedStash(Math.min(index, next.length - 1));
  };

  const clearPendingImages = () => {
    for (const image of pendingImages.current) removePendingImage(image);
    pendingImages.current = [];
    nextImageId.current = 1;
  };

  const clearPendingPastedTexts = () => {
    for (const pasted of pendingPastedTexts.current) removePendingPastedText(pasted);
    pendingPastedTexts.current = [];
    nextPastedTextId.current = 1;
  };

  const releasePostTurnPastedTexts = (targetKey: string) => {
    const files = postTurnPastedTexts.current.get(targetKey);
    if (!files) return;
    postTurnPastedTexts.current.delete(targetKey);
    for (const pasted of files) removePendingPastedText(pasted);
  };

  const syncInputMetrics = () => {
    const input = inputRef.current;
    // A queued frame or microtask can still run after the renderer destroys the
    // textarea on shutdown or test teardown, and the editor view, the plain
    // text, and the visual cursor all throw once that has happened.
    if (!input || input.isDestroyed) return;
    const totalRows = input.editorView.getTotalVirtualLineCount();
    const rows = Math.min(MAX_INPUT_ROWS, Math.max(1, totalRows));
    const cursorRow = input.cursorOffset >= input.plainText.length
      ? rows - 1
      : Math.max(0, Math.min(rows - 1, input.visualCursor.visualRow));
    setInputRows(rows);
    setInputCursorRow(cursorRow);
    setInputCursorOffset(input.cursorOffset);
  };

  const scheduleInputMetrics = () => queueMicrotask(syncInputMetrics);

  const setEditorText = (
    value: string,
    cursorOffset = value.length,
    preserveImages = false,
  ) => {
    if (!preserveImages && pendingImages.current.length > 0) clearPendingImages();
    if (!preserveImages && pendingPastedTexts.current.length > 0) clearPendingPastedTexts();
    const input = inputRef.current;
    if (input) {
      input.setText(value);
      input.cursorOffset = Math.max(0, Math.min(cursorOffset, value.length));
    }
    lastInputValue.current = value;
    setCommandSuggestionsClosed(false);
    commandCursorRef.current = 0;
    setCommandCursor(0);
    setCommandInput(value);
    scheduleInputMetrics();
  };

  useLayoutEffect(() => {
    if (stashOpen) return;
    const checkout = pendingStashCheckout.current;
    if (!checkout) return;
    pendingStashCheckout.current = null;
    if (editingStashIndex.current !== checkout.index) return;
    setEditorText(checkout.text);
    inputRef.current?.focus();
  });

  const handleInput = (nextValue: string) => {
    pathCompletionCycle.current = null;
    const edit = { previous: lastInputValue.current, next: nextValue };

    // Editing any part of a marker deletes the whole attachment and its temp
    // file at once. Both collections share one running draft, so the pastes
    // prune against what the images already cut, and both are re-anchored
    // afterwards against the final value.
    const imagePrune = pruneEditedMarkers(pendingImages.current, {
      ...edit,
      value: nextValue,
      cursor: null,
    });
    const pastedPrune = pruneEditedMarkers(pendingPastedTexts.current, {
      ...edit,
      value: imagePrune.value,
      cursor: imagePrune.cursor,
    });
    const value = pastedPrune.value;
    const cleanupCursor = pastedPrune.cursor;

    const images = reindexMarkers(imagePrune.kept, value);
    const pastes = reindexMarkers(pastedPrune.kept, value);
    pendingImages.current = images.kept;
    pendingPastedTexts.current = pastes.kept;

    for (const image of [...imagePrune.removed, ...images.removed]) removePendingImage(image);
    for (const pasted of [...pastedPrune.removed, ...pastes.removed]) removePendingPastedText(pasted);
    const removedImages = imagePrune.removed.length + images.removed.length;
    const removedPastedTexts = pastedPrune.removed.length + pastes.removed.length;

    if (value !== nextValue && inputRef.current) {
      inputRef.current.setText(value);
      inputRef.current.cursorOffset = Math.min(cleanupCursor ?? value.length, value.length);
    }
    lastInputValue.current = value;
    setCommandSuggestionsClosed(false);
    commandCursorRef.current = 0;
    setCommandCursor(0);
    setCommandInput(value);
    scheduleInputMetrics();
    if (removedImages > 0 || removedPastedTexts > 0) {
      const removed = [
        removedImages > 0
          ? `${removedImages} image attachment${removedImages === 1 ? "" : "s"}`
          : "",
        removedPastedTexts > 0
          ? `${removedPastedTexts} pasted-text attachment${removedPastedTexts === 1 ? "" : "s"}`
          : "",
      ].filter(Boolean).join(" and ");
      append({
        kind: "text",
        role: "system",
        text: `removed ${removed} after its marker was edited`,
      });
    }
  };

  const handleTextareaChange = () => handleInput(inputRef.current?.plainText ?? "");

  const clearActiveDraft = () => {
    resetQuitArm();
    setEditorText("");
    const viewKey = activeAgentIdRef.current ?? "main";
    viewDrafts.current.set(viewKey, "");
    setEditingStash(null);
    histCursor.current = null;
    draft.current = "";
    setSelectedStash(-1);
  };

  // The attachment goes to the selected transcript, so its model decides. An
  // unknown child model keeps the main answer instead of blocking the paste.
  const imageInputSupported = () => {
    const targetId = activeAgentIdRef.current;
    const targetModelId = targetId
      ? subagentManager.getAgents().find((agent) => agent.id === targetId)?.modelId
      : undefined;
    const target = targetModelId
      ? modelRuntime.getAvailableSnapshot().find(
        (model) => `${model.provider}/${model.id}` === targetModelId,
      )
      : undefined;
    return (target ?? session.agent.state.model).input.includes("image");
  };

  const pasteClipboardImage = async () => {
    if (imagePasteBusy.current) return;
    if (!imageInputSupported()) {
      append({
        kind: "text",
        role: "error",
        text: activeAgentIdRef.current
          ? "the selected agent's model does not support image input"
          : "the current model does not support image input",
      });
      return;
    }

    imagePasteBusy.current = true;
    try {
      const captured = await captureImage();
      const input = inputRef.current;
      if (!input) {
        removePendingImage({ ...captured, id: 0, marker: "", start: 0, end: 0 });
        return;
      }

      const current = input.plainText;
      const selection = input.hasSelection() ? input.getSelection() : null;
      let start = selection ? Math.min(selection.start, selection.end) : input.cursorOffset;
      let end = selection ? Math.max(selection.start, selection.end) : start;
      const intersects = (item: { start: number; end: number }) =>
        start === end
          ? start > item.start && start < item.end
          : start < item.end && end > item.start;

      // Attachment markers are atomic. Expand a selection or an internal caret
      // to cover each touched marker before inserting the new image marker.
      for (const item of [...pendingImages.current, ...pendingPastedTexts.current]) {
        if (!intersects(item)) continue;
        start = Math.min(start, item.start);
        end = Math.max(end, item.end);
      }
      pendingImages.current = pendingImages.current.filter((image) => {
        if (!intersects(image)) return true;
        removePendingImage(image);
        return false;
      });
      pendingPastedTexts.current = pendingPastedTexts.current.filter((pasted) => {
        if (!intersects(pasted)) return true;
        removePendingPastedText(pasted);
        return false;
      });

      const id = nextImageId.current++;
      const marker = `[Image #${id}]`;
      const value = `${current.slice(0, start)}${marker}${current.slice(end)}`;
      const image: PendingImage = {
        ...captured,
        id,
        marker,
        start,
        end: start + marker.length,
      };
      pendingImages.current.push(image);
      pendingImages.current = pendingImages.current.map((pending) => {
        const markerStart = value.indexOf(pending.marker);
        return { ...pending, start: markerStart, end: markerStart + pending.marker.length };
      });
      pendingPastedTexts.current = pendingPastedTexts.current.map((pending) => {
        const markerStart = value.indexOf(pending.marker);
        return { ...pending, start: markerStart, end: markerStart + pending.marker.length };
      });
      setEditorText(value, start + marker.length, true);
    } catch (error) {
      append({ kind: "text", role: "error", text: `image paste failed: ${String(error)}` });
    } finally {
      imagePasteBusy.current = false;
    }
  };

  const pasteLoginClipboardText = async () => {
    if (loginTextPasteBusy.current) return;
    loginTextPasteBusy.current = true;
    try {
      const text = await readPastedText();
      loginControllerRef.current?.pasteText(text);
    } catch {
      append({ kind: "text", role: "error", text: "text paste failed" });
    } finally {
      loginTextPasteBusy.current = false;
    }
  };

  /**
   * Replace one large or multiline paste with a `[Pasted text #n]` marker. The text is
   * written to a private temp file that the agent can `read` during the turn.
   */
  const stageLargePastedText = (event: PasteEvent) => {
    if (
      questionnaire ||
      spawnPreview ||
      triggersOpenRef.current ||
      agentSelectorOpen ||
      helpOpen ||
      historyOpen ||
      newsOpenRef.current ||
      todoOpenRef.current ||
      statsOpenRef.current ||
      settingsOpenRef.current
    ) return;
    const input = inputRef.current;
    if (!input?.focused) return;
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (!shouldStagePastedText(text)) return;

    event.stopPropagation();
    const id = nextPastedTextId.current++;
    const marker = `[Pasted text #${id}]`;
    const staged = stagePastedText(text);
    const current = input.plainText;
    const selection = input.hasSelection() ? input.getSelection() : null;
    const start = selection ? selection.start : input.cursorOffset;
    const end = selection ? selection.end : start;
    const value = `${current.slice(0, start)}${marker}${current.slice(end)}`;
    pendingPastedTexts.current.push({
      id,
      marker,
      path: staged.path,
      bytes: staged.bytes,
      start,
      end: start + marker.length,
    });
    setEditorText(value, start + marker.length, true);
  };

  const append = (line: Line) =>
    setTx((t) => {
      const f = flushed(t);
      return { ...f, lines: [...f.lines, line] };
    });

  /** A retried settlement delivery repeats its line, so keep one row per id. */
  const appendMainLine = (line: Line) =>
    setTx((t) => {
      const messageId = line.kind === "agent-message" ? line.messageId : undefined;
      const duplicate = messageId !== undefined && t.lines.some(
        (item) => item.kind === "agent-message" && item.messageId === messageId,
      );
      if (duplicate) return t;
      const f = flushed(t);
      return { ...f, lines: [...f.lines, line] };
    });

  const addPending = (pending: PendingLine) =>
    setTx((value) => ({ ...value, pending: [...value.pending, pending] }));

  const resolvePending = (id: string) =>
    setTx((value) => resolvePendingDelivery(value, id));

  const dropPending = (id: string) =>
    setTx((value) => ({
      ...value,
      pending: value.pending.filter((item) => item.id !== id),
    }));

  const resolvePendingText = (text: string) =>
    setTx((value) => {
      const pending = value.pending.find((item) => item.deliveryText === text);
      return pending ? resolvePendingDelivery(value, pending.id) : value;
    });

  useEffect(() => sandboxWarningSource?.subscribeWarnings((warning) => {
    append({ kind: "text", role: "system", text: warning });
  }), [sandboxWarningSource]);

  useEffect(() => {
    setStatsRevision((revision) => revision + 1);
    return statsManager?.subscribe(() => setStatsRevision((revision) => revision + 1));
  }, [statsManager, session]);


  useEffect(() => triggerManager?.subscribe(() => {
    setTriggerRevision((revision) => revision + 1);
    const count = triggerManager.getTriggers().length;
    const next = Math.min(triggerCursorRef.current, Math.max(0, count - 1));
    triggerCursorRef.current = next;
    setTriggerCursor(next);
  }), [triggerManager]);

  useEffect(() => shellManager?.subscribe(() => {
    setShellRevision((revision) => revision + 1);
    const count = shellManager.list().length;
    const next = Math.min(shellCursorRef.current, Math.max(0, count - 1));
    shellCursorRef.current = next;
    setShellCursor(next);
  }), [shellManager]);

  useEffect(() => {
    if (!shellManager || !triggersOpen || processTab !== "shells") return;
    const shell = shells[shellCursor];
    if (!shell || !shell.output.exists) return;
    let active = true;
    void shellManager.getOutput(shell.id, { lineLimit: 20 }).then((result) => {
      if (!active) return;
      setShellTails((tails) => tails[shell.id] === result.tail
        ? tails
        : { ...tails, [shell.id]: result.tail });
    }).catch(() => {});
    return () => { active = false; };
  }, [shellManager, triggersOpen, processTab, shellCursor, shellRevision]);

  useEffect(
    () => subagentManager.subscribe((event) => {
      if (event.type === "main-line") appendMainLine(event.line);
      else if (event.type === "main-pending-add") addPending(event.pending);
      else if (event.type === "main-pending-resolve") resolvePending(event.id);
      else if (event.type === "main-pending-drop") dropPending(event.id);
      else if (event.type === "news-changed") {
        const loaded = loadNewsItems(session.sessionFile);
        newsRef.current = loaded;
        setNews(loaded);
        setTx((value) => ({ ...value, lines: tagNewsLines(value.lines, loaded) }));
      }
      setAgentRevision((revision) => revision + 1);
    }),
    [subagentManager, session],
  );

  useEffect(() => {
    // A delegate answering counts as work even though it is not a managed
    // agent, or the terminal reads as idle while AFK decides something.
    orcaStatus?.update({
      state: resolveOrcaStatusState({
        working: busy || activeSubagentCount > 0 || afkAnswering,
        waitingForUser: Boolean(visibleQuestionnaire),
      }),
      model: session.agent.state.model?.id,
      sessionKey: session.sessionId,
    });
    terminalTitle?.update({
      working: busy || activeSubagentCount > 0 || afkAnswering,
      activeSubagentCount,
    });
  }, [
    terminalTitle,
    orcaStatus,
    busy,
    activeSubagentCount,
    afkAnswering,
    visibleQuestionnaire,
    session.sessionId,
    session.agent.state.model?.id,
  ]);

  useEffect(() => spawnPreviewManager?.subscribe(() => {
    setSpawnPreviewRevision((revision) => revision + 1);
  }), [spawnPreviewManager]);

  useEffect(() => {
    if (!questionnaireManager) return;
    return questionnaireManager.subscribe(() => {
      if (questionnaireManager.current()) {
        settingsOpenRef.current = false;
        setSettingsOpen(false);
        setHelpOpen(false);
        setHistoryOpen(false);
        setAgentSelectorOpen(false);
        setTriggerPopup(false, false);
        setLoginOpen(false);
        setNewsOpen(false);
        newsOpenRef.current = false;
        setStatsOpen(false);
        statsOpenRef.current = false;
      }
      setQuestionnaireRevision((revision) => revision + 1);
    });
  }, [questionnaireManager]);

  useEffect(() => {
    if (activeAgentId && !agents.some((agent) => agent.id === activeAgentId)) {
      activeAgentIdRef.current = null;
      setActiveAgentId(null);
    }
  }, [activeAgentId, agents.map((agent) => agent.id).join(":")]);

  const delta = (kind: "assistant" | "thinking", text: string) =>
    setTx((t) => streamedDelta(t, kind, text));

  const patchTool = (id: string, patch: Partial<ToolCall>) =>
    setTx((t) => ({
      ...t,
      lines: t.lines.map((l) =>
        l.kind === "tool" && l.call.id === id ? { kind: "tool", call: { ...l.call, ...patch } } : l,
      ),
    }));

  useEffect(() => {
    // A replaced session cannot still be running the previous session's turn.
    streamingRef.current = false;
    void subagentManager
      .bindMainSession(session.sessionManager, cwd)
      .catch((error) => append({ kind: "text", role: "error", text: String(error) }));
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
    setModelId(session.agent.state.model.id);
    const visibleStartupWarnings = startupWarningsRef.current;
    startupWarningsRef.current = [];
    const replayedLines = [
      ...replayEntries(session.sessionManager.buildContextEntries(), cwd, true),
      ...visibleStartupWarnings.map((text): Line => ({ kind: "text", role: "system", text })),
    ];
    const loadedNews = loadNewsItems(session.sessionFile);
    newsRef.current = loadedNews;
    setNews(loadedNews);
    setNewsOpen(false);
    setNewsCursor(0);
    newsCursorRef.current = 0;
    setTx({
      lines: tagNewsLines(replayedLines, loadedNews),
      stream: null,
      pending: [],
    });
    // A goal belongs to one session. /clear and /new open a session with no
    // companion file, so the old goal cannot follow the user into it.
    clearGoalJudge();
    goalFormulationRef.current = null;
    // Settings belong to one session too, so /clear and /new fall back to the
    // global defaults rather than carrying the old session's overrides in.
    // A relocation belongs to one session. /clear and /new open a session with
    // no companion file, so the old worktree cannot follow the user into it.
    const loadedRelocation = loadRelocation(session.sessionFile);
    relocationRef.current = loadedRelocation;
    setRelocation(loadedRelocation);
    const loadedOverrides = loadSessionSettings(session.sessionFile);
    sessionOverridesRef.current = loadedOverrides;
    setSessionOverrides(loadedOverrides);
    const mergedSettings = mergeSessionSettings(globalSettingsRef.current, loadedOverrides);
    settingsRef.current = mergedSettings;
    setSettings(mergedSettings);
    const loadedGoal = loadGoal(session.sessionFile);
    goalRef.current = loadedGoal;
    setGoalState(loadedGoal);
    const owed = loadedGoal?.state === "active" ? loadedGoal.pendingContinuation : undefined;
    if (owed) {
      // The continuation is durable until its turn actually starts. A crash in
      // that window leaves it owed; a crash after delivery leaves it in the
      // replayed transcript, and then it is already paid.
      const alreadyDelivered = replayedLines.some(
        (line) => line.kind === "text" && line.role === "user" && line.text === owed.text,
      );
      if (alreadyDelivered) {
        const settled = continuationDelivered(loadedGoal!, owed.id);
        goalRef.current = settled;
        setGoalState(settled);
        saveGoal(session.sessionFile, settled);
      } else {
        void deliverGoalContinuation(owed);
      }
    }
    setUsage(sessionUsage(session));
    if (focusInputAfterSwitch.current) {
      focusInputAfterSwitch.current = false;
      inputRef.current?.focus();
    }

    return session.subscribe((event) => {
      switch (event.type) {
        case "message_start": {
          if (event.message.role === "assistant") {
            answerBufRef.current = "";
          } else if (event.message.role === "user") {
            const text = messageText(event.message);
            if (text) resolvePendingText(text);
          }
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            setTx((value) => settleTranscriptMessage(value));
          }
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            delta("assistant", update.delta);
            answerBufRef.current += update.delta;
          }
          // Captured whatever the setting says, so turning it on reveals the
          // reasoning of this turn rather than only of the next one.
          else if (update.type === "thinking_delta") delta("thinking", update.delta);
          break;
        }
        case "tool_execution_start":
          append({
            kind: "tool",
            call: startedToolCall(
              { id: event.toolCallId, name: event.toolName, args: event.args },
              cwd,
            ),
          });
          break;
        case "tool_execution_update":
          if (event.toolName === "bash") {
            patchTool(event.toolCallId, { output: bashOutput(event.partialResult) });
          }
          break;
        case "tool_execution_end":
          patchTool(event.toolCallId, settledToolCall({
            name: event.toolName,
            result: event.result,
            isError: event.isError,
            toolCallId: event.toolCallId,
          }));
          break;
        case "agent_start":
          streamingRef.current = true;
          setWorking(true);
          break;
        case "turn_end": {
          const u = (event.message as any)?.usage;
          if (u) {
            setUsage((prev) => addTurnUsage(
              prev,
              u,
              session.agent.state.model.contextWindow,
            ));
          }
          break;
        }
        case "thinking_level_changed":
          setThinkingLevel(event.level as ThinkingLevel);
          break;
        case "agent_settled": {
          // The turn is over, so a row still spinning never got a result. It
          // settles the way a resumed transcript already shows it, rather than
          // spinning for the rest of the session.
          setTx((value) => ({
            ...value,
            lines: value.lines.map((line) =>
              line.kind === "tool" && line.call.state === "running" && !line.call.userInitiated
                ? { kind: "tool", call: interruptedToolCall(line.call) }
                : line,
            ),
          }));
          const answer = answerBufRef.current;
          if (userTurnActiveRef.current && answer.trim()) {
            const item: NewsItem = {
              id: randomUUID().slice(0, 12),
              text: answer.trim(),
              at: Date.now(),
              read: false,
              answered: false,
              prompts: turnPromptsRef.current,
            };
            const nextNews = [item, ...newsRef.current].slice(0, NEWS_CAPACITY);
            newsRef.current = nextNews;
            setNews(nextNews);
            saveNewsItems(session.sessionFile, nextNews);
            setTx((value) => {
              const next = flushed(value);
              const index = next.lines.findLastIndex(
                (line) => line.kind === "text" && line.role === "assistant",
              );
              if (index < 0) return next;
              const lines = next.lines.map((line, i) =>
                i === index ? { ...line, newsId: item.id } as Line : line,
              );
              return { ...next, lines };
            });
          } else {
            setTx(flushed);
          }
          answerBufRef.current = "";
          userTurnActiveRef.current = false;
          turnPromptsRef.current = [];
          releasePostTurnPastedTexts("main");
          streamingRef.current = false;
          setWorking(false);
          // A `/goalf` interview settles into a proposal, never into goal work.
          if (goalFormulationRef.current) {
            goalFormulationRef.current = null;
            void finishGoalFormulation(answer).catch((error) =>
              append({ kind: "text", role: "error", text: String(error) }));
            break;
          }
          {
            const current = goalRef.current;
            if (current?.state === "active") persistGoal(noteSettledWork(current));
          }
          // The turn is over, so a move the model asked for can happen now.
          // Run it before scheduling a judge: the judge should read the
          // repository the session actually ends up in.
          if (pendingRelocationRef.current) {
            runPendingRelocation();
            break;
          }
          maybeScheduleGoalJudge();
          break;
        }
      }
    });
  }, [session]);

  useEffect(
    () => () => {
      clearTimeout(quitTimer.current);
      clearTimeout(cancelTimer.current);
      clearPendingImages();
      cleanupPendingImages();
      const pastedTempFiles = [...pendingPastedTexts.current];
      for (const files of postTurnPastedTexts.current.values()) pastedTempFiles.push(...files);
      for (const pasted of pastedTempFiles) removePendingPastedText(pasted);
      pendingPastedTexts.current = [];
      postTurnPastedTexts.current.clear();
      cleanupPendingPastedTexts();
      spawnPreviewManager?.cancelAll("shutdown");
    },
    [spawnPreviewManager],
  );

  useEffect(() => {
    resetCancelArm();
  }, [activeAgentId, visibleBusy]);

  // Release pasted-text temp files once the subagent turn that consumed them settles.
  useEffect(() => {
    for (const agent of agents) {
      const previous = previousSubagentStatus.current.get(agent.id);
      previousSubagentStatus.current.set(agent.id, agent.status);
      if (
        (previous === "starting" || previous === "running") &&
        agent.status !== "starting" &&
        agent.status !== "running"
      ) {
        releasePostTurnPastedTexts(agent.id);
      }
    }
    // A judge that settles without calling goal_verdict has said nothing. Drop
    // it, or `judgeInFlight` would stay true and stall the goal for good.
    const judge = judgeRef.current;
    const judgeId = judgeAgentIdRef.current;
    if (judge && judgeId && !judge.verdictSeen) {
      const record = agents.find((agent) => agent.id === judgeId);
      if (!record || (record.status !== "starting" && record.status !== "running")) {
        settleGoalReview(
          judge.ticket.judgeId,
          "error",
          "the review ended without a verdict; no turn was started",
        );
        clearGoalJudge();
      }
    }
  }, [agents.map((agent) => `${agent.id}:${agent.status}`).join("|")]);

  // The review trigger reacts to lifecycle changes only: the main agent
  // settling, the last worker settling, and queued messages being inserted.
  // There is no timer and no status poll anywhere in this path.
  useEffect(() => {
    maybeScheduleGoalJudge();
  }, [
    busy,
    activeSubagentCount,
    tx.pending.filter((pending) => !pending.delivered).length,
    goal?.id,
    goal?.state,
    goal?.workGeneration,
  ]);

  // Recalculate visual rows after wrapping, terminal resizes, or editor height changes.
  useEffect(() => {
    const timer = setTimeout(syncInputMetrics, 0);
    return () => clearTimeout(timer);
  }, [width, commandInput, inputRows, quitArmed, cancelArmed, editingStashIndexState]);

  // The editor reports cursor moves only when they go through the edit buffer
  // (typing, left/right). Vertical arrows, Home/End, and mouse clicks move the
  // visual cursor without that event, so re-measure after any rendered frame.
  // Nothing renders while the app is idle, so this check costs nothing then;
  // the keyboard handler re-measures vertical moves immediately on top of it.
  const renderer = useRenderer();
  useEffect(() => {
    const onFrame = () => scheduleInputMetrics();
    renderer.on("frame", onFrame);
    return () => {
      renderer.off("frame", onFrame);
    };
  }, [renderer]);

  // Drive the mounted window off the scroll position. The frame is the only
  // place both the position and the laid-out rows are known, and nothing
  // renders while the app is idle, so this costs nothing then. Everything it
  // reads is a ref, so the handler installed on mount stays correct.
  useEffect(() => {
    const onFrame = () => {
      const scroll = transcriptScrollRef.current;
      if (!scroll || scroll.isDestroyed) return;
      const viewportHeight = scroll.viewport.height;

      // A drag that ends against the top of the mounted rows asks for the
      // history above them. One window per gesture never reaches the start of a
      // long session, and every step holds the reader’s place, so the view
      // does not move and the first message stays out of reach. Mount the rest
      // instead, and leave the reader on it. This runs before the correction
      // below and drops it: the place to hold is the place they just left.
      if (!atWindowTop(scroll.scrollTop)) transcriptReaderDragRef.current = false;
      else if (transcriptReaderDragRef.current && transcriptWindowStartRef.current > 0) {
        transcriptReaderDragRef.current = false;
        transcriptWindowAnchorRef.current = null;
        ensureTranscriptRowMounted(0);
        return;
      }

      // Put the reader's row back under the rows that just mounted above it.
      const anchor = transcriptWindowAnchorRef.current;
      if (anchor) {
        const row = scroll.findDescendantById(`transcript-line-${anchor.index}`);
        const contentOffset = row ? row.y - scroll.content.y : anchor.contentOffset;
        if (row && contentOffset !== anchor.contentOffset) {
          const target = topAnchorScrollTop(
            contentOffset - anchor.viewportOffset,
            scroll.scrollHeight,
            viewportHeight,
          );
          // scrollBy, not scrollTop: it is the path that marks the scroll as
          // manual, and without that sticky-to-bottom drags the reader back to
          // the end of a transcript they are reading the middle of.
          if (target !== scroll.scrollTop) scroll.scrollBy({ x: 0, y: target - scroll.scrollTop });
          transcriptWindowAnchorRef.current = null;
        } else if (anchor.frames++ > ANCHOR_FRAME_BUDGET) {
          // The rows never arrived. Drop the anchor rather than hold a scroll
          // correction that would fire against some later, unrelated layout.
          transcriptWindowAnchorRef.current = null;
        }
      }

      const atBottom = atWindowBottom(scroll.scrollTop, scroll.scrollHeight, viewportHeight);
      transcriptAtBottomRef.current = atBottom;
      if (atBottom) {
        // A reveal that is still waiting for its row holds the window. The view
        // does not leave the end until it scrolls, so releasing here would
        // unmount the very row it just asked for, every frame until it gave up.
        if (transcriptRevealsRef.current > 0) return;
        // Back at the end: the window may shrink to its tail again. Releasing
        // the floor only changes a ref, so the render that acts on it has to be
        // asked for. Once per return to the end, never on every frame.
        if (transcriptWindowFloorRef.current !== Number.POSITIVE_INFINITY) {
          transcriptWindowFloorRef.current = Number.POSITIVE_INFINITY;
          setTranscriptWindowTick((tick) => tick + 1);
        }
        return;
      }
      if (transcriptWindowStartRef.current <= 0) return;
      if (!nearWindowTop(scroll.scrollTop, viewportHeight)) return;
      // One mount at a time. The anchor clears once the rows are laid out.
      if (transcriptWindowAnchorRef.current) return;

      const current = transcriptWindowStartRef.current;
      const next = extendedWindowStart(current, transcriptWindowRowsRef.current);
      if (next === current) return;
      const row = scroll.findDescendantById(`transcript-line-${current}`);
      transcriptWindowAnchorRef.current = row
        ? {
          index: current,
          viewportOffset: row.y - scroll.viewport.y,
          contentOffset: row.y - scroll.content.y,
          frames: 0,
        }
        : null;
      transcriptWindowStartRef.current = next;
      transcriptWindowFloorRef.current = Math.min(transcriptWindowFloorRef.current, next);
      setTranscriptWindowTick((tick) => tick + 1);
    };
    renderer.on("frame", onFrame);
    return () => {
      renderer.off("frame", onFrame);
    };
  }, [renderer]);

  // Hosted web searches are not pi tool calls, so they arrive out of band.
  useEffect(() => {
    return observeSearchCalls(session.sessionId, (call) => {
      if (call.phase === "start") {
        append({
          kind: "tool",
          call: { id: call.id, name: "web_search", args: [call.query], state: "running" },
        });
      } else {
        patchTool(call.id, {
          state: call.ok ? "ok" : "error",
          ...(call.query ? { arg: call.query } : {}),
        });
      }
      // Hosted searches are not pi messages, so persist them as custom
      // session entries for replay without adding them to LLM context.
      persistSearchCall(session.sessionManager, call);
    });
  }, [session]);

  // Git branch, live-watched.
  useEffect(() => {
    // Re-subscribes on a move: the watcher holds a handle on one .git/HEAD, and
    // the worktree has its own.
    setBranch(readBranch(cwd));
    return watchBranch(cwd, () => setBranch(readBranch(cwd)));
  }, [cwd]);

  // Turn timer, only while the main agent is working.
  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const started = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!activeAgent || !visibleBusy) {
      setAgentElapsedSec(0);
      return;
    }
    const started = activeAgent.runStartedAt ?? activeAgent.updatedAt;
    const updateElapsed = () => setAgentElapsedSec(Math.floor((Date.now() - started) / 1000));
    updateElapsed();
    const id = setInterval(updateElapsed, 1000);
    return () => clearInterval(id);
  }, [activeAgent?.id, activeAgent?.status, activeAgent?.runStartedAt, visibleBusy]);

  const [relocation, setRelocation] = useState(
    () => loadRelocation(initialSession.sessionFile) ?? initialRelocation ?? null,
  );
  const relocationRef = useRef(relocation);
  relocationRef.current = relocation;
  const relocatingRef = useRef(false);

  /**
   * Roots the session may write right now.
   *
   * While it runs in a generated worktree the source repository joins them, so
   * the agent can still edit the project it came from. This is process-local
   * and never reaches the saved /check-path settings.
   */
  const liveCheckPaths = (settings: PumSettings, directory: string): string[] => {
    const record = relocationRef.current;
    const source = record?.location === "worktree" ? [record.sourceRoot] : [];
    return [...new Set([
      ...checkPathsForProject(settings, directory),
      ...forcedCheckPaths,
      ...source,
    ])];
  };

  /** Rebind everything the active directory decides, after a successful move. */
  const applyRelocation = (record: RelocationRecord) => {
    const target = relocationTargetDirectory(record);
    relocationRef.current = record;
    setRelocation(record);
    saveRelocation(session.sessionFile, record.location === "source" && !record.pending
      ? null
      : record);
    try {
      syncSessionResumeAliases(session.sessionFile, record);
    } catch (error) {
      appendMainLine({
        kind: "text",
        role: "error",
        text: `the session moved, but its resume alias could not be updated: ${String(error)}`,
      });
    }
    setCwd(target);
    // The check-mode roots follow the move immediately: the next tool call must
    // not be judged against the directory the session just left.
    setCheckModeConfig({
      profile: settingsRef.current.checkMode,
      model: settingsRef.current.checkModel,
      additionalPaths: liveCheckPaths(settingsRef.current, target),
    });
    void subagentManager.bindMainSession(session.sessionManager, target).catch(() => {});
    // Both are keyed by project, so the old directory's recall would otherwise
    // follow the session into the new one.
    history.current = promptHistoryStore.load(target);
    histCursor.current = null;
    setStash(promptStashStore.load(target));
  };

  const runWorktreeRelocation = async (command: { kind: "start"; directory?: string } | { kind: "return" }) => {
    const guardInput = {
      relocation: relocationRef.current,
      busy: busyRef.current,
      retainedChildren: subagentManager.getAgents().length,
      inFlight: relocatingRef.current,
    };
    const blocked = command.kind === "start"
      ? startRelocationBlockReason(guardInput)
      : returnRelocationBlockReason(guardInput);
    if (blocked) {
      appendMainLine({ kind: "text", role: "error", text: blocked });
      return;
    }
    if (!onRelocate) {
      appendMainLine({ kind: "text", role: "error", text: "this build cannot move a session" });
      return;
    }

    relocatingRef.current = true;
    try {
      const record = command.kind === "start"
        ? await beginWorktreeStart(command.directory)
        : beginWorktreeReturn();
      if (!record) return;

      const target = relocationTargetDirectory(record);
      appendMainLine({
        kind: "text",
        role: "system",
        text: `moving this session to ${target} (${record.branch})`,
      });
      const moved = await onRelocate(target);
      if (!moved) {
        // Creation may already have succeeded, so name what survived rather
        // than deleting a worktree the user can still use.
        appendMainLine({
          kind: "text",
          role: "error",
          text: `the session did not move; worktree ${record.name} is at ${record.worktreePath}`,
        });
        return;
      }
      applyRelocation(record);
      appendMainLine({
        kind: "text",
        role: "system",
        text: command.kind === "start"
          ? `now in worktree ${record.name} on ${record.branch}; ${record.sourceRoot} stays writable`
          : `back in ${record.sourceRoot}; worktree ${record.name} is preserved on ${record.branch}`,
      });
    } catch (error) {
      appendMainLine({ kind: "text", role: "error", text: String(error) });
    } finally {
      relocatingRef.current = false;
    }
  };

  const beginWorktreeStart = async (directory?: string): Promise<RelocationRecord | null> => {
    const started = await startWorktree(directory ?? cwdRef.current);
    const now = Date.now();
    const existing = relocationRef.current;
    return {
      id: `reloc-${randomUUID().slice(0, 8)}`,
      generation: (existing?.generation ?? 0) + 1,
      sourceRoot: started.sourceRoot,
      worktreePath: started.worktree.path,
      name: started.worktree.name,
      branch: started.worktree.branch,
      baseBranch: started.worktree.baseBranch,
      baseCommit: started.worktree.baseCommit,
      location: "worktree",
      createdAt: now,
      updatedAt: now,
    };
  };

  const beginWorktreeReturn = (): RelocationRecord | null => {
    const existing = relocationRef.current;
    if (!existing) return null;
    // Returning changes only where the session runs. The branch, the commits
    // and any uncommitted work in the worktree are left exactly as they are.
    return { ...existing, generation: existing.generation + 1, location: "source", updatedAt: Date.now() };
  };

  /**
   * Restore a relocated session to its worktree on resume.
   *
   * Runs once per session. A worktree deleted, pruned or reused outside PUM
   * fails closed: the record is dropped and the session stays in its source
   * repository rather than authorizing a path someone else may now own.
   */
  const restoredRelocationRef = useRef<string | null>(null);
  useEffect(() => {
    const record = relocationRef.current;
    if (!record || record.location !== "worktree") return;
    if (restoredRelocationRef.current === record.id) return;
    restoredRelocationRef.current = record.id;
    void (async () => {
      const trusted = relocationPathsTrusted(record, {
        worktreeExists: existsSync(record.worktreePath),
        worktreeBranch: readBranch(record.worktreePath) ?? undefined,
        sourceRoot: record.sourceRoot,
      });
      if (!trusted) {
        const alreadyInWorktree = pathIdentity(cwdRef.current) === pathIdentity(record.worktreePath);
        if (alreadyInWorktree && onRelocate) {
          const moved = await onRelocate(record.sourceRoot).catch(() => null);
          if (moved) {
            applyRelocation({
              ...record,
              generation: record.generation + 1,
              location: "source",
              updatedAt: Date.now(),
            });
            appendMainLine({
              kind: "text",
              role: "error",
              text: `worktree ${record.name} no longer matches ${record.branch}; returned to ${record.sourceRoot}`,
            });
            return;
          }
        }
        relocationRef.current = null;
        setRelocation(null);
        try {
          settleSessionResumeAliasesAtSource(session.sessionFile, record);
        } catch {
          // The stale worktree is still denied. Alias cleanup is best effort.
        }
        saveRelocation(session.sessionFile, null);
        appendMainLine({
          kind: "text",
          role: "error",
          text: alreadyInWorktree
            ? `worktree ${record.name} no longer matches ${record.branch}; its relocation record was removed`
            : `worktree ${record.name} no longer matches ${record.branch}; staying in ${record.sourceRoot}`,
        });
        return;
      }
      // A CLI worktree launch resumes in the recorded checkout already. It
      // still needs trust validation and the source root in the live roots.
      if (pathIdentity(cwdRef.current) === pathIdentity(record.worktreePath)) {
        applyRelocation(record);
        return;
      }
      if (!onRelocate) return;
      const moved = await onRelocate(record.worktreePath).catch(() => null);
      if (moved) applyRelocation(record);
    })();
  }, [session, relocation?.id]);

  /**
   * A move the model asked for, held until its turn settles.
   *
   * The tool call must finish against the directory it started in, so the
   * request is only recorded here and acted on from the settle handler.
   */
  const pendingRelocationRef = useRef<{ action: "start" | "return"; directory?: string } | null>(null);

  useEffect(() => {
    subagentManager.setRelocationRequestHandler?.((request) => {
      const guardInput = {
        relocation: relocationRef.current,
        // The tool runs mid-turn by definition, so the idle rule is checked
        // against everything except that turn.
        busy: false,
        retainedChildren: subagentManager.getAgents().length,
        inFlight: relocatingRef.current || pendingRelocationRef.current !== null,
      };
      const blocked = request.action === "start"
        ? startRelocationBlockReason(guardInput)
        : returnRelocationBlockReason(guardInput);
      if (blocked) return { accepted: false, message: blocked };
      pendingRelocationRef.current = request;
      return {
        accepted: true,
        message: request.action === "start"
          ? "A fresh worktree will be created and this session moved into it once this turn ends."
          : "This session will move back to its source repository once this turn ends.",
      };
    });
    return () => subagentManager.setRelocationRequestHandler?.(undefined);
  }, [subagentManager]);

  const runPendingRelocation = () => {
    const request = pendingRelocationRef.current;
    if (!request) return;
    pendingRelocationRef.current = null;
    void runWorktreeRelocation(request.action === "start"
      ? { kind: "start", ...(request.directory ? { directory: request.directory } : {}) }
      : { kind: "return" });
  };

  const update = (patch: Partial<PumSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (patch.webSearch !== undefined) webSearch.enabled = patch.webSearch;
    if (patch.writingStyle !== undefined) setWritingStyle(patch.writingStyle);
    if (patch.explanationStrength !== undefined) {
      setExplanationStrength(patch.explanationStrength);
    }
    if (patch.sandboxMode !== undefined) {
      onSandboxModeChange?.(forcedSandboxMode ?? patch.sandboxMode);
    }
    if (patch.checkMode !== undefined || patch.checkModel !== undefined || patch.checkPaths !== undefined) {
      setCheckModeConfig({
        profile: next.checkMode,
        model: next.checkModel,
        additionalPaths: liveCheckPaths(next, cwd),
      });
    }
    if (patch.maxActiveSubagents !== undefined) {
      subagentManager.setMaxActiveSubagents(patch.maxActiveSubagents);
    }
    // main.tsx applies this at startup. /settings can change it mid-session, so
    // the running bash tool has to see the new policy on the next call.
    if (patch.bashOutput !== undefined) setBashOutputSettingsIfPresent(patch.bashOutput);
    // Session-scoped: the popup never writes the global config, which the
    // sandboxes keep read-only. `s` in the popup is the one way to promote.
    const overrides = sessionSettingsDiff(globalSettingsRef.current, next);
    sessionOverridesRef.current = overrides;
    setSessionOverrides(overrides);
    saveSessionSettings(session.sessionFile, overrides);
  };

  /** Promote this session's settings to the global defaults, on `s` in the popup. */
  const promoteSessionSettings = () => {
    const next = settingsRef.current;
    globalSettingsRef.current = next;
    saveSettings(next);
    // Nothing differs from global any more, so the session owns no overrides.
    sessionOverridesRef.current = {};
    setSessionOverrides({});
    saveSessionSettings(session.sessionFile, {});
    appendMainLine({ kind: "text", role: "system", text: "Saved these settings as the global defaults." });
  };

  const stepThinking = (step: number) => {
    const levels = getSupportedThinkingLevels(session.agent.state.model);
    // pi holds the authoritative level, so two presses in one React batch both
    // step from the committed value instead of from a stale render closure.
    const i = levels.indexOf(session.agent.state.thinkingLevel as ThinkingLevel);
    const target = levels[Math.max(0, Math.min(levels.length - 1, i + step))]!;
    session.setThinkingLevel(target);
    // setThinkingLevel clamps to what the model supports — show the real value.
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
  };

  const stepTheme = (step: number) => {
    const i = PRESET_NAMES.indexOf(settingsRef.current.theme);
    const next = PRESET_NAMES[(i + step + PRESET_NAMES.length) % PRESET_NAMES.length]!;
    update({ theme: next });
  };

  const stepWritingStyle = (step: number) => {
    const i = WRITING_STYLES.indexOf(settingsRef.current.writingStyle);
    const next = WRITING_STYLES[(i + step + WRITING_STYLES.length) % WRITING_STYLES.length]!;
    update({ writingStyle: next });
  };

  const stepExplanationStrength = (step: number) => {
    const i = EXPLANATION_STRENGTHS.indexOf(settingsRef.current.explanationStrength);
    const next = EXPLANATION_STRENGTHS[
      (i + step + EXPLANATION_STRENGTHS.length) % EXPLANATION_STRENGTHS.length
    ]!;
    update({ explanationStrength: next });
  };

  const stepWorkingRuleAnimation = (step: number) => {
    const i = WORKING_RULE_ANIMATION_MODES.indexOf(settingsRef.current.workingRuleAnimation);
    const next = WORKING_RULE_ANIMATION_MODES[
      (i + step + WORKING_RULE_ANIMATION_MODES.length) % WORKING_RULE_ANIMATION_MODES.length
    ]!;
    update({ workingRuleAnimation: next });
  };

  const stepOutputMode = (step: number) => {
    update({ outputMode: cycleOutputMode(settingsRef.current.outputMode, step) });
  };

  const openLogin = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setTriggerPopup(false, false);
    setNewsOpen(false);
    newsOpenRef.current = false;
    setStatsOpen(false);
    statsOpenRef.current = false;
    setLoginOpen(true);
    loginControllerRef.current?.open();
  };

  /** Read every provider the runtime knows, with its credential state. */
  const loadManagedProviders = async (): Promise<ProviderEntry[]> => {
    const runtime = modelRuntime as any;
    const custom = await readCustomProviderIds();
    const entries = providerEntries(runtime.getProviders?.() ?? [], {
      configured: (id) => Boolean(runtime.hasConfiguredAuth?.(id)),
      custom,
    });
    managedProvidersRef.current = entries;
    setManagedProviders(entries);
    return entries;
  };

  const providersController = () => {
    if (!providersControllerRef.current) {
      providersControllerRef.current = new ProvidersController({
        loadEntries: loadManagedProviders,
        show: setProvidersPage,
        close: () => setProvidersOpen(false),
        startLogin: (entry) => {
          openLogin();
          // The login list holds one row per auth method, so filtering to the
          // provider is as far as PUM can go without choosing a method.
          if (entry) loginControllerRef.current?.setProviderQuery(entry.name);
        },
        remove: async (entry) => {
          await deleteProvider(modelRuntime as any, entry);
          // The active model may have belonged to the provider just removed.
          // Move to another one rather than keep a model PUM cannot authenticate.
          const runtime = modelRuntime as any;
          const replacement = modelAfterRemoval(
            sessionRef.current.agent.state.model,
            runtime.getAvailableSnapshot?.() ?? [],
            entry.id,
          );
          if (!replacement) return;
          await sessionRef.current.setModel(replacement);
          setModelId(sessionRef.current.agent.state.model.id);
        },
      });
    }
    return providersControllerRef.current;
  };

  const openProviders = (request: ReturnType<typeof parseProvidersCommand>) => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setTriggerPopup(false, false);
    setNewsOpen(false);
    newsOpenRef.current = false;
    setStatsOpen(false);
    statsOpenRef.current = false;
    setProvidersOpen(true);
    void providersController().open(request ?? { action: "list" });
  };

  // Load the provider list the first time /providers is typed, so name
  // completion works before the popup has ever opened.
  useEffect(() => {
    if (managedProviders.length > 0) return;
    if (!/^\/providers\s/.test(commandInput)) return;
    void loadManagedProviders();
  }, [commandInput, managedProviders.length]);

  const selectModel = (model: Model<any>) => {
    settingsPageRef.current = "main";
    setPage("main");
    setModelQuery("");
    setModelSearchFocused(false);
    session
      .setModel(model)
      .then(() => setModelId(session.agent.state.model.id))
      .catch((err) => append({ kind: "text", role: "error", text: String(err) }));
  };

  const selectCheckModel = (model: Model<any>) => {
    settingsPageRef.current = "main";
    setPage("main");
    setModelQuery("");
    setModelSearchFocused(false);
    update({ checkModel: `${model.provider}/${model.id}` });
  };

  const openHistory = () => {
    const blocked = historyOpenBlockReason({
      hasPendingImages: pendingImages.current.length > 0,
      hasPendingPastedText: pendingPastedTexts.current.length > 0,
      busy: busyRef.current,
    });
    if (blocked) {
      append({ kind: "text", role: "error", text: blocked });
      return;
    }
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setTriggerPopup(false, false);
    setNewsOpen(false);
    newsOpenRef.current = false;
    setStatsOpen(false);
    statsOpenRef.current = false;
    loadSessions(cwdRef.current)
      .then((sessions) => {
        setHistorySessions(sessions);
        setHistoryOpen(true);
      })
      .catch((err) => append({ kind: "text", role: "error", text: String(err) }));
  };

  const commitNews = (next: NewsItem[]) => {
    newsRef.current = next;
    setNews(next);
    saveNewsItems(session.sessionFile, next);
  };

  const openNews = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setTriggerPopup(false, false);
    setLoginOpen(false);
    setStatsOpen(false);
    statsOpenRef.current = false;
    todoOpenRef.current = false;
    setTodoOpen(false);
    newsCursorRef.current = 0;
    setNewsCursor(0);
    newsOpenRef.current = true;
    setNewsOpen(true);
  };

  const closeNews = () => {
    newsOpenRef.current = false;
    setNewsOpen(false);
    queueMicrotask(() => inputRef.current?.focus());
  };

  // Re-read on every transcript change while the popup is open: a todo tool call
  // always adds a line, so the list follows the agent without an event bus.
  const todoSessionFile = activeAgent?.sessionFile ?? session.sessionFile;
  const todoTasks = useMemo(
    () => (todoVisible ? visibleTodoTasks(loadTodoTasks(todoSessionFile), todoFilter) : []),
    [todoVisible, todoSessionFile, todoFilter, visibleLines.length, visibleBusy],
  );
  const todoPageSize = Math.max(1, todoPopupLayout(width, height).listHeight);

  const applyTodoSelection = (next: string | null) => {
    todoSelectedIdRef.current = next;
    setTodoSelectedId(next);
  };

  const moveTodoCursor = (step: number) => {
    if (todoTasks.length === 0) return;
    const current = todoSelectedIdRef.current;
    const index = todoTasks.findIndex((task) => task.id === current);
    const from = index < 0 ? 0 : index;
    const to = Math.min(todoTasks.length - 1, Math.max(0, from + step));
    // Single steps wrap, a page jump clamps: paging past the end should land on
    // the end, not on the row the user started from.
    const wrapped = Math.abs(step) === 1
      ? moveTodoSelection(todoTasks, current, step as -1 | 1)
      : todoTasks[to]?.id ?? null;
    applyTodoSelection(wrapped);
  };

  const moveTodoCursorTo = (edge: "first" | "last") => {
    if (todoTasks.length === 0) return;
    applyTodoSelection((edge === "first" ? todoTasks[0] : todoTasks.at(-1))?.id ?? null);
  };

  const cycleTodoFilterState = () => {
    const next = cycleTodoFilter(todoFilterRef.current);
    todoFilterRef.current = next;
    setTodoFilter(next);
    // The old selection may not survive the new filter; let the popup reseat it.
    applyTodoSelection(null);
  };

  /** The transcript of whoever asked, so the delegate decides with their context. */
  const transcriptForRequester = (requesterId: string) => {
    if (requesterId === "main") return txRef.current;
    return agents.find((agent) => agent.id === requesterId)?.transcript ?? txRef.current;
  };

  /**
   * A durable row in the requesting agent's transcript for every automatic
   * answer. The questionnaire tool result already carries the answers, so this
   * is for the user only and never re-enters the model's context.
   */
  const appendAfkAudit = (request: QuestionnaireRequest, result: QuestionnaireResult) => {
    const lines = request.questions.map((question) => {
      const answer = result.answers.find((entry) => entry.questionId === question.id);
      const asked = question.label ?? question.prompt;
      const flat = asked.replace(/\s+/g, " ").trim();
      return `  ${truncateStatusText(flat, 60) ?? flat} → ${answer?.label ?? "?"}`;
    });
    const row = {
      kind: "text" as const,
      role: "system" as const,
      text: [`AFK answered for ${request.requester.name}`, ...lines].join("\n"),
    };
    if (request.requester.id === "main") {
      appendMainLine(row);
      // appendMainLine only draws. Persist it too, or the row is gone on resume.
      try {
        session.sessionManager.appendCustomEntry?.(AGENT_NOTICE_CUSTOM_TYPE, {
          agentId: "main",
          line: row,
        });
      } catch {
        // The row is already on screen; failing to persist must not throw here.
      }
    } else subagentManager.appendAgentLine(request.requester.id, row);
  };

  const afkDelegateRef = useRef<{
    id: string | null;
    requestId: string;
    generation: number;
    settled: boolean;
  } | null>(null);
  const afkStartingRef = useRef(false);

  const stopAfkDelegate = async () => {
    const running = afkDelegateRef.current;
    afkDelegateRef.current = null;
    if (running?.id) await subagentManager.removeAfkDelegate(running.id).catch(() => {});
  };

  /**
   * Give up on automatic answers and hand the questionnaire back.
   *
   * Every failure path lands here rather than retrying: a delegate that cannot
   * answer once is unlikely to answer better twice, and the user is the safe
   * fallback. The original request is untouched, so its popup simply reappears.
   */
  const surrenderAfk = (reason: string) => {
    void stopAfkDelegate();
    afk.stop();
    appendMainLine({ kind: "text", role: "error", text: `AFK off: ${reason}` });
  };

  const processAfkAnswer = async (
    ticket: { requestId: string; generation: number },
    raw: unknown,
  ) => {
    const running = afkDelegateRef.current;
    // Stale on any count: a newer request, a newer AFK run, or an answer that
    // arrived after the user already took over.
    if (!running || running.settled) return;
    if (running.requestId !== ticket.requestId || running.generation !== ticket.generation) return;
    if (afk.generation() !== ticket.generation) return;
    running.settled = true;

    const request = questionnaireManager?.current();
    if (!request || request.id !== ticket.requestId) {
      await stopAfkDelegate();
      return;
    }
    const outcome = validateAfkAnswer(request, String(ticket.generation), raw);
    if (!outcome.ok) {
      surrenderAfk(afkAnswerFailureText(outcome.failure));
      return;
    }
    const accepted = questionnaireManager?.completeCurrent(request.id, outcome.result) ?? false;
    await stopAfkDelegate();
    if (!accepted) return;
    appendAfkAudit(request, outcome.result);
  };

  const startAfkDelegate = async (request: QuestionnaireRequest) => {
    const begun = afk.begin();
    if (!begun) return;
    afkStartingRef.current = true;
    const ticket = { requestId: request.id, generation: begun.generation };
    afkDelegateRef.current = { id: null, requestId: request.id, generation: begun.generation, settled: false };
    try {
      const task = buildAfkTask({
        request,
        guidance: begun.guidance,
        requesterName: request.requester.name,
        context: judgeTranscript(transcriptForRequester(request.requester.id).lines),
        generation: String(begun.generation),
      });
      const agent = await subagentManager.spawnAfkDelegate({
        task,
        modelId: `${session.agent.state.model.provider}/${session.agent.state.model.id}`,
        thinkingLevel: String(session.agent.state.thinkingLevel),
        onAnswer: (raw) => void processAfkAnswer(ticket, raw),
      });
      if (afkDelegateRef.current?.requestId === request.id) afkDelegateRef.current.id = agent.id;
      else await subagentManager.removeAfkDelegate(agent.id).catch(() => {});
    } catch (error) {
      surrenderAfk(`the delegate could not start (${String(error)})`);
    } finally {
      afkStartingRef.current = false;
    }
  };

  const runAfkCommand = (text: string): boolean => {
    const command = parseAfkCommand(text);
    if (!command) return false;
    if (command.kind === "error") {
      // Keep the draft: the user still has to fix it.
      setEditorText(text, text.length, true);
      appendMainLine({ kind: "text", role: "error", text: command.message });
      return true;
    }
    const result = command.kind === "toggle" ? afk.toggle() : afk.toggle(command.text);
    if (result.kind === "rejected") {
      setEditorText(text, text.length, true);
      appendMainLine({ kind: "text", role: "error", text: result.message });
      return true;
    }
    if (result.kind === "stopped") {
      void stopAfkDelegate();
      appendMainLine({ kind: "text", role: "system", text: "AFK off." });
      return true;
    }
    const verb = result.kind === "started" ? "on" : "steered";
    appendMainLine({
      kind: "text",
      role: "system",
      text: result.instructions ? `AFK ${verb}: ${result.instructions}` : `AFK ${verb}.`,
    });
    return true;
  };

  const openTodo = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setTriggerPopup(false, false);
    setLoginOpen(false);
    setStatsOpen(false);
    statsOpenRef.current = false;
    newsOpenRef.current = false;
    setNewsOpen(false);
    todoOpenRef.current = true;
    setTodoOpen(true);
  };

  const closeTodo = () => {
    todoOpenRef.current = false;
    setTodoOpen(false);
    queueMicrotask(() => inputRef.current?.focus());
  };

  const openStats = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setTriggerPopup(false, false);
    setLoginOpen(false);
    setNewsOpen(false);
    newsOpenRef.current = false;
    setStatsScrollOffset(0);
    statsOpenRef.current = true;
    setStatsOpen(true);
  };

  const closeStats = () => {
    statsOpenRef.current = false;
    setStatsOpen(false);
    queueMicrotask(() => inputRef.current?.focus());
  };

  const moveNewsCursor = (direction: number) => {
    const count = newsRef.current.length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, newsCursorRef.current + direction));
    newsCursorRef.current = next;
    setNewsCursor(next);
  };

  const jumpFromNews = (target: "answer" | "prompt") => {
    const item = newsRef.current[newsCursorRef.current];
    if (!item) return;
    const requesterAgentId = item.completion?.requesterAgentId ?? null;
    const lines = requesterAgentId === null
      ? txRef.current.lines
      : subagentManager.getAgent(requesterAgentId)?.transcript.lines;
    if (!lines) return;
    const completionPromptIndex = item.completion
      ? lines.findIndex((line) =>
        line.kind === "agent-message" && line.messageId === item.completion?.messageId,
      )
      : -1;
    const answerIndex = item.completion
      ? lines.findIndex((line, index) =>
        index > completionPromptIndex
          && line.kind === "text"
          && line.role === "assistant"
          && line.text === item.text,
      )
      : lines.findIndex((line) =>
        line.kind === "text" && line.role === "assistant" && line.newsId === item.id,
      );
    let targetIndex = answerIndex;
    if (target === "prompt") {
      targetIndex = completionPromptIndex;
      if (!item.completion) {
        const promptText = item.prompts?.find((prompt) => !prompt.steer)?.text
          ?? item.prompts?.[0]?.text;
        if (promptText) {
          const end = answerIndex >= 0 ? answerIndex : lines.length;
          for (let index = end - 1; index >= 0; index--) {
            const line = lines[index];
            if (line?.kind === "text" && line.role === "user" && line.text === promptText) {
              targetIndex = index;
              break;
            }
          }
        }
      }
    }
    const targetLine = lines[targetIndex];
    if (!targetLine) {
      // A stored answer whose text no longer appears in the session, after a
      // compaction for example, has no row to jump to, and neither has the
      // prompt that asked for it. Say so: leaving the popup open makes the key
      // look broken.
      newsOpenRef.current = false;
      setNewsOpen(false);
      append({
        kind: "text",
        role: "error",
        text: "news: that message is not in the transcript any more",
      });
      queueMicrotask(() => inputRef.current?.focus());
      return;
    }

    if (activeAgentIdRef.current !== requesterAgentId && !selectAgentView(requesterAgentId)) return;
    newsOpenRef.current = false;
    setNewsOpen(false);
    // Rows are the projected lines: successful tool calls fold into one
    // activity row and hidden kinds drop out, so the line has to be matched to
    // the row that draws it. The match runs at scroll time, which is also
    // after a switch to another agent has drawn that agent’s rows.
    // The answer can be anywhere in the session, including far above the rows
    // that are mounted, so this asks for the row and waits for it.
    scrollToTranscriptRow(
      () => visibleLinesRef.current.indexOf(targetLine as MinimalTranscriptLine),
      { fromTop: true },
    );
  };

  const toggleCurrentNewsRead = () => {
    const item = newsRef.current[newsCursorRef.current];
    if (!item) return;
    commitNews(
      newsRef.current.map((entry) =>
        entry.id === item.id ? { ...entry, read: !entry.read } : entry,
      ),
    );
  };

  const markNewestNewsAnswered = () => {
    // When a resumed answer's text no longer matches a replayed line (for
    // example after compaction or regeneration), the line cannot be tagged
    // with its news id, so a direct prompt will not mark it read. This is
    // intentional, not a bug.
    const first = newsRef.current[0];
    if (!first || (first.read && first.answered)) return;
    const current = txRef.current;
    const last = current.lines[current.lines.length - 1];
    // Mark read only when the new user prompt lands directly after the newest
    // answer. Any interleaved line (agent message, trigger event, queued
    // message, or an in-progress stream) means the prompt is not a direct reply.
    const directReply =
      current.stream === null &&
      current.pending.length === 0 &&
      last?.kind === "text" &&
      last.role === "assistant" &&
      last.newsId === first.id;
    if (!directReply) return;
    commitNews(
      newsRef.current.map((entry, index) =>
        index === 0 ? { ...entry, read: true, answered: true } : entry,
      ),
    );
  };

  const replyToCurrentNews = () => {
    const item = newsRef.current[newsCursorRef.current];
    if (!item) return;
    commitNews(
      newsRef.current.map((entry) =>
        entry.id === item.id ? { ...entry, read: true, answered: true } : entry,
      ),
    );
    newsOpenRef.current = false;
    setNewsOpen(false);
    const firstLine = item.text.split("\n")[0] ?? item.text;
    const preview = firstLine.length > 240 ? `${firstLine.slice(0, 240)} …` : firstLine;
    const quote = `> ${preview}\n\n`;
    const requesterAgentId = item.completion?.requesterAgentId ?? null;
    const targetAgentId = requesterAgentId && subagentManager.getAgent(requesterAgentId)
      ? requesterAgentId
      : null;
    viewDrafts.current.set(targetAgentId ?? "main", quote);
    if (activeAgentIdRef.current !== targetAgentId) selectAgentView(targetAgentId);
    else setEditorText(quote);
    queueMicrotask(() => {
      inputRef.current?.focus();
      const transcriptScroll = transcriptScrollRef.current;
      if (transcriptScroll) transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
    });
  };

  const copyNewsAnswer = () => {
    const item = newsRef.current[newsCursorRef.current];
    if (!item) return;
    copyNewsAnswerText(item.text, {
      osc52: (value) => renderer.copyToClipboardOSC52(value),
    }).catch((error) =>
      append({ kind: "text", role: "error", text: `copy failed: ${String(error)}` }),
    );
  };

  const selectHistorySession = (path: string) => {
    setHistoryOpen(false);
    if (path === session.sessionFile) {
      queueMicrotask(() => inputRef.current?.focus());
      return;
    }
    setWorking(true);
    sessionSwitchRef.current = true;
    onSwitchSession(path)
      .then((next) => {
        if (!next) {
          queueMicrotask(() => inputRef.current?.focus());
          return;
        }
        if (activeAgentIdRef.current !== null) selectAgentView(null);
        focusInputAfterSwitch.current = true;
        setSession(next);
        // A host can return the same object after replacing its runtime state.
        queueMicrotask(() => inputRef.current?.focus());
      })
      .catch((err) => {
        append({ kind: "text", role: "error", text: String(err) });
        queueMicrotask(() => inputRef.current?.focus());
      })
      .finally(() => {
        sessionSwitchRef.current = false;
        setWorking(false);
      });
  };

  const cancel = () => {
    resetCancelArm();
    append({ kind: "text", role: "system", text: "cancelled" });
    // An abort still settles the turn, so an active goal would review the work
    // the user just stopped and continue it. Cancelling means stop. This runs
    // before the abort, so the settle that follows finds a stopped goal.
    const goalAtCancel = goalRef.current;
    if (goalAtCancel && (goalAtCancel.state === "active" || goalAtCancel.state === "blocked")) {
      clearGoalJudge();
      persistGoal(stopGoal(goalAtCancel));
      append({
        kind: "text",
        role: "system",
        text: "goal stopped, so the cancelled turn is not reviewed. /goal continue resumes it.",
      });
    }
    // Preserve every recallable queued user steer before aborting the turn.
    // Restore the running prompt only when no queued user steer exists.
    const cleared = session.clearQueue();
    const queuedUserSteers = queuedUserSteersInOrder(cleared.steering, txRef.current.pending);
    setTx((value) => ({
      ...value,
      pending: value.pending.filter((item) => item.line.kind === "agent-message"),
    }));

    let preservedCount = 0;
    try {
      if (messageCacheController) {
        const requester = { kind: "main" as const, id: session.sessionId, name: "main" as const };
        for (const text of queuedUserSteers) {
          messageCacheController.add(requester, text);
          preservedCount++;
        }
      } else {
        for (const text of queuedUserSteers) {
          addToStash(text);
          preservedCount++;
        }
      }
    } catch (error) {
      const fallback = queuedUserSteers.slice(preservedCount).join("\n\n");
      const restoredToDraft = Boolean(fallback && inputRef.current && !inputRef.current.plainText);
      if (restoredToDraft) setEditorText(fallback);
      append({
        kind: "text",
        role: "error",
        text: restoredToDraft
          ? `could not cache every queued steer; restored the remaining steers to the draft in original order: ${String(error)}`
          : `could not cache every queued steer; uncached steers in original order:\n${fallback}\n${String(error)}`,
      });
    }
    if (preservedCount > 0) {
      append({
        kind: "text",
        role: "system",
        text: `preserved ${preservedCount} queued steer${preservedCount === 1 ? "" : "s"} in the prompt cache`,
      });
    }

    if (queuedUserSteers.length === 0 && inputRef.current && !inputRef.current.plainText) {
      setEditorText(inFlight.current);
    }
    histCursor.current = null;
    // clearQueue may have dropped a subagent completion notice queued to the
    // streaming main agent; re-arm undelivered notices so a merge is not stuck.
    session.abort().finally(() => {
      setWorking(false);
      void subagentManager.resendUndeliveredMainSettlements();
    });
  };

  const recallQueuedUserMessage = async (target: string | null) => {
    const recalled = target
      ? await subagentManager.recallQueuedUserMessage(target)
      : await recallNewestQueuedUserMessage(session, tx.pending);
    if (!recalled) return;
    // Recalling from the main queue clears it, which can drop a queued subagent
    // completion notice; re-arm undelivered notices so a merge is not stuck.
    if (!target) {
      dropPending(recalled.id);
      void subagentManager.resendUndeliveredMainSettlements();
    }
    const key = target ?? "main";
    viewDrafts.current.set(key, recalled.text);
    if (activeAgentIdRef.current === target) {
      setEditorText(recalled.text);
      histCursor.current = null;
      draft.current = "";
      inputRef.current?.focus();
    }
  };

  /** Up walks back through sent prompts, down returns to the current draft. */
  const recall = (direction: -1 | 1) => {
    const input = inputRef.current;
    const list = history.current;
    setEditingStash(null);
    if (!input || list.length === 0) return;

    if (histCursor.current === null) {
      if (direction === 1) return; // already on the draft line
      draft.current = input.plainText;
      histCursor.current = list.length - 1;
    } else {
      const next = histCursor.current + direction;
      if (next >= list.length) {
        histCursor.current = null;
        setEditorText(draft.current);
        return;
      }
      histCursor.current = Math.max(0, next);
    }
    setEditorText(list[histCursor.current]!);
  };

  const moveStash = (direction: -1 | 1, extend = false) => {
    const list = stashRef.current;
    if (list.length === 0) return;
    const current = stashCursorRef.current;

    if (!extend) {
      clearStashSelection();
      if (direction === -1) {
        setSelectedStash(current < 0 ? list.length - 1 : Math.max(0, current - 1));
      } else if (current >= 0) {
        setSelectedStash(current + 1 < list.length ? current + 1 : -1);
      }
      return;
    }

    const start = current < 0 ? (direction === -1 ? list.length - 1 : 0) : current;
    const anchor = stashSelectionAnchor.current ?? start;
    const next = Math.max(0, Math.min(list.length - 1, start + direction));
    setSelectedStash(next);
    setSelectedStashRange(selectedRange(anchor, next), anchor);
  };

  /**
   * Session scope by default, exactly like the popup. `--global` also rewrites
   * that one key in pum.json, so the rest of the global file and this session's
   * other overrides are left alone — only `s` in the popup promotes everything.
   */
  const applySettingsPatch = (patch: Partial<PumSettings>, global: boolean) => {
    if (global) {
      const nextGlobal = { ...globalSettingsRef.current, ...patch };
      globalSettingsRef.current = nextGlobal;
      saveSettings(nextGlobal);
    }
    update(patch);
  };

  /** `/settings` — the text front end for the state the popup owns. */
  const runSettingsCommand = async (input: string): Promise<void> => {
    const command = parseSettingsCommand(input);
    if (!command) throw new Error("invalid /settings command");

    if (command.action === "list") {
      append({
        kind: "text",
        role: "system",
        text: listSettingsMessage(
          settingsRef.current,
          sessionOverridesRef.current,
          checkPathsForProject(settingsRef.current, cwd).length,
        ),
      });
      return;
    }

    if (command.action === "show") {
      append({
        kind: "text",
        role: "system",
        text: showSettingMessage(
          command.spec,
          settingsRef.current,
          sessionOverridesRef.current,
          checkPathsForProject(settingsRef.current, cwd),
        ),
      });
      return;
    }

    // Paths keep one owner: /check-path's canonicalization and its boundary
    // rules run here too, so no route into checkPaths skips them.
    if (command.action === "checkPaths") {
      const result = await applyCheckPathCommand(settingsRef.current, cwd, command.command);
      if (command.command.action !== "list") {
        applySettingsPatch({ checkPaths: result.settings.checkPaths }, command.global);
      }
      append({ kind: "text", role: "system", text: result.message });
      return;
    }

    const result = applySettingChange(settingsRef.current, command.spec, command.value);
    applySettingsPatch(
      { [command.spec.topKey]: result.settings[command.spec.topKey] } as Partial<PumSettings>,
      command.global,
    );
    append({
      kind: "text",
      role: "system",
      text: `${result.message}${command.global ? " (global)" : ""}`,
    });
  };

  const runCommand = (text: string): boolean => {
    const trimmed = text.trim();
    if (runGoalCommand(trimmed)) return true;
    const compress = /^\/compress(?:\s+(.*))?$/s.exec(trimmed);
    const clear = /^\/(?:clear|new)$/.test(trimmed);
    const historyCommand = trimmed === "/history";
    const loginCommand = trimmed === "/login";
    const providersCommand = parseProvidersCommand(trimmed);
    const checkPathCommand = /^\/check-path(?:\s|$)/.test(trimmed);
    const settingsCommand = /^\/settings(?:\s|$)/.test(trimmed);
    const triggersCommand = trimmed === "/triggers";
    const processesCommand = trimmed === "/processes";
    const newsCommand = trimmed === "/news";
    const todoCommand = trimmed === "/todo";
    const statsCommand = trimmed === "/stats";
    const worktreeCommand = parseWorktreeCommand(trimmed);
    if (!compress && !clear && !historyCommand && !loginCommand && !providersCommand && !checkPathCommand && !settingsCommand && !triggersCommand && !processesCommand && !newsCommand && !todoCommand && !statsCommand && !worktreeCommand) return false;
    setEditingStash(null);

    if (historyCommand) {
      setEditorText("");
      openHistory();
      return true;
    }
    if (loginCommand) {
      setEditorText("");
      openLogin();
      return true;
    }
    if (providersCommand) {
      setEditorText("");
      openProviders(providersCommand);
      return true;
    }
    if (triggersCommand) {
      setEditorText("");
      openTriggers();
      return true;
    }
    if (processesCommand) {
      setEditorText("");
      openProcesses();
      return true;
    }
    if (newsCommand) {
      setEditorText("");
      openNews();
      return true;
    }
    if (todoCommand) {
      setEditorText("");
      openTodo();
      return true;
    }
    if (statsCommand) {
      setEditorText("");
      openStats();
      return true;
    }

    if (worktreeCommand?.kind === "error") {
      setEditorText(trimmed, trimmed.length, true);
      appendMainLine({ kind: "text", role: "error", text: worktreeCommand.message });
      return true;
    }
    if (worktreeCommand?.kind === "start" || worktreeCommand?.kind === "return") {
      setEditorText("");
      void runWorktreeRelocation(worktreeCommand);
      return true;
    }

    setEditorText("");
    histCursor.current = null;
    draft.current = "";

    if (busyRef.current) {
      append({ kind: "text", role: "error", text: "wait for the current turn to finish before running a command" });
      return true;
    }

    setWorking(true);
    if (checkPathCommand) {
      Promise.resolve()
        .then(() => parseCheckPathCommand(trimmed))
        .then((command) => {
          if (!command) throw new Error("invalid /check-path command");
          return applyCheckPathCommand(settings, cwd, command);
        })
        .then((result) => {
          update({ checkPaths: result.settings.checkPaths });
          append({ kind: "text", role: "system", text: result.message });
        })
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(streamingRef.current));
    } else if (settingsCommand) {
      runSettingsCommand(trimmed)
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(streamingRef.current));
    } else if (worktreeCommand) {
      runWorktreeCommand({
        name: worktreeCommand.kind === "create" ? worktreeCommand.name : undefined,
        manager: subagentManager,
        append: (call) => append({ kind: "tool", call }),
        patch: patchTool,
        settled: () => setWorking(streamingRef.current),
      });
    } else if (clear) {
      sessionSwitchRef.current = true;
      onNewSession()
        .then((next) => {
          if (next) setSession(next);
        })
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => {
          sessionSwitchRef.current = false;
          setWorking(false);
        });
    } else {
      session
        .compact(compress![1]?.trim() || undefined)
        .then((result) => append({
          kind: "text",
          role: "system",
          text: `compressed context (${result.tokensBefore.toLocaleString()} tokens before)`,
        }))
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(streamingRef.current));
    }
    return true;
  };

  const deliverMainPrompt = async (
    promptText: string,
    displayText: string,
    images: ReturnType<typeof imageContent>[] = [],
    recallable = images.length === 0,
  ): Promise<void> => {
    // A pending session switch aborts and disposes this session, so anything
    // delivered into it now is lost. Refuse instead, and let the caller keep
    // the text.
    if (sessionSwitchRef.current) {
      throw new Error("session change in progress; send this again when it finishes");
    }
    // A direct user prompt starts a user-initiated main turn, so its settled
    // answer becomes a news item. A reply also marks the newest answer seen.
    userTurnActiveRef.current = true;
    markNewestNewsAnswered();
    const userLine: Extract<Line, { kind: "text" }> = {
      kind: "text",
      role: "user",
      text: displayText,
    };

    turnPromptsRef.current.push({ text: displayText, steer: streamingRef.current });
    // Streaming already: keep the steering message pending at the transcript
    // bottom until pi emits message_start for its actual insertion.
    if (streamingRef.current) {
      const pending: PendingLine = {
        id: randomUUID().slice(0, 12),
        line: userLine,
        deliveryText: promptText,
        recallable,
        hasAttachments: images.length > 0,
      };
      addPending(pending);
      try {
        await withSearchRoute(session.sessionId, () => session.steer(promptText, images));
      } catch (error) {
        dropPending(pending.id);
        append({ kind: "text", role: "error", text: String(error) });
        throw error;
      }
      return;
    }

    append(userLine);
    // Esc hands the running prompt back for editing, so only text the user
    // actually typed belongs there. A generated coordination prompt would
    // arrive in the draft as if they had written it.
    inFlight.current = (recallable || displayText === promptText) ? promptText : "";
    streamingRef.current = true;
    setWorking(true);
    try {
      await withSearchRoute(session.sessionId, () => session.prompt(promptText, { images }));
    } catch (error) {
      streamingRef.current = false;
      append({ kind: "text", role: "error", text: String(error) });
      setWorking(false);
      throw error;
    }
  };

  // ── Autonomous goal mode ────────────────────────────────────────────────
  // The pure decisions live in goal.ts. Everything here only wires session and
  // subagent lifecycle events to them; nothing polls and nothing runs on a timer.

  const persistGoal = (next: GoalRecord | null) => {
    goalRef.current = next;
    setGoalState(next);
    saveGoal(session.sessionFile, next);
  };

  /** Rewrite the row of one review in place. The first outcome to land wins. */
  const settleGoalReview = (
    judgeId: string,
    status: GoalReviewStatus,
    body?: string,
    detail?: string,
  ) => setTx((t) => resolveGoalReview(t, judgeId, {
    status,
    ...(detail ? { detail } : {}),
    ...(body ? { body } : {}),
  }));

  /** Drop the live review. A judge holds no worktree, so nothing is merged. */
  const clearGoalJudge = () => {
    const judge = judgeRef.current;
    judgeEpochRef.current += 1;
    judgeRef.current = null;
    judgeAgentIdRef.current = null;
    judgeStartingRef.current = false;
    if (!judge) return;
    // A row still reviewing at this point had no verdict, so it says so. A row
    // the verdict already settled is left exactly as the user read it.
    settleGoalReview(judge.ticket.judgeId, "cancelled", "the goal changed while the review ran");
    void judge.agent
      .then((agent) => subagentManager.removeGoalJudge(agent.id))
      .catch(() => {});
  };

  /** PUM's own git, with fixed arguments and no shell. No model input reaches it. */
  const runGoalGit = async (args: string[]): Promise<string> => {
    const child = Bun.spawn(["git", "--no-pager", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    if (code !== 0) throw new Error(err.trim() || `exited ${code}`);
    return out;
  };

  const startGoalJudge = async (target: GoalRecord) => {
    judgeStartingRef.current = true;
    const ticket = judgeTicketFor(target, randomUUID().slice(0, 12));
    const epoch = judgeEpochRef.current;
    // The row goes up before the repository is read, so the wait is visible
    // from the moment the turn settles rather than once the judge is spawned.
    append({ kind: "goal-review", id: ticket.judgeId, status: "reviewing" });
    try {
      const repository = await collectRepositoryState(runGoalGit);
      if (judgeEpochRef.current !== epoch) {
        settleGoalReview(ticket.judgeId, "cancelled", "the goal changed while the review ran");
        return;
      }
      const task = buildJudgeTask({
        goal: target,
        transcript: judgeTranscript(txRef.current.lines),
        repository,
        mutable: (forcedSandboxMode ?? settingsRef.current.sandboxMode ?? "auto") === "off",
      });
      const agent = subagentManager.spawnGoalJudge({
        task,
        modelId: `${session.agent.state.model.provider}/${session.agent.state.model.id}`,
        thinkingLevel: String(session.agent.state.thinkingLevel),
        onVerdict: (raw) => {
          // Mark it here, synchronously inside the tool call, so the judge's
          // own settle cannot race the asynchronous processing below.
          if (judgeRef.current?.ticket === ticket) judgeRef.current.verdictSeen = true;
          void processGoalVerdict(ticket, raw);
        },
      });
      judgeRef.current = { ticket, agent, verdictSeen: false };
      const id = (await agent).id;
      // A drop during the spawn already settled the row and asked for the
      // removal, so all that is left is to not name a judge nobody owns.
      if (judgeEpochRef.current === epoch) judgeAgentIdRef.current = id;
    } catch (error) {
      judgeRef.current = null;
      settleGoalReview(ticket.judgeId, "error", `the review could not start: ${String(error)}`);
    } finally {
      judgeStartingRef.current = false;
    }
  };

  const maybeScheduleGoalJudge = () => {
    // A `/goalf` interview turn is not goal work, so it is never reviewed.
    if (goalFormulationRef.current || sessionSwitchRef.current) return;
    const current = goalRef.current;
    const schedule = shouldScheduleGoalJudge({
      goal: current,
      mainSettled: !streamingRef.current,
      activeWorkerCount: activeWorkersRef.current,
      activeTriggerCount: (triggerManager?.getTriggers() ?? []).filter(
        (trigger) => trigger.state === "running" || trigger.state === "waiting",
      ).length,
      judgeInFlight: judgeStartingRef.current || judgeRef.current !== null,
      pendingInsertions: txRef.current.pending.filter((pending) => !pending.delivered).length,
    });
    if (schedule && current) void startGoalJudge(current);
  };

  // Trigger state changes are review-scheduling events. A running trigger can
  // block a review, and its later idle or terminal transition can release one.
  useEffect(() => {
    maybeScheduleGoalJudge();
  }, [triggerRevision]);

  const deliverGoalContinuation = async (continuation: GoalContinuation) => {
    try {
      await deliverMainPrompt(continuation.text, continuation.text, [], false);
      const live = goalRef.current;
      if (live) persistGoal(continuationDelivered(live, continuation.id));
    } catch (error) {
      // The turn never started, so the queued continuation is not owed to
      // anyone. Release it, or it would block every later review.
      const live = goalRef.current;
      if (live) persistGoal(continuationDelivered(live, continuation.id));
      append({
        kind: "text",
        role: "error",
        text: `goal continuation was not delivered: ${String(error)}`,
      });
    }
  };

  const processGoalVerdict = async (ticket: GoalJudgeTicket, raw: unknown) => {
    const settleRow = (status: GoalReviewStatus, body?: string, detail?: string) =>
      settleGoalReview(ticket.judgeId, status, body, detail);
    const result = parseGoalVerdict(raw);
    if (!result) {
      settleRow("error", "the judge returned an invalid verdict; no turn was started");
      clearGoalJudge();
      return;
    }
    const outcome = applyJudgeResult(goalRef.current, ticket, result);
    // The row settles before the judge is dropped, so the outcome the user
    // reads is the verdict rather than the cancellation that follows it.
    if (outcome.action.kind === "ignored") {
      settleRow("discarded", `${outcome.action.reason}, so nothing was started`);
      clearGoalJudge();
      return;
    }
    const action = outcome.action;
    if (action.kind === "completed") settleRow("completed", action.summary);
    else if (action.kind === "failed") {
      settleRow("failed", action.summary, `after ${action.attempts} incomplete reviews`);
    } else if (action.kind === "blocked") {
      settleRow("blocked", `${action.summary}\n\n${action.question}`);
    } else {
      settleRow(
        "continuing",
        result.summary,
        retryDetail(outcome.goal.incompleteCount, outcome.goal.retryLimit),
      );
    }
    clearGoalJudge();
    // Durable before the action, so a crash between the two cannot repeat it.
    persistGoal(outcome.goal);
    if (action.kind !== "continue") return;
    await deliverGoalContinuation(action.continuation);
  };

  const askGoalQuestion = async (
    id: string,
    prompt: string,
    confirmValue: string,
    confirmLabel: string,
    cancelLabel: string,
  ): Promise<boolean> => {
    if (!questionnaireManager) return false;
    const result = await questionnaireManager.request({ id: "main", name: "main" }, [{
      id,
      label: "Goal",
      prompt,
      // The safe answer is first, so the default selection changes nothing.
      options: [
        { value: "cancel", label: cancelLabel },
        { value: confirmValue, label: confirmLabel },
      ],
    }]);
    return !result.cancelled && result.answers[0]?.value === confirmValue;
  };

  const confirmGoalReplacement = (existing: GoalRecord) => askGoalQuestion(
    "goal-replace",
    `A ${existing.state} goal already exists:\n\n${existing.text}\n\nReplace it?`,
    "replace",
    "Replace it",
    "Keep the current goal",
  );

  const applyNewGoal = async (text: string) => {
    clearGoalJudge();
    const created = createGoal(text, normalizeGoalRetryLimit(settingsRef.current.goalRetryLimit));
    persistGoal(created);
    await deliverMainPrompt(goalStartPrompt(created), `Goal: ${created.text}`, [], false);
  };

  const finishGoalFormulation = async (answer: string) => {
    const proposed = parseProposedGoal(answer);
    if (!proposed) {
      append({
        kind: "text",
        role: "error",
        text: "no goal was proposed, so nothing was stored. Use /goal <text> to set one directly.",
      });
      return;
    }
    const confirmed = await askGoalQuestion(
      "goal-confirm",
      `Proposed goal:\n\n${proposed}\n\nStart it?`,
      "start",
      "Start this goal",
      "Cancel",
    );
    if (!confirmed) {
      append({ kind: "text", role: "system", text: "goal unchanged" });
      return;
    }
    await applyNewGoal(proposed);
  };

  const startGoalFormulation = async (draft: string) => {
    const existing = goalRef.current;
    if (existing && !(await confirmGoalReplacement(existing))) {
      append({ kind: "text", role: "system", text: "goal unchanged" });
      return;
    }
    goalFormulationRef.current = { draft };
    try {
      await deliverMainPrompt(
        goalFormulationPrompt(draft),
        `Work out a goal from: ${draft}`,
        [],
        false,
      );
    } catch (error) {
      goalFormulationRef.current = null;
      throw error;
    }
  };

  const runGoalControl = (control: GoalControl) => {
    const existing = goalRef.current;
    if (control === "status") {
      append({ kind: "text", role: "system", text: formatGoalStatus(existing) });
      return;
    }
    if (!existing) {
      append({ kind: "text", role: "error", text: "no goal is set. Use /goal <text> or /goalf <draft>." });
      return;
    }
    if (control === "clear") {
      void askGoalQuestion(
        "goal-clear",
        `Remove all stored state for this ${existing.state} goal?\n\n${existing.text}`,
        "clear",
        "Clear it",
        "Keep the current goal",
      ).then((confirmed) => {
        if (!confirmed) {
          append({ kind: "text", role: "system", text: "goal unchanged" });
          return;
        }
        // Clearing bumps nothing, so the judge is dropped explicitly. A stale
        // verdict then finds no goal at all and can change nothing.
        clearGoalJudge();
        goalFormulationRef.current = null;
        persistGoal(null);
        append({ kind: "text", role: "system", text: "goal cleared" });
      }).catch((error) => append({ kind: "text", role: "error", text: String(error) }));
      return;
    }
    try {
      if (control === "stop") {
        // Stop wins every race: the new generation makes an in-flight verdict
        // stale, and the judge itself is removed before it can report.
        const stopped = stopGoal(existing);
        clearGoalJudge();
        persistGoal(stopped);
        append({
          kind: "text",
          role: "system",
          text: "goal stopped. Automatic reviews and continuations are off; running work is untouched.",
        });
        return;
      }
      const resumed = continueGoal(existing);
      if (busyRef.current) throw new Error("wait for the current turn to finish before continuing the goal");
      persistGoal(resumed);
      void deliverMainPrompt(
        goalContinuePrompt(resumed),
        `Continue goal: ${resumed.text}`,
        [],
        false,
      ).catch((error) => append({ kind: "text", role: "error", text: String(error) }));
    } catch (error) {
      append({ kind: "text", role: "error", text: String(error) });
    }
  };

  /** Handle `/goal` and `/goalf`. Returns false for anything else. */
  const runGoalCommand = (text: string): boolean => {
    const command = parseGoalCommand(text);
    if (!command) return false;
    const restoreCommandDraft = () => setEditorText(text, text.length, true);
    setEditingStash(null);

    if (command.kind === "error") {
      append({ kind: "text", role: "error", text: command.message });
      restoreCommandDraft();
      return true;
    }
    if (command.kind === "control") {
      histCursor.current = null;
      draft.current = "";
      runGoalControl(command.control);
      return true;
    }
    if (busyRef.current) {
      append({
        kind: "text",
        role: "error",
        text: "wait for the current turn to finish before setting a goal",
      });
      restoreCommandDraft();
      return true;
    }
    histCursor.current = null;
    draft.current = "";
    const report = (error: unknown) =>
      append({ kind: "text", role: "error", text: String(error) });
    if (command.kind === "formulate") {
      void startGoalFormulation(command.draft).catch(report);
      return true;
    }
    void (async () => {
      const existing = goalRef.current;
      if (existing && !(await confirmGoalReplacement(existing))) {
        append({ kind: "text", role: "system", text: "goal unchanged" });
        return;
      }
      await applyNewGoal(command.text);
    })().catch(report);
    return true;
  };

  const appendRequesterLine = (requesterAgentId: string | null, line: Line) => {
    if (requesterAgentId === null || !subagentManager.getAgent(requesterAgentId)) {
      appendMainLine(line);
    } else {
      subagentManager.appendAgentLine(requesterAgentId, line);
    }
  };

  /** Start a fresh managed child without occupying or steering the requester. */
  const runBackgroundCommand = (
    text: string,
    requesterAgentId: string | null,
    draftText = text,
  ): boolean => {
    const command = parseBackgroundCommand(text);
    if (!command) return false;
    const requesterKey = requesterAgentId ?? "main";
    const restoreDraft = () => {
      if (activeAgentIdRef.current !== requesterAgentId) {
        if (!(viewDrafts.current.get(requesterKey) ?? "")) {
          viewDrafts.current.set(requesterKey, draftText);
        }
        return;
      }
      if (!(inputRef.current?.plainText ?? "")) {
        viewDrafts.current.set(requesterKey, draftText);
        setEditorText(draftText, draftText.length, true);
      }
    };
    if (command.kind === "error") {
      setEditorText(draftText, draftText.length, true);
      appendRequesterLine(requesterAgentId, {
        kind: "text",
        role: "error",
        text: command.message,
      });
      return true;
    }
    if (sessionSwitchRef.current) {
      setEditorText(draftText, draftText.length, true);
      appendRequesterLine(requesterAgentId, {
        kind: "text",
        role: "error",
        text: "wait for the session change to finish before starting a background agent",
      });
      return true;
    }
    if (relocatingRef.current || pendingRelocationRef.current) {
      setEditorText(draftText, draftText.length, true);
      appendRequesterLine(requesterAgentId, {
        kind: "text",
        role: "error",
        text: "wait for the worktree move to finish before starting a background agent",
      });
      return true;
    }

    setEditingStash(null);
    viewDrafts.current.set(requesterKey, "");
    setEditorText("");
    histCursor.current = null;
    draft.current = "";
    void (async () => {
      // The registry and every child session belong to the active main session.
      // Bind it before spawning so an App-start race cannot persist elsewhere.
      await subagentManager.bindMainSession(session.sessionManager, cwd);
      const spawned = requesterAgentId === null
        ? await subagentManager.spawnBackground({
          task: command.prompt,
          requesterAgentId: null,
          modelId: `${session.agent.state.model.provider}/${session.agent.state.model.id}`,
          thinkingLevel: String(session.agent.state.thinkingLevel),
        })
        : await subagentManager.spawnBackground({
          task: command.prompt,
          requesterAgentId,
        });
      appendRequesterLine(requesterAgentId, {
        kind: "text",
        role: "system",
        text: `background agent started: ${spawned.name} (${spawned.id})\n`
          + (spawned.usesWorktree
            ? `${spawned.worktree.branch}\n${spawned.worktree.path}`
            : `shared directory\n${spawned.worktree.path}`),
      });
    })().catch((error) => {
      appendRequesterLine(requesterAgentId, {
        kind: "text",
        role: "error",
        text: `background agent could not start: ${String(error)}`,
      });
      restoreDraft();
    });
    return true;
  };

  const submitPrompt = (value?: string, stashIndex?: number) => {
    // Read the selected agent from the ref, not the state. A view switch updates
    // the ref synchronously, but a switch-then-send in one input chunk runs
    // before React commits the new state, so the state would still name the
    // previous agent and deliver the prompt to the wrong session.
    const selectedAgentId = activeAgentIdRef.current;
    const targetKey = selectedAgentId ?? "main";
    const rawDisplayText = value ?? inputRef.current?.plainText ?? "";
    const commandEligible = isCommandInput(rawDisplayText);
    const displayText = rawDisplayText.trim();
    const attachments = value === undefined ? [...pendingImages.current] : [];
    const pastedTexts = value === undefined ? [...pendingPastedTexts.current] : [];
    const submittedEditingIndex = editingStashIndex.current;
    let promptText = rawDisplayText;
    for (const image of attachments) promptText = promptText.replace(image.marker, "");
    for (const pasted of pastedTexts) {
      promptText = promptText.replace(pasted.marker, pastedTextReadBlock(pasted));
    }
    promptText = promptText.trim();

    // History and stash keep the draft form, never the ephemeral temp path.
    let persistedPrompt = rawDisplayText;
    for (const pasted of pastedTexts) persistedPrompt = persistedPrompt.replace(pasted.marker, "");
    persistedPrompt = persistedPrompt.trim();

    if (!promptText && attachments.length === 0 && pastedTexts.length === 0) return;

    const backgroundCandidate = commandEligible ? parseBackgroundCommand(promptText) : null;
    if (backgroundCandidate?.kind === "error") {
      setEditorText(rawDisplayText, rawDisplayText.length, true);
      appendRequesterLine(selectedAgentId, {
        kind: "text",
        role: "error",
        text: backgroundCandidate.message,
      });
      return;
    }
    if (backgroundCandidate && (attachments.length > 0 || pastedTexts.length > 0)) {
      setEditorText(rawDisplayText, rawDisplayText.length, true);
      appendRequesterLine(selectedAgentId, {
        kind: "text",
        role: "error",
        text: "/background accepts text only; remove image and pasted-text attachments",
      });
      return;
    }

    // The main session is being replaced, so keep the draft rather than deliver
    // into a session that is about to be aborted and disposed.
    if (!selectedAgentId && sessionSwitchRef.current) {
      append({
        kind: "text",
        role: "error",
        text: "wait for the session change to finish before sending",
      });
      return;
    }

    let images;
    try {
      images = attachments.map(imageContent);
    } catch (error) {
      append({ kind: "text", role: "error", text: `image attachment failed: ${String(error)}` });
      return;
    }

    // Detach files from editor cleanup until delivery succeeds. A failed send
    // can then restore the exact draft and each still-valid attachment marker.
    if (value === undefined) {
      pendingImages.current = [];
      nextImageId.current = 1;
      pendingPastedTexts.current = [];
      nextPastedTextId.current = 1;
      if (pastedTexts.length > 0) {
        const existing = postTurnPastedTexts.current.get(targetKey) ?? [];
        postTurnPastedTexts.current.set(targetKey, [...existing, ...pastedTexts]);
      }
    }

    setEditorText("");

    const finishAttachments = () => {
      for (const image of attachments) removePendingImage(image);
    };
    const restoreFailedDraft = () => {
      const postTurn = postTurnPastedTexts.current.get(targetKey) ?? [];
      const submittedPaths = new Set(pastedTexts.map((pasted) => pasted.path));
      const remaining = postTurn.filter((pasted) => !submittedPaths.has(pasted.path));
      if (remaining.length > 0) postTurnPastedTexts.current.set(targetKey, remaining);
      else postTurnPastedTexts.current.delete(targetKey);

      const canRestore =
        activeAgentIdRef.current === selectedAgentId &&
        !(inputRef.current?.plainText ?? "");
      if (!canRestore) {
        finishAttachments();
        for (const pasted of pastedTexts) removePendingPastedText(pasted);
        append({
          kind: "text",
          role: "error",
          text: "send failed after the input changed; the submitted draft could not be restored",
        });
        return;
      }

      pendingImages.current = attachments;
      pendingPastedTexts.current = pastedTexts;
      nextImageId.current = Math.max(1, ...attachments.map((image) => image.id + 1));
      nextPastedTextId.current = Math.max(1, ...pastedTexts.map((pasted) => pasted.id + 1));
      setEditingStash(submittedEditingIndex);
      viewDrafts.current.set(targetKey, rawDisplayText);
      viewEditingStashIndices.current.set(targetKey, submittedEditingIndex);
      setEditorText(rawDisplayText, rawDisplayText.length, true);
    };

    const appendCommandHistory = () => {
      if (!persistedPrompt) return;
      history.current = promptHistoryStore.append(cwd, persistedPrompt);
      histCursor.current = null;
      draft.current = "";
    };

    if (attachments.length === 0 && commandEligible && promptText === "/login") {
      appendCommandHistory();
      openLogin();
      return;
    }

    // /background belongs to the selected transcript, unlike the main-only
    // command router below, and must never become an ordinary child message.
    if (
      attachments.length === 0
      && commandEligible
      && runBackgroundCommand(promptText, selectedAgentId, rawDisplayText)
    ) {
      if (!selectedAgentId) appendCommandHistory();
      return;
    }

    // AFK is process-global, so it is intercepted above the child routing below.
    // Successful command handling still makes the entered command recallable.
    if (attachments.length === 0 && commandEligible && runAfkCommand(promptText)) {
      appendCommandHistory();
      setEditorText("");
      return;
    }

    if (selectedAgentId) {
      void subagentManager
        .sendUserMessage(selectedAgentId, promptText, images, displayText)
        .then(finishAttachments)
        .catch((error) => {
          append({ kind: "text", role: "error", text: String(error) });
          restoreFailedDraft();
        });
      return;
    }

    if (attachments.length === 0 && commandEligible && runCommand(promptText)) {
      appendCommandHistory();
      return;
    }

    if (persistedPrompt) history.current = promptHistoryStore.append(cwd, persistedPrompt);
    if (persistedPrompt && stashIndex === undefined) {
      const editingIndex = editingStashIndex.current;
      if (editingIndex === null) addToStash(persistedPrompt, true);
      else replaceStashedPrompt(editingIndex, persistedPrompt, true);
    }
    setEditingStash(null);
    histCursor.current = null;
    draft.current = "";
    setSelectedStash(-1);
    // A normal message steers the live goal. Answering a blocked question
    // resumes the lifecycle; automation stays on either way.
    const steerable = goalRef.current;
    if (steerable) {
      const steered = steerGoal(steerable);
      if (steered !== steerable) persistGoal(steered);
    }
    void deliverMainPrompt(promptText, displayText, images)
      .then(() => {
        finishAttachments();
        // The row is executed only once delivery succeeded, and only while it
        // still holds the text that was sent.
        if (stashIndex !== undefined && stashRef.current[stashIndex]?.text === value) {
          executeStashedPrompt(stashIndex);
        }
      })
      .catch(restoreFailedDraft);
  };

  const submitShellCommand = () => {
    const command = inputRef.current?.plainText ?? "";
    if (!command.trim()) return;
    const selectedAgentId = activeAgentIdRef.current;
    setEditorText("");
    histCursor.current = null;
    draft.current = "";

    if (selectedAgentId) {
      void subagentManager.executeUserBash(selectedAgentId, command, userBashOperations)
        .catch((error) => append({ kind: "text", role: "error", text: String(error) }));
      return;
    }

    const id = `user-bash-${randomUUID().slice(0, 12)}`;
    const call: ToolCall = {
      id,
      name: "bash",
      args: [command.split("\n")[0]!.trim()],
      state: "running",
      startedAt: Date.now(),
      input: { command },
      // The user's own command outlives the agent's turn, so the settle sweep
      // must not call it interrupted while it is still running.
      userInitiated: true,
    };
    append({ kind: "tool", call });
    const wasStreaming = session.isStreaming || streamingRef.current;
    if (!wasStreaming) setWorking(true);
    let output = "";

    void session.executeBash(command, (chunk) => {
      output += chunk;
      patchTool(id, { output });
    }, { id, operations: userBashOperations }).then(async (result) => {
      patchTool(id, settledUserBashCall(result));
      await session.sendCustomMessage(
        userBashReaction(command),
        wasStreaming || session.isStreaming
          ? { deliverAs: "steer" }
          : { triggerTurn: true },
      );
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      patchTool(id, { state: "error", detail: message, isError: true });
      await session.sendCustomMessage(
        userBashReaction(command, message),
        wasStreaming || session.isStreaming
          ? { deliverAs: "steer" }
          : { triggerTurn: true },
      ).catch(() => {});
    }).finally(() => {
      if (!session.isStreaming && !streamingRef.current) setWorking(false);
    });
  };

  const cachedBatchDisplay = (prompts: readonly string[]): string => [
    `Run ${prompts.length} cached tasks with subagents:`,
    ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`),
  ].join("\n");

  const resetAfterCacheExecution = (targetAgentId = activeAgentIdRef.current) => {
    const targetKey = targetAgentId ?? "main";
    viewDrafts.current.set(targetKey, "");
    viewEditingStashIndices.current.set(targetKey, null);
    if ((activeAgentIdRef.current ?? "main") !== targetKey) return;
    setEditingStash(null);
    histCursor.current = null;
    draft.current = "";
    setStashMode(false);
    setEditorText("");
  };

  const markStashBatchExecuted = (selected: ReadonlyArray<{ index: number; text: string }>) => {
    // A row can have moved or changed during the turn, so only tick the ones
    // that still hold the text that was sent.
    const indices = selected
      .filter((entry) => stashRef.current[entry.index]?.text === entry.text)
      .map((entry) => entry.index);
    if (indices.length === 0) return;
    const next = promptStashStore.markExecutedMany(cwd, indices);
    stashRef.current = next;
    setStash(next);
    refreshHistoryAfterStashMutation();
  };

  const runSelectedStashBatch = () => {
    const indices = [...stashSelectionRef.current].sort((a, b) => a - b);
    const selected = indices.flatMap((index) => {
      const prompt = stashRef.current[index];
      return prompt ? [{ index, text: prompt.text }] : [];
    });
    const prompts = selected.map((entry) => entry.text);
    if (prompts.length === 0) return;

    for (const prompt of prompts) history.current = promptHistoryStore.append(cwd, prompt);
    resetAfterCacheExecution();
    void deliverMainPrompt(buildStashBatchPrompt(prompts), cachedBatchDisplay(prompts), [], false)
      // Rows are executed only after delivery succeeded. Marking them first
      // left them ticked for work that never ran.
      .then(() => markStashBatchExecuted(selected))
      .catch((error) => append({ kind: "text", role: "error", text: String(error) }));
  };

  useEffect(() => {
    if (!messageCacheController) return;
    const refresh = () => {
      const next = messageCacheController.list();
      stashRef.current = next;
      setStash(next);
      history.current = promptHistoryStore.load(cwd);
      histCursor.current = null;
    };
    const unsubscribe = messageCacheController.subscribe(refresh);
    const detach = messageCacheController.bindExecutor(
      session.sessionId,
      async (request: MessageCacheSendRequest): Promise<MessageCacheSendResult> => {
        const prompts = request.entries.map((entry) => entry.text);
        if (prompts.length > 1) {
          await deliverMainPrompt(buildStashBatchPrompt(prompts), cachedBatchDisplay(prompts), [], false);
          resetAfterCacheExecution(
            request.requester.kind === "subagent" ? request.requester.id : null,
          );
          return { count: prompts.length, route: "main" };
        }
        const prompt = prompts[0]!;
        if (request.requester.kind === "subagent") {
          await subagentManager.sendUserMessage(request.requester.id, prompt, [], prompt, false);
          resetAfterCacheExecution(request.requester.id);
          return { count: 1, route: "subagent" };
        }
        await deliverMainPrompt(prompt, prompt, [], false);
        resetAfterCacheExecution(null);
        return { count: 1, route: "main" };
      },
    );
    return () => {
      unsubscribe();
      detach();
    };
  }, [messageCacheController, session]);

  const performTriggerAction = (action: TriggerAction) => {
    const trigger = triggers[triggerCursorRef.current];
    if (!trigger || !triggerManager) return;
    let result: unknown;
    if (action === "pause") result = triggerManager.pause(trigger.id);
    else if (action === "resume") result = triggerManager.resume(trigger.id);
    else if (action === "cancel") result = triggerManager.cancel(trigger.id);
    else result = triggerManager.invoke(trigger.id);
    Promise.resolve(result).catch((error) => append({
      kind: "text",
      role: "error",
      text: `trigger ${action} failed: ${String(error)}`,
    }));
  };

  const killSelectedShell = () => {
    const shell = shells[shellCursorRef.current];
    if (!shell || !shellManager || (shell.state !== "starting" && shell.state !== "running")) return;
    Promise.resolve(shellManager.terminate(shell.id)).catch((error) => append({
      kind: "text",
      role: "error",
      text: `shell kill failed: ${String(error)}`,
    }));
  };

  const stepCheckMode = (step: number) => {
    const index = CHECK_MODE_PROFILES.indexOf(settingsRef.current.checkMode);
    update({ checkMode: CHECK_MODE_PROFILES[(index + step + CHECK_MODE_PROFILES.length) % CHECK_MODE_PROFILES.length]! });
  };

  const stepSandboxMode = (step: number) => {
    const current = settingsRef.current.sandboxMode ?? "auto";
    const index = SANDBOX_MODES.indexOf(current);
    update({ sandboxMode: SANDBOX_MODES[(index + step + SANDBOX_MODES.length) % SANDBOX_MODES.length]! });
  };

  const rowActions: Record<SettingRowId, { step?: (n: number) => void; enter?: () => void }> = {
    theme: { step: stepTheme },
    providers: { enter: openLogin },
    animations: { step: () => update({ animations: !settingsRef.current.animations }) },
    workingRuleAnimation: { step: stepWorkingRuleAnimation },
    outputMode: { step: stepOutputMode },
    showAgentMessages: { step: () => update({
      showAgentMessages: settingsRef.current.showAgentMessages === false,
    }) },
    webSearch: { step: () => update({ webSearch: !settingsRef.current.webSearch }) },
    writingStyle: { step: stepWritingStyle },
    explanationStrength: { step: stepExplanationStrength },
    checkMode: { step: stepCheckMode },
    sandboxMode: { step: stepSandboxMode },
    checkModel: { enter: () => {
      setModelQuery("");
      setModelSearchFocused(false);
      settingsPageRef.current = "checkModels";
      setPage("checkModels");
    } },
    checkPaths: { enter: () => append({
      kind: "text",
      role: "system",
      text: "use /check-path [list|add <directory>|remove <directory>|clear]",
    }) },
    thinkingLevel: { step: stepThinking },
    showThinking: { step: () => update({ showThinking: !settingsRef.current.showThinking }) },
    maxActiveSubagents: { step: (step) => update({
      maxActiveSubagents: Math.max(
        MIN_ACTIVE_SUBAGENTS,
        Math.min(MAX_ACTIVE_SUBAGENTS, settingsRef.current.maxActiveSubagents + step),
      ),
    }) },
    goalRetryLimit: { step: (step) => update({
      goalRetryLimit: Math.max(
        MIN_GOAL_RETRY_LIMIT,
        Math.min(
          MAX_GOAL_RETRY_LIMIT,
          normalizeGoalRetryLimit(settingsRef.current.goalRetryLimit) + step,
        ),
      ),
    }) },
    model: { enter: () => {
      setModelQuery("");
      setModelSearchFocused(false);
      settingsPageRef.current = "models";
      setPage("models");
    } },
  };

  const animationUnavailable = !settings.animations
    ? "  (global off)"
    : !supportsTrueColor()
      ? "  (no truecolor)"
      : "";
  const rowValues: Record<SettingRowId, string> = {
    theme: `‹ ${theme.name} ›`,
    providers: "login and custom setup ›",
    animations: `‹ ${settings.animations ? "on" : "off"} ›`,
    workingRuleAnimation: `‹ ${WORKING_RULE_ANIMATION_LABELS[settings.workingRuleAnimation]} ›${settings.workingRuleAnimation === "off" ? "" : animationUnavailable}`,
    outputMode: `‹ ${OUTPUT_MODE_LABELS[settings.outputMode ?? "normal"]} ›`,
    showAgentMessages: `‹ ${settings.showAgentMessages === false ? "off" : "on"} ›`,
    webSearch: `‹ ${settings.webSearch ? "on" : "off"} ›${searchProviders.length ? "" : "  (not on provider)"}`,
    writingStyle: `‹ ${settings.writingStyle} ›`,
    explanationStrength: `‹ ${settings.explanationStrength} ›`,
    checkMode: `‹ ${settings.checkMode} ›`,
    sandboxMode: `‹ ${settings.sandboxMode ?? "auto"} ›`,
    checkModel: `${settings.checkModel} ›`,
    checkPaths: `${checkPathsForProject(settings, cwd).length} additional · /check-path ›`,
    thinkingLevel: `‹ ${thinkingLevel} ›`,
    showThinking: `‹ ${settings.showThinking ? "on" : "off"} ›`,
    maxActiveSubagents: `‹ ${settings.maxActiveSubagents} ›`,
    goalRetryLimit: `‹ ${normalizeGoalRetryLimit(settings.goalRetryLimit) || "unlimited"} ›`,
    model: `${modelId} ›`,
  };

  const updateSettingsQuery = (query: string) => {
    const rows = filterSettingsRows(query);
    setSettingsQuery(query);
    setSelectedSettingId((current) =>
      rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null,
    );
  };

  const selectAgentView = (target: string | null): boolean => {
    const current = activeAgentIdRef.current;
    // Nothing moves between views, so a pending attachment cannot be stranded.
    if (target === current) return true;
    if (pendingImages.current.length > 0) {
      append({ kind: "text", role: "error", text: "send or remove attached images before switching agents" });
      return false;
    }
    if (pendingPastedTexts.current.length > 0) {
      append({ kind: "text", role: "error", text: "send or remove attached pasted text before switching agents" });
      return false;
    }
    const currentKey = current ?? "main";
    const targetKey = target ?? "main";
    viewDrafts.current.set(currentKey, inputRef.current?.plainText ?? "");
    viewEditingStashIndices.current.set(currentKey, editingStashIndex.current);
    activeAgentIdRef.current = target;
    setActiveAgentId(target);
    setEditingStash(viewEditingStashIndices.current.get(targetKey) ?? null);
    setEditorText(viewDrafts.current.get(targetKey) ?? "");
    setStashMode(false);
    histCursor.current = null;
    resetCancelArm();
    queueMicrotask(() => inputRef.current?.focus());
    return true;
  };

  useEffect(() => {
    if (spawnPreview) {
      if (!spawnPreviewRestoreView.current.active) {
        spawnPreviewRestoreView.current = {
          active: true,
          agentId: activeAgentIdRef.current,
        };
      }
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      setHelpOpen(false);
      setHistoryOpen(false);
      setAgentSelectorOpen(false);
      setTriggerPopup(false, false);
      setLoginOpen(false);
      setNewsOpen(false);
      newsOpenRef.current = false;
      const target = spawnPreview.requester.agentId;
      // Cancellation is for a missing recipient only. The requester's view is
      // often already selected, and that never needs a switch.
      if (target && !agents.some((agent) => agent.id === target)) {
        spawnPreviewManager?.cancel("unavailable");
      } else if (target !== activeAgentIdRef.current && !selectAgentView(target)) {
        spawnPreviewManager?.cancel("unavailable");
      }
      return;
    }
    if (!spawnPreviewRestoreView.current.active) return;
    const target = spawnPreviewRestoreView.current.agentId;
    spawnPreviewRestoreView.current.active = false;
    if (!target || agents.some((agent) => agent.id === target)) selectAgentView(target);
    else selectAgentView(null);
  }, [spawnPreview?.id]);

  const cycleAgentView = (direction: -1 | 1) => {
    const ids: Array<string | null> = [null, ...agents.map((agent) => agent.id)];
    if (ids.length === 1) return;
    const current = ids.findIndex((id) => id === activeAgentIdRef.current);
    const next = (current + direction + ids.length) % ids.length;
    selectAgentView(ids[next] ?? null);
  };

  const setTranscriptFocus = (focused: boolean) => {
    transcriptFocusedRef.current = focused;
    setTranscriptFocused(focused);
    if (focused) {
      const cursor = Math.max(0, visibleLines.length - 1);
      transcriptCursorRef.current = cursor;
      setTranscriptCursor(cursor);
    } else queueMicrotask(() => inputRef.current?.focus());
  };

  /**
   * Put a row in the tree so it can be scrolled to.
   *
   * Only rows near the end are mounted, so anything that scrolls to a row has
   * to ask for it first. The floor keeps it mounted: without one, the very next
   * frame could decide the reader is still at the end and drop it again before
   * React had rendered it.
   */
  const ensureTranscriptRowMounted = (index: number) => {
    const next = windowStartForRow(transcriptWindowStartRef.current, index);
    if (next >= transcriptWindowStartRef.current) return;
    transcriptWindowStartRef.current = next;
    transcriptWindowFloorRef.current = Math.min(transcriptWindowFloorRef.current, next);
    setTranscriptWindowTick((tick) => tick + 1);
  };

  /**
   * Scroll to a row once React has drawn it.
   *
   * A row that had to be mounted first is not in the tree at microtask time,
   * and a long transcript can take several frames to draw it, so keep asking
   * rather than asking once. `wanted` stops a walk that has moved on: the
   * reader holding a key starts one of these per row, and the older ones must
   * not drag the view back to where the walk began.
   */
  const scrollToTranscriptRow = (
    resolve: () => number,
    options: { fromTop?: boolean; wanted?: () => boolean } = {},
  ) => {
    transcriptRevealsRef.current++;
    let tries = 0;
    const done = () => {
      transcriptRevealsRef.current = Math.max(0, transcriptRevealsRef.current - 1);
    };
    const reveal = () => {
      if (options.wanted && !options.wanted()) return done();
      const index = resolve();
      const scroll = transcriptScrollRef.current;
      if (scroll && index >= 0) {
        // Asked for again on every try: the row is only held by the window
        // while something wants it, and the frame that runs in between is free
        // to decide the reader is at the end of the transcript.
        ensureTranscriptRowMounted(index);
        if (scroll.findDescendantById(`transcript-line-${index}`)) {
          // From the top, the row lands on the first screen row instead of the
          // last: `scrollChildIntoView` moves as little as it can.
          if (options.fromTop) scroll.scrollTop = 0;
          scroll.scrollChildIntoView(`transcript-line-${index}`);
          return done();
        }
      }
      if (tries++ < ROW_DRAW_TRIES) setTimeout(reveal, ROW_DRAW_RETRY_MS);
      else done();
    };
    queueMicrotask(reveal);
  };

  const revealTranscriptCursor = (index: number) => {
    scrollToTranscriptRow(() => index, { wanted: () => transcriptCursorRef.current === index });
  };

  /**
   * Put a revealed row's first line at the top of the viewport.
   *
   * `scrollChildIntoView` scrolls the least it can, which parks a row that just
   * grew at the bottom edge with its new content still below the fold. Rows are
   * only ever expanded to be read, so anchor the top and show as much as fits.
   * The layout runs after React commits, hence the second, later attempt.
   */
  const anchorTranscriptRow = (index: number) => {
    ensureTranscriptRowMounted(index);
    const apply = () => {
      const scroll = transcriptScrollRef.current;
      const row = scroll?.findDescendantById(`transcript-line-${index}`);
      if (!scroll || !row) return;
      const target = topAnchorScrollTop(
        row.y - scroll.content.y,
        scroll.scrollHeight,
        scroll.viewport.height,
      );
      // scrollBy, not scrollTop: it is the path that marks the scroll as
      // manual, and without that sticky-to-bottom pins the row straight back
      // off the top of the screen as the revealed content grows beneath it.
      if (target !== scroll.scrollTop) scroll.scrollBy({ x: 0, y: target - scroll.scrollTop });
    };
    queueMicrotask(apply);
    setTimeout(apply, 30);
  };

  const moveTranscriptCursor = (step: -1 | 1) => {
    const next = Math.max(0, Math.min(visibleLines.length - 1, transcriptCursorRef.current + step));
    transcriptCursorRef.current = next;
    setTranscriptCursor(next);
    revealTranscriptCursor(next);
  };

  const selectTranscriptRow = (index: number) => {
    transcriptFocusedRef.current = true;
    setTranscriptFocused(true);
    transcriptCursorRef.current = index;
    setTranscriptCursor(index);
    revealTranscriptCursor(index);
  };

  const toggleTranscriptDetail = (index = transcriptCursorRef.current) => {
    const line = visibleLines[index];
    if (!line || (line.kind !== "tool" && line.kind !== "tool-summary")) return;
    const key = projectedLineKey(line, index);
    const current = detailOverridesRef.current.get(key) ?? outputMode === "verbose";
    const next = new Map(detailOverridesRef.current);
    next.set(key, !current);
    detailOverridesRef.current = next;
    setDetailOverrides(next);
    if (!current) anchorTranscriptRow(index);
  };

  const clickTranscriptDisclosure = (index: number) => {
    selectTranscriptRow(index);
    toggleTranscriptDetail(index);
  };
  // Rows are memoized, so the handler they receive has to keep one identity for
  // the life of the app. The ref carries the current closure behind it.
  clickTranscriptDisclosureRef.current = clickTranscriptDisclosure;

  const copyTranscriptRow = () => {
    const line = visibleLines[transcriptCursorRef.current];
    if (!line) return;
    copyTranscriptText(projectedLineRawText(line), {
      osc52: (value) => renderer.copyToClipboardOSC52(value),
    }).catch((error) => append({
      kind: "text",
      role: "error",
      text: `copy failed: ${String(error)}`,
    }));
  };

  usePaste((event) => {
    const controller = loginControllerRef.current;
    if (loginOpen) {
      if (controller?.acceptsTextPaste()) {
        event.stopPropagation();
        controller.pasteText(decodePasteBytes(event.bytes));
      }
      return;
    }
    stageLargePastedText(event);
  });

  useKeyboard((key) => {
    if (spawnPreview) {
      const isPreviewReturn = ["return", "enter", "kpenter", "linefeed"].includes(key.name);
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        key.stopPropagation();
        spawnPreviewInputRef.current?.setText("");
        // Bind the action to the request the popup rendered; if the active
        // request changed under it, this is a no-op instead of hitting another.
        spawnPreviewManager?.cancel("cancelled", spawnPreview.id);
      } else if (isPreviewReturn && !key.shift && !key.ctrl && !key.meta && !key.option) {
        key.stopPropagation();
        const note = spawnPreviewInputRef.current?.plainText ?? "";
        spawnPreviewInputRef.current?.setText("");
        spawnPreviewManager?.approve(note, spawnPreview.id);
      }
      return;
    }

    if (key.ctrl && key.name === "c" && visibleQuestionnaire) {
      key.stopPropagation();
      if (visibleQuestionnaire.customInput) {
        questionnaireInputRef.current?.setText("");
        questionnaireManager?.cancelCustom();
      } else {
        questionnaireManager?.cancel();
      }
      return;
    }

    if (key.ctrl && key.name === "c" && loginOpen) {
      key.stopPropagation();
      loginControllerRef.current?.handleKey({
        ...key,
        name: "escape",
        ctrl: false,
        sequence: "\u001b",
      });
      return;
    }

    if (key.ctrl && key.name === "c" && (
      settingsOpenRef.current ||
      triggersOpenRef.current ||
      agentSelectorOpen ||
      helpOpen ||
      historyOpen ||
      statsOpenRef.current ||
      newsOpenRef.current
    )) {
      key.stopPropagation();
      resetCancelArm();
      resetQuitArm();
      if (settingsOpenRef.current) {
        if (settingsPageRef.current !== "main") {
          settingsPageRef.current = "main";
          setPage("main");
        } else {
          closeSettings();
        }
      } else if (triggersOpenRef.current) setTriggerPopup(false);
      else if (agentSelectorOpen) {
        setAgentSelectorOpen(false);
        queueMicrotask(() => inputRef.current?.focus());
      } else if (helpOpen) setHelpOpen(false);
      else if (historyOpen) {
        setHistoryOpen(false);
        queueMicrotask(() => inputRef.current?.focus());
      } else if (statsOpenRef.current) closeStats();
      else if (newsOpenRef.current) closeNews();
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.stopPropagation();
      resetCancelArm();
      const promptOwnsInput =
        !visibleQuestionnaire &&
        !spawnPreview &&
        !loginOpen &&
        !triggersOpenRef.current &&
        !agentSelectorOpen &&
        !helpOpen &&
        !historyOpen &&
        !statsOpenRef.current &&
        !settingsOpenRef.current;
      const inputValue = inputRef.current?.plainText ?? "";
      if (promptOwnsInput && (
        inputValue.length > 0 ||
        pendingImages.current.length > 0 ||
        pendingPastedTexts.current.length > 0
      )) {
        clearActiveDraft();
        return;
      }
      // Keyed off a timestamp, not `quitArmed`: two fast presses can land in
      // one React batch, where the state has not updated between them yet.
      const now = Date.now();
      if (now - lastQuitPress.current < QUIT_WINDOW_MS) void onExit();
      lastQuitPress.current = now;
      setQuitArmed(true);
      clearTimeout(quitTimer.current);
      quitTimer.current = setTimeout(() => setQuitArmed(false), QUIT_WINDOW_MS);
      return;
    }
    // Any other key disarms, so Ctrl+C · x · Ctrl+C does not quit.
    if (lastQuitPress.current) resetQuitArm();
    if (key.name !== "escape" && lastCancelPress.current !== null) resetCancelArm();

    if (visibleQuestionnaire) {
      const isQuestionnaireReturn =
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "kpenter" ||
        key.name === "linefeed";
      if (visibleQuestionnaire.customInput) {
        if (key.name === "escape") {
          key.stopPropagation();
          questionnaireInputRef.current?.setText("");
          questionnaireManager?.cancelCustom();
        } else if (
          isQuestionnaireReturn &&
          !key.shift &&
          !key.ctrl &&
          !key.meta &&
          !key.option
        ) {
          key.stopPropagation();
          const value = questionnaireInputRef.current?.plainText ?? "";
          if (questionnaireManager?.submitCustom(value)) {
            questionnaireInputRef.current?.setText("");
          }
        }
        return;
      }

      key.stopPropagation();
      if (key.name === "escape") questionnaireManager?.cancel();
      else if (key.name === "up") questionnaireManager?.moveOption(-1);
      else if (key.name === "down") questionnaireManager?.moveOption(1);
      else if (
        key.name === "left" ||
        (key.name === "tab" && key.shift) ||
        key.name === "backtab" ||
        key.sequence === "\u001b[Z"
      ) questionnaireManager?.movePage(-1);
      else if (key.name === "right" || key.name === "tab") questionnaireManager?.movePage(1);
      else if (isQuestionnaireReturn) {
        const action = questionnaireManager?.select();
        if (action === "custom") queueMicrotask(() => questionnaireInputRef.current?.focus());
      }
      return;
    }

    if (loginOpen) {
      if (key.ctrl && key.name === "v" && loginControllerRef.current?.acceptsTextPaste()) {
        key.stopPropagation();
        void pasteLoginClipboardText();
        return;
      }
      if (loginControllerRef.current?.handleKey(key)) key.stopPropagation();
      return;
    }

    if (providersOpen) {
      if (providersControllerRef.current?.handleKey(key)) key.stopPropagation();
      return;
    }

    if (key.ctrl && key.name === "y") {
      key.stopPropagation();
      setTranscriptFocus(!transcriptFocusedRef.current);
      return;
    }

    if (transcriptFocusedRef.current) {
      key.stopPropagation();
      if (key.name === "escape") setTranscriptFocus(false);
      else if (key.name === "j" || key.name === "down") moveTranscriptCursor(1);
      else if (key.name === "k" || key.name === "up") moveTranscriptCursor(-1);
      else if (["return", "enter", "kpenter", "linefeed"].includes(key.name)) toggleTranscriptDetail();
      else if (key.name === "c" && !key.ctrl && !key.meta && !key.option) copyTranscriptRow();
      return;
    }

    if (statsOpenRef.current || statsOpen) {
      key.stopPropagation();
      const maxOffset = maxStatsScrollOffset(statsSnapshot, width, height);
      if (key.name === "escape") closeStats();
      else if (key.name === "home") setStatsScrollOffset(0);
      else if (key.name === "end") setStatsScrollOffset(maxOffset);
      else if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") {
        const amount = key.name === "pageup" || key.name === "pagedown" ? 5 : 1;
        const direction = key.name === "up" || key.name === "pageup" ? -1 : 1;
        setStatsScrollOffset((offset) => Math.max(0, Math.min(maxOffset, offset + direction * amount)));
      }
      return;
    }

    if (key.ctrl && key.name === "t") {
      key.stopPropagation();
      if (triggersOpenRef.current) setTriggerPopup(false);
      else openProcesses();
      return;
    }

    if (triggersOpenRef.current) {
      key.stopPropagation();
      if (key.name === "escape") {
        setTriggerPopup(false);
      } else if (processTabForKey(key, processTabRef.current)) {
        const tab = processTabForKey(key, processTabRef.current)!;
        processTabRef.current = tab;
        setProcessTab(tab);
      } else if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") {
        const direction = key.name === "up" || key.name === "pageup" ? -1 : 1;
        const steps = key.name === "pageup" || key.name === "pagedown" ? 5 : 1;
        const shellTab = processTabRef.current === "shells";
        let next = shellTab ? shellCursorRef.current : triggerCursorRef.current;
        for (let index = 0; index < steps; index++) {
          next = shellTab
            ? moveProcessSelection(next, shells.length, direction)
            : moveTriggerSelection(next, triggers.length, direction);
        }
        if (shellTab) {
          shellCursorRef.current = next;
          setShellCursor(next);
        } else {
          triggerCursorRef.current = next;
          setTriggerCursor(next);
        }
      } else if (processTabRef.current === "shells") {
        if (key.name === "k" || key.sequence === "k") killSelectedShell();
      } else {
        const action = triggerActionForKey(key, triggers[triggerCursorRef.current]);
        if (action) performTriggerAction(action);
      }
      return;
    }

    if (key.ctrl && key.name === "l") {
      key.stopPropagation();
      if (agentSelectorOpen) {
        setAgentSelectorOpen(false);
        queueMicrotask(() => inputRef.current?.focus());
      } else {
        settingsOpenRef.current = false;
        setSettingsOpen(false);
        setHelpOpen(false);
        setHistoryOpen(false);
        setTriggerPopup(false, false);
        setNewsOpen(false);
        newsOpenRef.current = false;
        const selected = Math.max(
          0,
          agentTreeRows.findIndex((row) => row.id === activeAgentIdRef.current),
        );
        agentSelectorCursorRef.current = selected;
        setAgentSelectorCursor(selected);
        setAgentSelectorOpen(true);
      }
      return;
    }

    if (agentSelectorOpen) {
      key.stopPropagation();
      if (key.name === "escape") {
        setAgentSelectorOpen(false);
        queueMicrotask(() => inputRef.current?.focus());
      } else if (key.name === "up" || key.name === "down") {
        const next = moveAgentSelection(
          agentSelectorCursorRef.current,
          agentTreeRows.length,
          key.name === "up" ? -1 : 1,
        );
        agentSelectorCursorRef.current = next;
        setAgentSelectorCursor(next);
      } else if (
        key.name === "right" ||
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "kpenter"
      ) {
        const target = agentTreeRows[agentSelectorCursorRef.current]?.id ?? null;
        if (selectAgentView(target)) setAgentSelectorOpen(false);
      }
      return;
    }

    if (helpOpen) {
      key.stopPropagation();
      if (key.name === "escape" || key.sequence === "?") setHelpOpen(false);
      else if (key.name === "up" || key.name === "pageup") {
        setHelpScrollOffset((offset) => Math.max(0, offset - (key.name === "pageup" ? 5 : 1)));
      } else if (key.name === "down" || key.name === "pagedown") {
        setHelpScrollOffset((offset) =>
          Math.min(maxHelpScrollOffset(height, width), offset + (key.name === "pagedown" ? 5 : 1)),
        );
      }
      return;
    }

    if (historyOpen) {
      if (key.name === "escape") {
        key.stopPropagation();
        setHistoryOpen(false);
        queueMicrotask(() => inputRef.current?.focus());
      }
      return; // navigation and Enter belong to the focused select
    }

    if (key.ctrl && key.name === "h") {
      key.stopPropagation();
      openHistory();
      return;
    }

    const printableKey = printableKeyCharacter(key.name, key.sequence, key.raw);
    if (key.ctrl && printableKey === "n") {
      key.stopPropagation();
      if (newsOpenRef.current) closeNews();
      else openNews();
      return;
    }
    if (newsOpenRef.current || newsOpen) {
      key.stopPropagation();
      if (key.name === "escape") closeNews();
      else if (key.name === "left") moveNewsCursor(1);
      else if (key.name === "right") moveNewsCursor(-1);
      else if (key.name === "space" || key.sequence === " ") toggleCurrentNewsRead();
      else if (printableKey === "n") jumpFromNews("answer");
      else if (printableKey === "p") jumpFromNews("prompt");
      else if (printableKey === "c") void copyNewsAnswer();
      else if (key.name === "return" || key.name === "enter" || key.name === "kpenter")
        replyToCurrentNews();
      return;
    }

    if (key.ctrl && printableKey === "o") {
      key.stopPropagation();
      if (todoOpenRef.current) closeTodo();
      else openTodo();
      return;
    }
    if (todoVisible) {
      key.stopPropagation();
      if (key.name === "escape") closeTodo();
      else if (key.name === "up") moveTodoCursor(-1);
      else if (key.name === "down") moveTodoCursor(1);
      else if (key.name === "pageup") moveTodoCursor(-todoPageSize);
      else if (key.name === "pagedown") moveTodoCursor(todoPageSize);
      else if (key.name === "home") moveTodoCursorTo("first");
      else if (key.name === "end") moveTodoCursorTo("last");
      else if (printableKey === "f") cycleTodoFilterState();
      return;
    }

    // `?` on an empty prompt opens help instead of typing a question mark.
    // With text already in the line it is just a character.
    if (key.sequence === "?" && !settingsOpen && !inputRef.current?.plainText) {
      key.stopPropagation();
      setHelpScrollOffset(0);
      setHelpOpen(true);
      return;
    }

    if (settingsOpenRef.current) {
      if (key.name === "escape") {
        key.stopPropagation();
        if (settingsPageRef.current !== "main") {
          settingsPageRef.current = "main";
          setPage("main");
        } else {
          closeSettings();
        }
        return;
      }
      if (settingsPageRef.current !== "main") {
        const isModelReturn = key.name === "return" || key.name === "enter" || key.name === "kpenter";
        if (modelSearchFocused) {
          if ((key.name === "up" || key.name === "down" || isModelReturn) && visibleModels.length > 0) {
            key.stopPropagation();
            setModelSearchFocused(false);
          }
          return;
        }
        if (isModelSearchShortcut(key, modelSearchFocused)) {
          key.stopPropagation();
          setModelSearchFocused(true);
        }
        return;
      }

      const isSettingsReturn =
        key.name === "return" || key.name === "enter" || key.name === "kpenter" || key.name === "linefeed";
      if (settingsSearchFocusedRef.current) {
        if (key.name === "down" || key.name === "up" || isSettingsReturn) {
          key.stopPropagation();
          settingsSearchFocusedRef.current = false;
          setSettingsSearchFocused(false);
          setSelectedSettingId((current) =>
            visibleSettingRows.some((row) => row.id === current)
              ? current
              : key.name === "up"
                ? visibleSettingRows.at(-1)?.id ?? null
                : visibleSettingRows[0]?.id ?? null,
          );
        }
        return; // printable keys and editing keys belong to the focused <input>
      }

      if (isSettingsSearchShortcut(key, settingsSearchFocusedRef.current)) {
        key.stopPropagation();
        settingsSearchFocusedRef.current = true;
        setSettingsSearchFocused(true);
        return;
      }

      key.stopPropagation();
      // Reachable only with the search unfocused, so `s` never eats a keystroke
      // meant for the filter.
      if (printableKeyCharacter(key.name, key.sequence, key.raw) === "s") {
        promoteSessionSettings();
        return;
      }
      const action = selectedSettingId ? rowActions[selectedSettingId] : undefined;
      const confirming = key.name === "space" || key.sequence === " " || isSettingsReturn;
      if (key.name === "up" || key.name === "down") {
        setSelectedSettingId((current) =>
          moveSettingSelection(visibleSettingRows, current, key.name === "up" ? -1 : 1),
        );
      } else if (key.name === "left") action?.step?.(-1);
      else if (key.name === "right") action?.step?.(1);
      else if (confirming) (action?.enter ?? (() => action?.step?.(1)))();
      return;
    }

    if ((key.meta || key.option) && !key.ctrl && printableKey === "i") {
      key.stopPropagation();
      if (shellModeRef.current) return;
      const next = !inputModeRef.current;
      inputModeRef.current = next;
      setInputMode(next);
      return;
    }

    if (
      key.ctrl &&
      key.name === "end" &&
      !inputRef.current?.plainText &&
      pendingImages.current.length === 0 &&
      pendingPastedTexts.current.length === 0
    ) {
      key.stopPropagation();
      const transcriptScroll = transcriptScrollRef.current;
      if (transcriptScroll) transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
      return;
    }

    const isAgentCycle =
      (key.name === "tab" && key.shift) ||
      key.name === "backtab" ||
      key.sequence === "\u001b[Z";
    if (isAgentCycle) {
      key.stopPropagation();
      cycleAgentView(key.ctrl ? -1 : 1);
      return;
    }

    const isReturn =
      key.name === "return" ||
      key.name === "enter" ||
      key.name === "kpenter" ||
      key.name === "linefeed";
    const hasAlt = key.meta || key.option;
    // A terminal can encode Shift/Ctrl/Alt+Enter in the escape sequence even
    // before OpenTUI negotiates the keyboard protocol. Merge those modifier
    // bits with any the parser already decoded, so plain Enter still sends
    // and a modified Enter routes to exactly one action.
    const sequenceMods = isReturn ? null : modifiedEnterFromSequence(key.sequence);
    const isReturnKey = isReturn || sequenceMods !== null;
    const hasAltForReturn = hasAlt || (sequenceMods?.alt ?? false);
    const hasCtrlForReturn = key.ctrl || (sequenceMods?.ctrl ?? false);
    const hasShiftForReturn = key.shift || (sequenceMods?.shift ?? false);
    // Ctrl+Alt+Enter is an explicit cache alias for terminals that reserve
    // Alt+Enter, such as Windows Terminal's default fullscreen binding.
    const isCacheReturn = hasAltForReturn && isReturnKey;
    const isNewlineReturn = (hasCtrlForReturn || hasShiftForReturn) && !hasAltForReturn && isReturnKey;
    const isPlainReturn =
      isReturnKey && !hasCtrlForReturn && !hasShiftForReturn && !hasAltForReturn;
    const inputValue = inputRef.current?.plainText ?? "";
    const commandMatches =
      shellModeRef.current || stashOpenRef.current || commandSuggestionsDismissedRef.current
        ? []
        : matchingCommandsForTarget(
          inputValue,
          activeAgentIdRef.current ? "subagent" : "main",
        );
    const inputCursor = inputRef.current?.cursorOffset ?? inputValue.length;
    const pathMatches =
      (!shellModeRef.current && activeAgentIdRef.current)
      || stashOpenRef.current
      || commandSuggestionsDismissedRef.current
      || isCommandInput(inputValue)
        ? []
        : pathCompletions(
          inputValue,
          inputCursor,
          shellModeRef.current && activeAgentIdRef.current
            ? subagentManager.getAgents().find(
              (agent) => agent.id === activeAgentIdRef.current,
            )?.worktree.path ?? cwd
            : cwd,
        );
    const visiblePathMatches = shouldAutoShowPathCompletions(inputValue, inputCursor)
      ? pathMatches
      : [];
    const argumentMatchesOff = shellModeRef.current
      || stashOpenRef.current
      || commandSuggestionsDismissedRef.current
      || Boolean(activeAgentIdRef.current);
    const providersMatches = argumentMatchesOff
      ? []
      : providersCompletions(inputValue, inputCursor, managedProvidersRef.current);
    const settingsMatches = argumentMatchesOff
      ? []
      : settingsCompletions(inputValue, inputCursor, cwd);
    // Every source carries path-completion offsets, so one insert path serves all.
    const closedSetMatches = providersMatches.length > 0 ? providersMatches : settingsMatches;
    const argumentMatches = closedSetMatches.length > 0 ? closedSetMatches : pathMatches;
    const visibleArgumentMatches = closedSetMatches.length > 0
      ? closedSetMatches
      : visiblePathMatches;
    const inputSuggestionCount = commandMatches.length
      || closedSetMatches.length
      || visiblePathMatches.length;
    const isContinuationReturn =
      isPlainReturn &&
      inputValue.endsWith("\\") &&
      (inputRef.current?.cursorOffset ?? 0) >= inputValue.length;
    const isWordBackspace =
      key.ctrl && (key.name === "backspace" || key.name === "w");

    if (!shellModeRef.current
      && printableKey === "!"
      && !inputValue
      && pendingImages.current.length === 0
      && pendingPastedTexts.current.length === 0
      && !stashOpenRef.current) {
      key.stopPropagation();
      setShellInputMode(true);
      return;
    }

    if (shellModeRef.current
      && !inputValue
      && (key.name === "backspace" || key.name === "escape")) {
      key.stopPropagation();
      setShellInputMode(false);
      resetCancelArm();
      return;
    }

    if ((key.meta || key.option) && key.name === "v") {
      key.stopPropagation();
      void pasteClipboardImage();
      return;
    }

    if (isNewlineReturn) {
      key.stopPropagation();
      inputRef.current?.newLine();
      handleTextareaChange();
      histCursor.current = null;
      if (stashOpenRef.current) setSelectedStash(-1);
      return;
    }

    // Enhanced keyboard protocols distinguish Ctrl+Backspace from Ctrl+H.
    // Legacy terminals can send both Ctrl+H and Backspace as raw ^H. Treat
    // that ambiguous byte as Backspace, and leave /history as the fallback.
    if (isWordBackspace) {
      key.stopPropagation();
      inputRef.current?.deleteWordBackward();
      handleTextareaChange();
      histCursor.current = null;
      if (stashOpenRef.current) setSelectedStash(-1);
      return;
    }

    if (
      stashOpenRef.current &&
      stashCursorRef.current >= 0 &&
      key.name === "delete"
    ) {
      key.stopPropagation();
      deleteStashedPrompt(stashCursorRef.current);
      return;
    }

    // Alt+Enter and Ctrl+Alt+Enter cache without executing.
    if (isCacheReturn) {
      key.stopPropagation();
      if (pendingImages.current.length > 0 || pendingPastedTexts.current.length > 0) {
        append({
          kind: "text",
          role: "error",
          text: pendingImages.current.length > 0
            ? "image prompts cannot be stored in the cache; send or remove the image first"
            : "pasted-text attachments cannot be stored in the cache; send or remove the pasted text first",
        });
        return;
      }
      if (inputValue.trim()) {
        const editingIndex = editingStashIndex.current;
        if (editingIndex === null) addToStash(inputValue);
        else replaceStashedPrompt(editingIndex, inputValue, false);
        setEditingStash(null);
        setEditorText("");
        setSelectedStash(-1);
      }
      return;
    }

    if (key.name === "tab" && !key.shift) {
      if (stashOpenRef.current || !inputValue.trim()) {
        key.stopPropagation();
        if (stashOpenRef.current) {
          const index = stashCursorRef.current;
          const prompt = index >= 0 ? stashRef.current[index] : undefined;
          if (prompt && inputRef.current) {
            pendingStashCheckout.current = { index, text: prompt.text };
            setEditingStash(index);
            histCursor.current = null;
            draft.current = "";
          }
          setStashMode(false);
        } else if (stashRef.current.length > 0) {
          setStashMode(true);
        }
        queueMicrotask(() => inputRef.current?.focus());
        return;
      }
      if (commandMatches.length > 0 && !/\s/.test(inputValue)) {
        key.stopPropagation();
        const selected = commandMatches[Math.min(commandCursorRef.current, commandMatches.length - 1)]!;
        setEditorText(selected.name);
        return;
      }

      const previousCycle = pathCompletionCycle.current;
      const continuing = previousCycle !== null
        && previousCycle.currentValue === inputValue
        && previousCycle.currentCursor === inputCursor;
      const completions = continuing
        ? previousCycle!.completions
        : argumentMatches;
      if (completions.length > 0) {
        key.stopPropagation();
        const index = continuing
          ? (previousCycle!.index + 1) % completions.length
          : Math.min(commandCursorRef.current, completions.length - 1);
        const sourceValue = continuing ? previousCycle!.sourceValue : inputValue;
        const completed = applyPathCompletion(sourceValue, completions[index]!);
        setEditorText(completed.value, completed.cursorOffset, true);
        pathCompletionCycle.current = {
          sourceValue,
          completions,
          index,
          currentValue: completed.value,
          currentCursor: completed.cursorOffset,
        };
        histCursor.current = null;
        return;
      }
    }

    if (inputModeRef.current && isPlainReturn && !stashOpenRef.current) {
      key.stopPropagation();
      inputRef.current?.newLine();
      handleTextareaChange();
      histCursor.current = null;
      return;
    }

    if (isContinuationReturn) {
      key.stopPropagation();
      inputRef.current?.deleteCharBackward();
      inputRef.current?.newLine();
      handleTextareaChange();
      histCursor.current = null;
      if (stashOpenRef.current) setSelectedStash(-1);
      return;
    }

    if (shellModeRef.current && isPlainReturn) {
      key.stopPropagation();
      submitShellCommand();
      return;
    }

    if (isPlainReturn && commandMatches.length > 0 && !/\s/.test(inputValue)) {
      key.stopPropagation();
      const selected = commandMatches[Math.min(commandCursorRef.current, commandMatches.length - 1)]!;
      submitPrompt(selected.name);
      return;
    }

    if (isPlainReturn && visibleArgumentMatches.length > 0) {
      key.stopPropagation();
      const index = Math.min(commandCursorRef.current, visibleArgumentMatches.length - 1);
      const completed = applyPathCompletion(inputValue, visibleArgumentMatches[index]!);
      setEditorText(completed.value, completed.cursorOffset, true);
      pathCompletionCycle.current = {
        sourceValue: inputValue,
        completions: visibleArgumentMatches,
        index,
        currentValue: completed.value,
        currentCursor: completed.cursorOffset,
      };
      histCursor.current = null;
      return;
    }

    if (stashOpenRef.current && isPlainReturn) {
      key.stopPropagation();
      if (stashSelectionRef.current.size > 0) {
        runSelectedStashBatch();
        return;
      }
      const index = stashCursorRef.current;
      if (index >= 0) {
        const prompt = stashRef.current[index];
        // submitPrompt ticks the row after delivery succeeds.
        if (prompt) submitPrompt(prompt.text, index);
      } else if (inputValue.trim()) {
        addToStash(inputValue);
        setEditorText("");
      }
      return;
    }

    if (isPlainReturn) {
      key.stopPropagation();
      submitPrompt();
      return;
    }

    // Editing puts you back on a fresh line, so the next Up starts from the
    // most recent prompt and Down returns to what you just typed.
    if (!NAV_KEYS.has(key.name)) {
      histCursor.current = null;
      if (stashOpenRef.current) setSelectedStash(-1);
    }

    if (key.name === "up" || key.name === "down") {
      if (stashOpenRef.current) {
        key.stopPropagation();
        moveStash(key.name === "up" ? -1 : 1, key.shift);
        return;
      }
      if (inputSuggestionCount > 0) {
        key.stopPropagation();
        const next = moveCommandSelection(
          commandCursorRef.current,
          inputSuggestionCount,
          key.name === "up" ? -1 : 1,
        );
        commandCursorRef.current = next;
        setCommandCursor(next);
        return;
      }
      // Keep arrow navigation inside multiline or visually wrapped prompts.
      // The editor reports no cursor change for vertical moves, so re-measure
      // the visual row after the textarea processes the key.
      if ((inputRef.current?.editorView.getTotalVirtualLineCount() ?? 1) > 1) {
        scheduleInputMetrics();
        return;
      }
      if (key.name === "up" && !inputValue && pendingImages.current.length === 0) {
        const queued = visibleTx.pending.some((pending) =>
          !pending.delivered &&
          pending.line.kind === "text" &&
          pending.line.role === "user" &&
          Boolean(pending.deliveryText),
        );
        if (queued) {
          key.stopPropagation();
          void recallQueuedUserMessage(activeAgentIdRef.current).catch((error) =>
            append({ kind: "text", role: "error", text: String(error) }),
          );
          return;
        }
      }
      if (activeAgentId) return;
      key.stopPropagation();
      recall(key.name === "up" ? -1 : 1);
      return;
    }

    // Home/End/PageUp/PageDown move the cursor without a reported cursor
    // change, so re-measure after the textarea handles them.
    if (key.name === "home" || key.name === "end" || key.name === "pageup" || key.name === "pagedown") {
      scheduleInputMetrics();
    }

    if (key.name === "escape") {
      if (stashOpenRef.current) {
        key.stopPropagation();
        resetCancelArm();
        setStashMode(false);
      } else if (inputSuggestionCount > 0) {
        key.stopPropagation();
        setCommandSuggestionsClosed(true);
        if ((activeAgentId && visibleBusy) || (!activeAgentId && busyRef.current)) {
          const selected = activeAgentIdRef.current;
          lastCancelPress.current = Date.now();
          cancelTarget.current = selected ?? "main";
          setCancelArmed(true);
          clearTimeout(cancelTimer.current);
          cancelTimer.current = setTimeout(resetCancelArm, CANCEL_WINDOW_MS);
        } else {
          resetCancelArm();
        }
      } else if ((activeAgentId && visibleBusy) || (!activeAgentId && busyRef.current)) {
        key.stopPropagation();
        const now = Date.now();
        // Cancel the agent named by the ref, not the state: a switch-then-Esc in
        // one input chunk must abort the newly selected agent, not the previous.
        const selected = activeAgentIdRef.current;
        const target = selected ?? "main";
        if (confirmsCancellation(lastCancelPress.current, cancelTarget.current, target, now)) {
          resetCancelArm();
          if (selected) {
            void subagentManager.abortAgent(selected).catch((error) =>
              append({ kind: "text", role: "error", text: String(error) }),
            );
          } else cancel();
        } else {
          lastCancelPress.current = now;
          cancelTarget.current = target;
          setCancelArmed(true);
          clearTimeout(cancelTimer.current);
          cancelTimer.current = setTimeout(resetCancelArm, CANCEL_WINDOW_MS);
        }
      } else {
        resetCancelArm();
      }
      return;
    }
    if (key.ctrl && key.name === "p") {
      key.stopPropagation();
      setSettingsQuery("");
      setSelectedSettingId(SETTINGS_ROWS[0]!.id);
      settingsSearchFocusedRef.current = true;
      setSettingsSearchFocused(true);
      settingsPageRef.current = "main";
      setPage("main");
      settingsOpenRef.current = true;
      setSettingsOpen(true);
    }
  });

  const lastLine = visibleLines[visibleLines.length - 1];
  // Reset keys for the render boundaries: a shown error clears as soon as the
  // transcript or the open popup changes, so the next state gets a fresh try.
  const transcriptResetKey = `${activeAgentId ?? "main"}:${visibleLines.length}`;
  useEffect(() => {
    if (!afkStatus.active || !questionnaire) return;
    if (afkStartingRef.current) return;
    // One delegate in flight. The next queued request starts only once this
    // one has durably resolved, which is what clearing the ref means.
    if (afkDelegateRef.current) return;
    void startAfkDelegate(questionnaire);
  }, [afkStatus.active, afkStatus.generation, questionnaire?.id]);

  useEffect(() => {
    // The user took AFK off, or the request went away under the delegate.
    if (!afkStatus.active && afkDelegateRef.current) void stopAfkDelegate();
  }, [afkStatus.active]);

  const popupResetKey = [
    loginOpen, spawnPreview?.id ?? "", Boolean(questionnaire), helpOpen, triggersOpen,
    agentSelectorOpen, historyOpen, newsOpen, todoVisible, statsOpen, settingsOpen, page,
  ].join(":");
  const streamGap = visibleTx.stream
    ? needsTranscriptGap(lastLine, { kind: "text", role: visibleTx.stream.kind, text: visibleTx.stream.text })
    : false;
  const promptFocused = !transcriptFocused && !settingsOpen && !helpOpen && !historyOpen
    && !statsOpen && !agentSelectorOpen && !triggersOpen && !loginOpen && !providersOpen
    && !visibleQuestionnaire && !spawnPreview && !newsOpen && !todoVisible;

  // One element for the whole transcript, rebuilt only when what it shows
  // changes. React walks a child list of this size on every render of the app,
  // and an answer arriving mid-turn re-renders the app many times a second, so
  // handing back the identical element lets React skip the list entirely.
  // Every value a row reads is a dependency below. Add the dependency when a
  // row starts reading something new, or the rows go stale.
  // The stream is reduced to a flag on purpose: only the caret on the last row
  // depends on it, so a delta must not rebuild the settled rows.
  const streaming = visibleTx.stream !== null;
  const transcriptRows = useMemo(
    () => <>{visibleLines.slice(transcriptWindowStart).map((line, offset) => {
      // The absolute index, not the offset in the window: the row ids, the
      // transcript cursor, and the gap rule are all in terms of the whole
      // transcript, and they must not change when older rows mount.
      const i = transcriptWindowStart + offset;
      const projectedKey = projectedLineKey(line, i);
      return (
        <TranscriptRow
          key={projectedKey}
          theme={theme}
          syntaxStyle={syntaxStyle}
          line={line}
          index={i}
          selected={transcriptFocused && transcriptCursor === i}
          expanded={detailOverrides.get(projectedKey) ?? outputMode === "verbose"}
          outputMode={outputMode}
          workingCaret={visibleBusy && !streaming && i === visibleLines.length - 1}
          gapBefore={needsTranscriptGap(visibleLines[i - 1], line)}
          news={
            line.kind === "text" && line.role === "assistant" && line.newsId
              ? (newsReadById.get(line.newsId) ? "seen" : "unseen")
              : undefined
          }
          onDisclosure={onTranscriptDisclosure}
        />
      );
    })}</>,
    [
      visibleLines,
      transcriptWindowStart,
      theme,
      syntaxStyle,
      outputMode,
      detailOverrides,
      transcriptFocused,
      transcriptCursor,
      visibleBusy,
      streaming,
      newsReadById,
      onTranscriptDisclosure,
    ],
  );

  return (
    <AnimationProvider
      enabled={animations}
      working={visibleBusy}
      workingRuleWidth={width}
    >
      <box style={{ flexDirection: "column", height: "100%", backgroundColor: theme.bg }}>
        <WorkingRule
          theme={theme}
          width={Math.max(0, width)}
          busy={visibleBusy}
          mode={settings.workingRuleAnimation}
          role="headerTop"
        />
        <StatusBar
          theme={theme}
          modelId={visibleModelId}
          thinkingLevel={visibleThinkingLevel}
          cwd={cwd}
          branch={visibleBranch}
          outgoingTokens={visibleUsage.outgoing}
          incomingTokens={visibleUsage.incoming}
          cacheReadTokens={visibleUsage.cacheRead}
          cost={visibleUsage.cost}
          contextPct={visibleUsage.contextPct}
          busy={visibleBusy}
          elapsedSec={visibleElapsedSec}
          agentCount={agents.length}
          runningAgentCount={activeSubagentCount}
          maxActiveAgentCount={settings.maxActiveSubagents}
          runningShellCount={runningShellCount}
          activeAgentName={activeAgent?.name}
        />
        <WorkingRule
          theme={theme}
          width={Math.max(0, width)}
          busy={visibleBusy}
          mode={settings.workingRuleAnimation}
          role="headerBottom"
        />
        <scrollbox
          key={activeAgentId ?? "main"}
          ref={transcriptScrollRef}
          id="transcript-scrollbox"
          style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
          stickyScroll
          stickyStart="bottom"
          onMouseDragEnd={onTranscriptReaderDrag}
          onMouseDrop={onTranscriptReaderDrag}
          verticalScrollbarOptions={{ visible: true }}
        >
          <RenderErrorBoundary theme={theme} label="transcript" resetKey={transcriptResetKey}>
            {transcriptRows}
            {visibleTx.stream ? (
              <>
                {/* Same gap while the answer is still arriving, so it does not
                    jump down a row when the message settles. */}
                {streamGap ? <Gap /> : null}
                <StreamLine
                  theme={theme}
                  syntaxStyle={syntaxStyle}
                  role={visibleTx.stream.kind}
                  text={visibleTx.stream.text}
                />
              </>
            ) : null}
            {visiblePending.some((pending) => !pending.delivered) ? (
              <>
                {(visibleLines.length > 0 || visibleTx.stream) ? <Gap /> : null}
                {visiblePending.filter((pending) => !pending.delivered).map((pending) => (
                  <PendingMessageLine
                    key={pending.id}
                    theme={theme}
                    syntaxStyle={syntaxStyle}
                    pending={pending}
                  />
                ))}
              </>
            ) : null}
          </RenderErrorBoundary>
        </scrollbox>
        {ruleLabels.length > 0 ? <Gap /> : null}
        <WorkingRule
          theme={theme}
          width={Math.max(0, width)}
          busy={visibleBusy}
          dimmed={stashOpen}
          mode={settings.workingRuleAnimation}
          role="inputTop"
          label={ruleLabels}
          trailingRuleColumns={ruleLabels.length > 0 ? RULE_LABEL_TRAILING_RULE_COLUMNS : 0}
          color={shellMode ? theme.accent : undefined}
        />
        {stashOpen ? (
          <PromptStash
            theme={theme}
            prompts={stash}
            cursor={stashCursor}
            selectedIndices={stashSelection}
            height={height}
          />
        ) : null}
        {suggestionCount > 0 ? (
          <box
            style={{
              height: Math.min(suggestionCount, SUGGESTION_ROWS),
              flexShrink: 0,
              flexDirection: "column",
            }}
          >
            {(commandSuggestions.length > 0
              ? commandSuggestions.map((command) => ({
                key: command.name,
                text: `${command.name}  —  ${command.description}`,
              }))
              : (providersSuggestions.length > 0
                ? providersSuggestions
                : settingsSuggestions.length > 0
                ? settingsSuggestions
                : pathSuggestions)
                .map((completion) => ({
                  key: `${completion.start}:${completion.end}:${completion.replacement}`,
                  text: "description" in completion && completion.description
                    ? `${completion.replacement}  —  ${completion.description}`
                    : completion.replacement,
                })))
              .slice(suggestionStart, suggestionStart + SUGGESTION_ROWS)
              .map((suggestion, index) => {
                const highlighted = suggestionStart + index === suggestionIndex;
                return (
                  <box key={suggestion.key} style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
                    <box style={{ width: 2, flexShrink: 0 }}>
                      {highlighted ? <text content="❯ " fg={theme.accent} /> : null}
                    </box>
                    <text
                      content={suggestion.text}
                      fg={highlighted ? theme.fg : theme.dim}
                      wrapMode="none"
                      style={{ flexGrow: 1, minWidth: 0 }}
                    />
                  </box>
                );
              })}
          </box>
        ) : null}
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            height: inputRows,
            flexShrink: 0,
          }}
        >
          <box
            style={{
              flexDirection: "column",
              width: 2,
              height: inputRows,
              flexShrink: 0,
            }}
          >
            {Array.from({ length: inputRows }, (_, row) => (
              <box key={row} style={{ width: 2, height: 1, flexShrink: 0 }}>
                {suggestionCount === 0 && row === inputCursorRow
                  ? <text content={shellMode ? "! " : inputMode ? "i " : "❯ "} fg={theme.accent} />
                  : null}
              </box>
            ))}
          </box>
          <PlaceholderWave
            inputRef={inputRef}
            text={placeholderText}
            crestEnd={placeholderCrestEnd(placeholderText)}
            color={theme.dim}
            highlight={theme.fg}
            active={visibleBusy}
          />
          <textarea
            ref={inputRef}
            placeholder={placeholderText}
            placeholderColor={theme.dim}
            textColor={theme.fg}
            cursorColor={theme.accent}
            selectionBg={theme.selectionBg}
            wrapMode="word"
            keyBindings={PROMPT_TEXTAREA_KEY_BINDINGS}
            scrollMargin={1}
            scrollSpeed={PROMPT_SCROLL_SPEED}
            focused={promptFocused}
            onContentChange={handleTextareaChange}
            onCursorChange={scheduleInputMetrics}
            onSubmit={() => shellModeRef.current ? submitShellCommand() : submitPrompt()}
            style={{ width: promptInputColumns, flexShrink: 0, minWidth: 0, height: inputRows }}
          />
          {/* Reserve six columns on normal terminals. This forces wrapping
              before cursor movement can briefly overdraw the terminal edge. */}
          <box style={{ width: promptRightColumns, height: inputRows, flexShrink: 0 }} />
          {visibleInputHint ? <text content={visibleInputHint} fg={theme.warn} /> : null}
        </box>
        <WorkingRule
          theme={theme}
          width={Math.max(0, width)}
          busy={visibleBusy}
          dimmed={stashOpen}
          mode={settings.workingRuleAnimation}
          role="inputBottom"
          color={shellMode ? theme.accent : undefined}
        />
        <RenderErrorBoundary theme={theme} label="popup" resetKey={popupResetKey}>
          {loginOpen ? (
            <LoginPopup
              theme={theme}
              page={loginPage}
              terminalWidth={width}
              terminalHeight={height}
              onProviderSearchChange={(value) => loginControllerRef.current?.setProviderQuery(value)}
            />
          ) : null}
          {providersOpen ? (
            <ProvidersPopup
              theme={theme}
              page={providersPage}
              terminalWidth={width}
              terminalHeight={height}
              onSearchChange={(value) => providersControllerRef.current?.setQuery(value)}
            />
          ) : null}
          {spawnPreview ? (
            <SpawnPreviewPopup
              theme={theme}
              syntaxStyle={syntaxStyle}
              request={spawnPreview}
              terminalWidth={width}
              terminalHeight={height}
              inputRef={spawnPreviewInputRef}
            />
          ) : null}
          {visibleQuestionnaire ? (
            <QuestionnairePopup
              theme={theme}
              request={visibleQuestionnaire}
              terminalWidth={width}
              terminalHeight={height}
              inputRef={questionnaireInputRef}
            />
          ) : null}
          {helpOpen ? (
            <HelpPopup
              theme={theme}
              terminalWidth={width}
              terminalHeight={height}
              scrollOffset={helpScrollOffset}
            />
          ) : null}
          {triggersOpen ? (
            <ProcessesPopup
              theme={theme}
              tab={processTab}
              triggers={triggers}
              shells={shells}
              triggerCursor={triggerCursor}
              shellCursor={shellCursor}
              shellTail={shells[shellCursor] ? shellTails[shells[shellCursor]!.id] : undefined}
              terminalWidth={width}
              terminalHeight={height}
            />
          ) : null}
          {agentSelectorOpen ? (
            <AgentSelectorPopup
              theme={theme}
              rows={agentTreeRows}
              cursor={agentSelectorCursor}
            />
          ) : null}
          {historyOpen ? (
            <SessionHistoryPopup
              theme={theme}
              sessions={historySessions}
              currentPath={session.sessionFile}
              terminalWidth={width}
              terminalHeight={height}
              onSelect={selectHistorySession}
            />
          ) : null}
          {newsOpen ? (
            <NewsPopup
              theme={theme}
              items={news}
              cursor={newsCursor}
              terminalWidth={width}
              terminalHeight={height}
            />
          ) : null}
          {todoVisible ? (
            <TodoPopup
              theme={theme}
              terminalWidth={width}
              terminalHeight={height}
              agentName={activeAgent?.name ?? "main"}
              tasks={todoTasks}
              filter={todoFilter}
              selectedId={todoSelectedId}
            />
          ) : null}
          {statsOpen ? (
            <StatsPopup
              theme={theme}
              snapshot={statsSnapshot}
              terminalWidth={width}
              terminalHeight={height}
              scrollOffset={statsScrollOffset}
            />
          ) : null}
          {settingsOpen ? (
            <SettingsPopup
              theme={theme}
              page={page}
              rows={visibleSettingRows}
              selectedId={selectedSettingId}
              values={rowValues}
              query={settingsQuery}
              searchFocused={settingsSearchFocused}
              terminalWidth={width}
              terminalHeight={height}
              models={visibleModels}
              modelQuery={modelQuery}
              modelSearchFocused={modelSearchFocused}
              onSearchChange={updateSettingsQuery}
              onModelSearchChange={setModelQuery}
              onSelectModel={selectModel}
              onSelectCheckModel={selectCheckModel}
            />
          ) : null}
        </RenderErrorBoundary>
      </box>
    </AnimationProvider>
  );
}

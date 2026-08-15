import {
  decodePasteBytes,
  stripAnsiSequences,
  type PasteEvent,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { randomUUID } from "node:crypto";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimationProvider, supportsTrueColor, useWorkingRule, type WorkingRuleRole } from "./animation";
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
  SANDBOX_MODES,
  saveSettings,
  WORKING_RULE_ANIMATION_MODES,
  type PumSettings,
  type WorkingRuleAnimationMode,
} from "./settings";
import { StatusBar } from "./status-bar";
import {
  AgentMessageLine,
  needsTranscriptGap,
  PendingMessageLine,
  resolvePendingDelivery,
  settleTranscriptMessage,
  StreamLine,
  TextLine,
  ToolLine,
  transcriptForThinkingVisibility,
  type Line,
  type PendingLine,
  type Role,
} from "./transcript";
import { bashOutput, bashResultDisplay, editCounts, toolArg, type ToolCall } from "./tool-line";
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
import { matchingCommands, moveCommandSelection } from "./commands";
import { applyPathCompletion, pathCompletions, type PathCompletion } from "./path-autocomplete";
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
import {
  captureClipboardImage,
  cleanupPendingImages,
  imageContent,
  removePendingImage,
  type PendingImage,
} from "./image-paste";
import {
  cleanupPendingPastedTexts,
  MAX_PASTED_TEXT_BYTES,
  pastedTextReadBlock,
  removePendingPastedText,
  stagePastedText as stagePastedTextDefault,
  type PendingPastedText,
} from "./pasted-text";
import { countActiveSubagents, type SubagentManager } from "./subagents/manager";
import type { SpawnPreviewManager } from "./subagents/spawn-preview";
import { SpawnPreviewPopup } from "./subagents/spawn-preview-popup";
import { recallNewestQueuedUserMessage } from "./queue-recall";
import { runWorktreeCommand } from "./worktree-command";
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
import { providerLoginMethods, refreshAndSelectModel } from "./login-flow";
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
import { statsFromEntries, type SessionStatsManager } from "./session-stats";
import { maxStatsScrollOffset, StatsPopup } from "./stats-popup";
import {
  projectTranscriptLines,
  transcriptOutputMode,
} from "./transcript-output";

type Stream = { kind: "assistant" | "thinking"; text: string } | null;
type Transcript = { lines: Line[]; stream: Stream; pending: PendingLine[] };

const QUIT_WINDOW_MS = 2000;
const MAX_INPUT_ROWS = 8;
/** Keys that move around without changing the text. */
const NAV_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

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

export function promptPlaceholder(options: {
  activeAgentName?: string;
  busy: boolean;
  stashOpen: boolean;
}): string {
  if (options.activeAgentName) {
    return options.busy ? `Steer ${options.activeAgentName}…` : `Message ${options.activeAgentName}…`;
  }
  if (options.stashOpen) return "Cache…";
  return options.busy ? "Steer…" : "Ask something…";
}

/** A blank row. An empty <text> measures to nothing, so this needs a height. */
const Gap = () => <box style={{ height: 1, flexShrink: 0 }} />;

function WorkingRule({
  theme,
  width,
  busy,
  dimmed = false,
  mode,
  role,
}: {
  theme: Theme;
  width: number;
  busy: boolean;
  dimmed?: boolean;
  mode: WorkingRuleAnimationMode;
  role: WorkingRuleRole;
}) {
  const ref = useWorkingRule({
    width,
    color: dimmed ? theme.dim : theme.border,
    highlight: theme.highlight,
    active: busy,
    mode,
    role,
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
  if (t.stream && t.stream.text.trim()) {
    const line: Line = { kind: "text", role: t.stream.kind, text: t.stream.text.trim() };
    return { lines: [...t.lines, line], stream: null, pending: t.pending };
  }
  return { ...t, stream: null };
}

export function App({
  session: initialSession,
  modelRuntime,
  onNewSession,
  loadSessions,
  onSwitchSession,
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
  onExit = () => process.exit(0),
  triggerManager,
  shellManager,
  messageCacheController,
  terminalTitle,
  startupWarnings = [],
  onSandboxModeChange,
  sandboxWarningSource,
  forcedSandboxMode,
  forcedCheckPaths = [],
}: {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  onNewSession: () => Promise<AgentSession | null>;
  loadSessions: () => Promise<SessionHistoryItem[]>;
  onSwitchSession: (path: string) => Promise<AgentSession | null>;
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
  /** Store oversized pasted text in a temp file and show a marker in its place. */
  stagePastedText?: typeof stagePastedTextDefault;
  /** Copies the selected news answer for the popup. */
  copyNewsAnswerText?: typeof copyTextToClipboard;
  onExit?: () => void | Promise<void>;
  triggerManager?: TriggerManagerLike;
  shellManager?: ShellManagerLike;
  messageCacheController?: MessageCacheController;
  terminalTitle?: TerminalTitleController;
  /** Visible process-local warnings. These lines never enter pi session context. */
  startupWarnings?: readonly string[];
  onSandboxModeChange?: (mode: NonNullable<PumSettings["sandboxMode"]>) => void;
  sandboxWarningSource?: { subscribeWarnings(listener: (warning: string) => void): () => void };
  /** Process-local sandbox floor that does not overwrite persisted user settings. */
  forcedSandboxMode?: NonNullable<PumSettings["sandboxMode"]>;
  forcedCheckPaths?: readonly string[];
}) {
  const cwd = process.cwd();
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
    const replayedLines = replayEntries(
      initialSession.sessionManager.buildContextEntries(),
      cwd,
      initial.showThinking,
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
  const [settings, setSettings] = useState(initial);
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
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandSuggestionsDismissed, setCommandSuggestionsDismissed] = useState(false);
  const [editingStashIndexState, setEditingStashIndexState] = useState<number | null>(null);
  const [inputRows, setInputRows] = useState(1);
  const [inputCursorRow, setInputCursorRow] = useState(0);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentSelectorOpen, setAgentSelectorOpen] = useState(false);
  const [agentSelectorCursor, setAgentSelectorCursor] = useState(0);
  const [agentElapsedSec, setAgentElapsedSec] = useState(0);
  const [loginOpen, setLoginOpen] = useState(loginRequired);
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
  const [, setTriggerRevision] = useState(0);
  const [shellRevision, setShellRevision] = useState(0);
  const [shellTails, setShellTails] = useState<Record<string, string>>({});

  const [newsOpen, setNewsOpen] = useState(false);
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
  const agents = subagentManager.getAgents();
  const activeSubagentCount = countActiveSubagents(agents);
  const activeAgent = activeAgentId
    ? agents.find((agent) => agent.id === activeAgentId)
    : undefined;
  const questionnaire = questionnaireManager?.current();
  const spawnPreview = spawnPreviewManager?.current();
  const visibleTx = transcriptForThinkingVisibility(
    activeAgent?.transcript ?? tx,
    settings.showThinking,
  );
  const outputMode = transcriptOutputMode(settings);
  const visibleLines = useMemo(
    () => projectTranscriptLines(visibleTx.lines, outputMode),
    [visibleTx.lines, outputMode],
  );
  const visibleBusy = activeAgent
    ? activeAgent.status === "starting" || activeAgent.status === "running"
    : busy;
  const visibleModelId = activeAgent?.modelId.split("/").slice(1).join("/") || modelId;
  const visibleThinkingLevel = activeAgent?.thinkingLevel ?? thinkingLevel;
  const visibleBranch = activeAgent?.worktree.branch ?? branch;
  const visibleElapsedSec = activeAgent ? agentElapsedSec : elapsedSec;
  const visibleUsage = activeAgent?.usage ?? usage;
  const agentTreeRows = buildAgentTree(agents);
  const triggers = sortTriggers(triggerManager?.getTriggers() ?? []);
  const shells = sortShells(shellManager?.list() ?? []);
  const runningShellCount = shells.filter(
    (shell) => shell.state === "starting" || shell.state === "running",
  ).length;
  const statsSnapshot = useMemo(() => statsManager?.snapshot() ?? statsFromEntries(
    (session.sessionManager as any).getEntries?.() ?? session.sessionManager.buildContextEntries(),
    `${session.agent.state.model.provider}/${session.agent.state.model.id}`,
  ), [statsManager, session, statsRevision]);
  const inputHint = cancelArmed
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
  const commandSuggestions = stashOpen || commandSuggestionsDismissed
    ? []
    : matchingCommands(commandInput).slice(0, 5);
  const visibleSettingRows = filterSettingsRows(settingsQuery);
  const visibleModels = useMemo(() => filterModels(
    modelRuntime.getAvailableSnapshot(),
    modelQuery,
    (providerId) => (modelRuntime as any).getProvider?.(providerId)?.name ?? "",
  ), [modelRuntime, modelId, modelQuery, loginPage]);

  const inputRef = useRef<TextareaRenderable>(null);
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
  // The event subscription is set up once, so it reads the toggle via a ref.
  const showThinkingRef = useRef(initial.showThinking);
  const startupWarningsRef = useRef([...startupWarnings]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loginControllerRef = useRef<LoginController | null>(null);

  if (!loginControllerRef.current) {
    loginControllerRef.current = new LoginController(modelRuntime, () => sessionRef.current, setLoginPage, (id) => id && setModelId(id), () => setLoginOpen(false));
  }

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
    if (!input) return;
    const rows = Math.min(
      MAX_INPUT_ROWS,
      Math.max(1, input.editorView.getTotalVirtualLineCount()),
    );
    const cursorRow = input.cursorOffset >= input.plainText.length
      ? rows - 1
      : Math.max(0, Math.min(rows - 1, input.visualCursor.visualRow));
    setInputRows(rows);
    setInputCursorRow(cursorRow);
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

  const handleInput = (nextValue: string) => {
    const previous = lastInputValue.current;
    let value = nextValue;
    let cleanupCursor: number | null = null;
    const kept: PendingImage[] = [];

    for (const image of pendingImages.current) {
      const exactStart = value.indexOf(image.marker);
      if (exactStart >= 0) {
        kept.push({ ...image, start: exactStart, end: exactStart + image.marker.length });
        continue;
      }

      // The marker changed. Remove its remaining fragment from the new value
      // and delete the corresponding temporary image immediately.
      let prefix = 0;
      while (
        prefix < previous.length &&
        prefix < nextValue.length &&
        previous[prefix] === nextValue[prefix]
      ) prefix++;
      const delta = nextValue.length - previous.length;
      const start = Math.max(0, Math.min(value.length, Math.min(image.start, prefix)));
      const end = Math.max(start, Math.min(value.length, image.end + delta));
      value = value.slice(0, start) + value.slice(end);
      cleanupCursor = cleanupCursor === null ? start : Math.min(cleanupCursor, start);
      removePendingImage(image);
    }

    // Recalculate marker positions after any atomic marker removal.
    pendingImages.current = kept.flatMap((image) => {
      const start = value.indexOf(image.marker);
      if (start < 0) {
        removePendingImage(image);
        return [];
      }
      return [{ ...image, start, end: start + image.marker.length }];
    });

    // Pasted-text markers follow the same atomic lifecycle as image markers:
    // editing or removing the marker deletes the temp file immediately.
    const keptPasted: PendingPastedText[] = [];
    for (const pasted of pendingPastedTexts.current) {
      const exactStart = value.indexOf(pasted.marker);
      if (exactStart >= 0) {
        keptPasted.push({ ...pasted, start: exactStart, end: exactStart + pasted.marker.length });
        continue;
      }
      let prefix = 0;
      while (
        prefix < previous.length &&
        prefix < nextValue.length &&
        previous[prefix] === nextValue[prefix]
      ) prefix++;
      const delta = nextValue.length - previous.length;
      const start = Math.max(0, Math.min(value.length, Math.min(pasted.start, prefix)));
      const fragmentEnd = Math.max(start, Math.min(value.length, pasted.end + delta));
      value = value.slice(0, start) + value.slice(fragmentEnd);
      cleanupCursor = cleanupCursor === null ? start : Math.min(cleanupCursor, start);
      removePendingPastedText(pasted);
    }
    pendingPastedTexts.current = keptPasted.flatMap((pasted) => {
      const start = value.indexOf(pasted.marker);
      if (start < 0) {
        removePendingPastedText(pasted);
        return [];
      }
      return [{ ...pasted, start, end: start + pasted.marker.length }];
    });

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

  const pasteClipboardImage = async () => {
    if (imagePasteBusy.current) return;
    if (!session.agent.state.model.input.includes("image")) {
      append({ kind: "text", role: "error", text: "the current model does not support image input" });
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
   * Replace one oversized paste with a `[Pasted text #n]` marker. The text is
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
      statsOpenRef.current ||
      settingsOpenRef.current
    ) return;
    const input = inputRef.current;
    if (!input?.focused) return;
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (Buffer.byteLength(text, "utf8") <= MAX_PASTED_TEXT_BYTES) return;

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
      if (event.type === "main-line") append(event.line);
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
    terminalTitle?.update({
      working: busy || activeSubagentCount > 0,
      activeSubagentCount,
    });
  }, [terminalTitle, busy, activeSubagentCount]);

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
    setTx((t) => {
      if (t.stream?.kind === kind) return { ...t, stream: { kind, text: t.stream.text + text } };
      return { ...flushed(t), stream: { kind, text } };
    });

  const patchTool = (id: string, patch: Partial<ToolCall>) =>
    setTx((t) => ({
      ...t,
      lines: t.lines.map((l) =>
        l.kind === "tool" && l.call.id === id ? { kind: "tool", call: { ...l.call, ...patch } } : l,
      ),
    }));

  useEffect(() => {
    void subagentManager
      .bindMainSession(session.sessionManager, cwd)
      .catch((error) => append({ kind: "text", role: "error", text: String(error) }));
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
    setModelId(session.agent.state.model.id);
    const visibleStartupWarnings = startupWarningsRef.current;
    startupWarningsRef.current = [];
    const replayedLines = [
      ...replayEntries(session.sessionManager.buildContextEntries(), cwd, showThinkingRef.current),
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
          else if (update.type === "thinking_delta" && showThinkingRef.current)
            delta("thinking", update.delta);
          break;
        }
        case "tool_execution_start":
          append({
            kind: "tool",
            call: {
              id: event.toolCallId,
              name: event.toolName,
              arg: toolArg(event.toolName, event.args, cwd),
              state: "running",
              startedAt: Date.now(),
              input: event.args,
              preview: toolPreviewFromStart(event.toolName, event.args),
            },
          });
          break;
        case "tool_execution_update":
          if (event.toolName === "bash") {
            patchTool(event.toolCallId, { output: bashOutput(event.partialResult) });
          }
          break;
        case "tool_execution_end": {
          const bashResult = event.toolName === "bash" ? bashResultDisplay(event.result) : {};
          const preview = toolPreviewFromResult(event.toolName, event.result);
          patchTool(event.toolCallId, {
            state: isRejectedToolResult(event.result, event.toolCallId)
              ? "rejected"
              : event.isError
                ? "error"
                : "ok",
            detail: isRejectedToolResult(event.result, event.toolCallId)
              ? rejectedToolReason(event.result, event.toolCallId)
              : event.toolName === "edit" || event.toolName === "apply_patch"
                ? editCounts(event.result)
                : event.toolName === "questionnaire"
                  ? questionnaireDetail(event.result)
                  : event.toolName.startsWith("message_cache_")
                    ? messageCacheDetail(event.result)
                    : undefined,
            exitCode: bashResult.exitCode,
            result: event.result,
            isError: event.isError,
            ...(preview ? { preview } : {}),
          });
          break;
        }
        case "agent_start":
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
          setWorking(false);
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
  }, [agents.map((agent) => `${agent.id}:${agent.status}`).join("|")]);

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

  // Hosted web searches are not pi tool calls, so they arrive out of band.
  useEffect(() => {
    return observeSearchCalls(session.sessionId, (call) => {
      if (call.phase === "start") {
        append({
          kind: "tool",
          call: { id: call.id, name: "web_search", arg: call.query, state: "running" },
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
    const cwd = process.cwd();
    setBranch(readBranch(cwd));
    return watchBranch(cwd, () => setBranch(readBranch(cwd)));
  }, []);

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
        additionalPaths: [...new Set([
          ...checkPathsForProject(next, cwd),
          ...forcedCheckPaths,
        ])],
      });
    }
    if (patch.showThinking !== undefined) showThinkingRef.current = patch.showThinking;
    if (patch.maxActiveSubagents !== undefined) {
      subagentManager.setMaxActiveSubagents(patch.maxActiveSubagents);
    }
    saveSettings(next);
  };

  const stepThinking = (step: number) => {
    const levels = getSupportedThinkingLevels(session.agent.state.model);
    const i = levels.indexOf(thinkingLevel);
    const target = levels[Math.max(0, Math.min(levels.length - 1, i + step))]!;
    session.setThinkingLevel(target);
    // setThinkingLevel clamps to what the model supports — show the real value.
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
  };

  const stepTheme = (step: number) => {
    const i = PRESET_NAMES.indexOf(settings.theme);
    const next = PRESET_NAMES[(i + step + PRESET_NAMES.length) % PRESET_NAMES.length]!;
    update({ theme: next });
  };

  const stepWritingStyle = (step: number) => {
    const i = WRITING_STYLES.indexOf(settings.writingStyle);
    const next = WRITING_STYLES[(i + step + WRITING_STYLES.length) % WRITING_STYLES.length]!;
    update({ writingStyle: next });
  };

  const stepExplanationStrength = (step: number) => {
    const i = EXPLANATION_STRENGTHS.indexOf(settings.explanationStrength);
    const next = EXPLANATION_STRENGTHS[
      (i + step + EXPLANATION_STRENGTHS.length) % EXPLANATION_STRENGTHS.length
    ]!;
    update({ explanationStrength: next });
  };

  const stepWorkingRuleAnimation = (step: number) => {
    const i = WORKING_RULE_ANIMATION_MODES.indexOf(settings.workingRuleAnimation);
    const next = WORKING_RULE_ANIMATION_MODES[
      (i + step + WORKING_RULE_ANIMATION_MODES.length) % WORKING_RULE_ANIMATION_MODES.length
    ]!;
    update({ workingRuleAnimation: next });
  };

  const stepOutputMode = (step: number) => {
    update({ outputMode: cycleOutputMode(settings.outputMode, step) });
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

  const finishLogin = async (providerId: string, providerName: string) => {
    const selected = await refreshAndSelectModel(
      modelRuntime,
      providerId,
      (model) => session.setModel(model),
      AbortSignal.timeout(15_000),
    );
    if (selected) {
      setModelId(selected.id);
      setLoginPage({ kind: "success", message: `${providerName} is ready. Selected ${selected.id}.` });
    } else {
      setLoginPage({ kind: "success", message: `${providerName} is configured. Open Settings to select an available model.` });
    }
  };

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
    loadSessions()
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
    if (targetIndex < 0) return;

    if (activeAgentIdRef.current !== requesterAgentId && !selectAgentView(requesterAgentId)) return;
    newsOpenRef.current = false;
    setNewsOpen(false);
    const scrollToTarget = () => {
      const transcript = transcriptScrollRef.current;
      if (!transcript) return;
      transcript.scrollTop = 0;
      transcript.scrollChildIntoView(`transcript-line-${targetIndex}`);
    };
    queueMicrotask(scrollToTarget);
    setTimeout(scrollToTarget, 30);
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
      .finally(() => setWorking(false));
  };

  const cancel = () => {
    resetCancelArm();
    append({ kind: "text", role: "system", text: "cancelled" });
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

  const runCommand = (text: string): boolean => {
    const trimmed = text.trim();
    const compress = /^\/compress(?:\s+(.*))?$/s.exec(trimmed);
    const clear = /^\/(?:clear|new)$/.test(trimmed);
    const historyCommand = trimmed === "/history";
    const loginCommand = trimmed === "/login";
    const checkPathCommand = /^\/check-path(?:\s|$)/.test(trimmed);
    const triggersCommand = trimmed === "/triggers";
    const processesCommand = trimmed === "/processes";
    const newsCommand = trimmed === "/news";
    const statsCommand = trimmed === "/stats";
    const worktreeCommand = /^\/worktree(?:\s+([a-zA-Z0-9_-]+))?$/.exec(trimmed);
    if (!compress && !clear && !historyCommand && !loginCommand && !checkPathCommand && !triggersCommand && !processesCommand && !newsCommand && !statsCommand && !worktreeCommand) return false;
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
    if (statsCommand) {
      setEditorText("");
      openStats();
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
        .finally(() => setWorking(false));
    } else if (worktreeCommand) {
      runWorktreeCommand({
        name: worktreeCommand[1],
        manager: subagentManager,
        append: (call) => append({ kind: "tool", call }),
        patch: patchTool,
        settled: () => setWorking(false),
      });
    } else if (clear) {
      onNewSession()
        .then((next) => {
          if (next) setSession(next);
        })
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(false));
    } else {
      session
        .compact(compress![1]?.trim() || undefined)
        .then((result) => append({
          kind: "text",
          role: "system",
          text: `compressed context (${result.tokensBefore.toLocaleString()} tokens before)`,
        }))
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(false));
    }
    return true;
  };

  const deliverMainPrompt = async (
    promptText: string,
    displayText: string,
    images: ReturnType<typeof imageContent>[] = [],
    recallable = images.length === 0,
  ): Promise<void> => {
    // A direct user prompt starts a user-initiated main turn, so its settled
    // answer becomes a news item. A reply also marks the newest answer seen.
    userTurnActiveRef.current = true;
    markNewestNewsAnswered();
    const userLine: Extract<Line, { kind: "text" }> = {
      kind: "text",
      role: "user",
      text: displayText,
    };

    turnPromptsRef.current.push({ text: displayText, steer: busyRef.current });
    // Working already: keep the steering message pending at the transcript
    // bottom until pi emits message_start for its actual insertion.
    if (busyRef.current) {
      const pending: PendingLine = {
        id: randomUUID().slice(0, 12),
        line: userLine,
        deliveryText: promptText,
        recallable,
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
    inFlight.current = promptText;
    setWorking(true);
    try {
      await withSearchRoute(session.sessionId, () => session.prompt(promptText, { images }));
    } catch (error) {
      append({ kind: "text", role: "error", text: String(error) });
      setWorking(false);
      throw error;
    }
  };

  const submitPrompt = (value?: string, stashIndex?: number) => {
    // Read the selected agent from the ref, not the state. A view switch updates
    // the ref synchronously, but a switch-then-send in one input chunk runs
    // before React commits the new state, so the state would still name the
    // previous agent and deliver the prompt to the wrong session.
    const selectedAgentId = activeAgentIdRef.current;
    const targetKey = selectedAgentId ?? "main";
    const rawDisplayText = value ?? inputRef.current?.plainText ?? "";
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

    if (attachments.length === 0 && promptText === "/login") {
      openLogin();
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

    if (attachments.length === 0 && runCommand(promptText)) return;

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
    void deliverMainPrompt(promptText, displayText, images)
      .then(finishAttachments)
      .catch(restoreFailedDraft);
  };

  const cachedBatchDisplay = (prompts: readonly string[]): string => [
    `Run ${prompts.length} cached tasks with worktree subagents:`,
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

  const runSelectedStashBatch = () => {
    const indices = [...stashSelectionRef.current].sort((a, b) => a - b);
    const prompts = indices.flatMap((index) => {
      const prompt = stashRef.current[index];
      return prompt ? [prompt.text] : [];
    });
    if (prompts.length === 0) return;

    for (const prompt of prompts) history.current = promptHistoryStore.append(cwd, prompt);
    const next = promptStashStore.markExecutedMany(cwd, indices);
    stashRef.current = next;
    setStash(next);
    refreshHistoryAfterStashMutation();
    resetAfterCacheExecution();
    void deliverMainPrompt(buildStashBatchPrompt(prompts), cachedBatchDisplay(prompts), [], false).catch(() => {});
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
    const index = CHECK_MODE_PROFILES.indexOf(settings.checkMode);
    update({ checkMode: CHECK_MODE_PROFILES[(index + step + CHECK_MODE_PROFILES.length) % CHECK_MODE_PROFILES.length]! });
  };

  const stepSandboxMode = (step: number) => {
    const current = settings.sandboxMode ?? "auto";
    const index = SANDBOX_MODES.indexOf(current);
    update({ sandboxMode: SANDBOX_MODES[(index + step + SANDBOX_MODES.length) % SANDBOX_MODES.length]! });
  };

  const rowActions: Record<SettingRowId, { step?: (n: number) => void; enter?: () => void }> = {
    theme: { step: stepTheme },
    providers: { enter: openLogin },
    animations: { step: () => update({ animations: !settings.animations }) },
    workingRuleAnimation: { step: stepWorkingRuleAnimation },
    outputMode: { step: stepOutputMode },
    webSearch: { step: () => update({ webSearch: !settings.webSearch }) },
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
    showThinking: { step: () => update({ showThinking: !settings.showThinking }) },
    maxActiveSubagents: { step: (step) => update({
      maxActiveSubagents: Math.max(
        MIN_ACTIVE_SUBAGENTS,
        Math.min(MAX_ACTIVE_SUBAGENTS, settings.maxActiveSubagents + step),
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
    workingRuleAnimation: `‹ ${settings.workingRuleAnimation} ›${settings.workingRuleAnimation === "off" ? "" : animationUnavailable}`,
    outputMode: `‹ ${settings.outputMode ?? "default"} ›`,
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
    if (pendingImages.current.length > 0) {
      append({ kind: "text", role: "error", text: "send or remove attached images before switching agents" });
      return false;
    }
    if (pendingPastedTexts.current.length > 0) {
      append({ kind: "text", role: "error", text: "send or remove attached pasted text before switching agents" });
      return false;
    }
    const current = activeAgentIdRef.current;
    if (target === current) return true;
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
      if (target && !agents.some((agent) => agent.id === target)) {
        spawnPreviewManager?.cancel("unavailable");
      } else if (!selectAgentView(target)) {
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

    if (key.ctrl && key.name === "c" && questionnaire) {
      key.stopPropagation();
      if (questionnaire.customInput) {
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
        raw: "\u001b",
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
        !questionnaire &&
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

    if (questionnaire) {
      const isQuestionnaireReturn =
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "kpenter" ||
        key.name === "linefeed";
      if (questionnaire.customInput) {
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
          Math.min(maxHelpScrollOffset(height), offset + (key.name === "pagedown" ? 5 : 1)),
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

    if (key.ctrl && key.name === "end") {
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
    const commandMatches = stashOpenRef.current || commandSuggestionsDismissedRef.current
      ? []
      : matchingCommands(inputValue).slice(0, 5);
    const isContinuationReturn =
      isPlainReturn &&
      inputValue.endsWith("\\") &&
      (inputRef.current?.cursorOffset ?? 0) >= inputValue.length;
    const isWordBackspace =
      key.ctrl && (key.name === "backspace" || key.name === "w");

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
            setEditorText(prompt.text);
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
      if (!activeAgentId && commandMatches.length > 0 && !/\s/.test(inputValue)) {
        key.stopPropagation();
        const selected = commandMatches[Math.min(commandCursorRef.current, commandMatches.length - 1)]!;
        setEditorText(selected.name);
        return;
      }

      const inputCursor = inputRef.current?.cursorOffset ?? inputValue.length;
      const previousCycle = pathCompletionCycle.current;
      const continuing = previousCycle !== null
        && previousCycle.currentValue === inputValue
        && previousCycle.currentCursor === inputCursor;
      const completions = continuing
        ? previousCycle!.completions
        : pathCompletions(inputValue, inputCursor, cwd);
      if (completions.length > 0) {
        key.stopPropagation();
        const index = continuing
          ? (previousCycle!.index + 1) % completions.length
          : 0;
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

    if (isContinuationReturn) {
      key.stopPropagation();
      inputRef.current?.deleteCharBackward();
      inputRef.current?.newLine();
      handleTextareaChange();
      histCursor.current = null;
      if (stashOpenRef.current) setSelectedStash(-1);
      return;
    }

    if (isPlainReturn && commandMatches.length > 0 && !/\s/.test(inputValue)) {
      key.stopPropagation();
      const selected = commandMatches[Math.min(commandCursorRef.current, commandMatches.length - 1)]!;
      submitPrompt(selected.name);
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
        if (prompt) {
          submitPrompt(prompt.text, index);
          executeStashedPrompt(index);
        }
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
      if (commandMatches.length > 0) {
        key.stopPropagation();
        const next = moveCommandSelection(
          commandCursorRef.current,
          commandMatches.length,
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
      } else if (commandMatches.length > 0) {
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
          if (selected) void subagentManager.abortAgent(selected);
          else cancel();
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

  const lastProjectedLine = visibleLines[visibleLines.length - 1];
  const lastLine: Line | undefined = lastProjectedLine?.kind === "tool-summary"
    ? { kind: "text", role: "system", text: lastProjectedLine.text }
    : lastProjectedLine;
  const streamGap = visibleTx.stream
    ? needsTranscriptGap(lastLine, { kind: "text", role: visibleTx.stream.kind, text: visibleTx.stream.text })
    : false;

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
          verticalScrollbarOptions={{ visible: true }}
        >
          {visibleLines.map((line, i) => {
            const workingCaret = visibleBusy && !visibleTx.stream && i === visibleLines.length - 1;
            const row =
              line.kind === "tool-summary" ? (
                <TextLine
                  theme={theme}
                  syntaxStyle={syntaxStyle}
                  role="system"
                  text={line.text}
                />
              ) : line.kind === "tool" ? (
                <ToolLine
                  theme={theme}
                  syntaxStyle={syntaxStyle}
                  call={line.call}
                  workingCaret={workingCaret}
                  outputMode={outputMode}
                />
              ) : line.kind === "agent-message" ? (
                <AgentMessageLine theme={theme} syntaxStyle={syntaxStyle} line={line} />
              ) : (
                <TextLine
                  theme={theme}
                  syntaxStyle={syntaxStyle}
                  role={line.role as Role}
                  text={line.text}
                  workingCaret={workingCaret}
                  news={
                    line.kind === "text" && line.role === "assistant" && line.newsId
                      ? (newsReadById.get(line.newsId) ? "seen" : "unseen")
                      : undefined
                  }
                />
              );
            const currentGapLine: Line = line.kind === "tool-summary"
              ? { kind: "text", role: "system", text: line.text }
              : line;
            const previousProjected = visibleLines[i - 1];
            const previousGapLine: Line | undefined = previousProjected?.kind === "tool-summary"
              ? { kind: "text", role: "system", text: previousProjected.text }
              : previousProjected;
            const gapBefore = needsTranscriptGap(previousGapLine, currentGapLine);
            const lineKey =
              line.kind === "tool-summary"
                ? `tool-summary:${i}:${line.text}`
                : line.kind === "tool"
                ? `tool:${line.call.id}`
                : line.kind === "agent-message"
                  ? `agent:${line.sender}:${line.recipient}:${i}:${line.text}`
                  : `text:${line.role}:${i}:${line.text}`;
            return (
              <box
                id={`transcript-line-${i}`}
                key={lineKey}
                style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
              >
                {gapBefore ? <Gap /> : null}
                {row}
              </box>
            );
          })}
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
          {visibleTx.pending.some((pending) => !pending.delivered) ? (
            <>
              {(visibleLines.length > 0 || visibleTx.stream) ? <Gap /> : null}
              {visibleTx.pending.filter((pending) => !pending.delivered).map((pending) => (
                <PendingMessageLine
                  key={pending.id}
                  theme={theme}
                  syntaxStyle={syntaxStyle}
                  pending={pending}
                />
              ))}
            </>
          ) : null}
        </scrollbox>
        <WorkingRule
          theme={theme}
          width={Math.max(0, width)}
          busy={visibleBusy}
          dimmed={stashOpen}
          mode={settings.workingRuleAnimation}
          role="inputTop"
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
        {commandSuggestions.length > 0 ? (
          <box
            style={{
              height: commandSuggestions.length,
              flexShrink: 0,
              flexDirection: "column",
            }}
          >
            {commandSuggestions.map((command, index) => {
              const highlighted = index === Math.min(commandCursor, commandSuggestions.length - 1);
              return (
                <box key={command.name} style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
                  <box style={{ width: 2, flexShrink: 0 }}>
                    {highlighted ? <text content="❯ " fg={theme.accent} /> : null}
                  </box>
                  <text
                    content={`${command.name}  —  ${command.description}`}
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
                {commandSuggestions.length === 0 && row === inputCursorRow
                  ? <text content="❯ " fg={theme.accent} />
                  : null}
              </box>
            ))}
          </box>
          <textarea
            ref={inputRef}
            placeholder={promptPlaceholder({
              activeAgentName: activeAgent?.name,
              busy: visibleBusy,
              stashOpen,
            })}
            placeholderColor={theme.dim}
            textColor={theme.fg}
            cursorColor={theme.accent}
            selectionBg={theme.selectionBg}
            wrapMode="word"
            scrollMargin={1}
            focused={!settingsOpen && !helpOpen && !historyOpen && !statsOpen && !agentSelectorOpen && !triggersOpen && !loginOpen && !questionnaire && !spawnPreview && !newsOpen}
            onContentChange={handleTextareaChange}
            onCursorChange={scheduleInputMetrics}
            onSubmit={() => submitPrompt()}
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
        />
        {loginOpen ? (
          <LoginPopup
            theme={theme}
            page={loginPage}
            terminalWidth={width}
            terminalHeight={height}
            onProviderSearchChange={(value) => loginControllerRef.current?.setProviderQuery(value)}
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
        {questionnaire ? (
          <QuestionnairePopup
            theme={theme}
            request={questionnaire}
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
      </box>
    </AnimationProvider>
  );
}

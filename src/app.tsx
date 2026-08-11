import { decodePasteBytes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core";
import { randomUUID } from "node:crypto";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
  type Line,
  type PendingLine,
  type Role,
} from "./transcript";
import { editCounts, toolArg, type ToolCall } from "./tool-line";
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
  CheckApprovalPopup,
  invokeCheckApprovalDecision,
  type CheckApprovalDecision,
} from "./check-approval-popup";
import type {
  CheckApprovalCoordinator,
  CheckApprovalRequest,
  CheckApprovalStore,
} from "./check-approvals";
import {
  moveTriggerSelection,
  sortTriggers,
  triggerActionForKey,
  TriggersPopup,
  type TriggerAction,
  type TriggerManagerLike,
} from "./triggers/popup";
import type { TerminalTitleController } from "./terminal-title";
import { readClipboardText } from "./text-paste";
import { NewsPopup } from "./news-popup";
import {
  NEWS_CAPACITY,
  loadNewsItems,
  saveNewsItems,
  tagNewsLines,
  type NewsItem,
} from "./news";

type Stream = { kind: "assistant" | "thinking"; text: string } | null;
type Transcript = { lines: Line[]; stream: Stream; pending: PendingLine[] };

const QUIT_WINDOW_MS = 2000;
const MAX_INPUT_ROWS = 8;
/** Keys that move around without changing the text. */
const NAV_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

export function historyOpenBlockReason(options: {
  hasPendingImages: boolean;
  busy: boolean;
}): string | null {
  if (options.hasPendingImages) return "send or remove attached images before switching sessions";
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
  questionnaireManager,
  spawnPreviewManager,
  loginRequired = false,
  promptHistoryStore = DEFAULT_PROMPT_HISTORY_STORE,
  promptStashStore = DEFAULT_PROMPT_STASH_STORE,
  captureImage = captureClipboardImage,
  readPastedText = readClipboardText,
  onExit = () => process.exit(0),
  checkApprovalCoordinator,
  checkApprovalStore,
  triggerManager,
  messageCacheController,
  terminalTitle,
  startupWarnings = [],
  onSandboxModeChange,
  sandboxWarningSource,
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
  questionnaireManager?: QuestionnaireManager;
  spawnPreviewManager?: SpawnPreviewManager;
  loginRequired?: boolean;
  promptHistoryStore?: PromptHistoryStore;
  promptStashStore?: PromptStashStore;
  captureImage?: typeof captureClipboardImage;
  readPastedText?: typeof readClipboardText;
  onExit?: () => void | Promise<void>;
  checkApprovalCoordinator?: CheckApprovalCoordinator;
  checkApprovalStore?: CheckApprovalStore;
  triggerManager?: TriggerManagerLike;
  messageCacheController?: MessageCacheController;
  terminalTitle?: TerminalTitleController;
  /** Visible process-local warnings. These lines never enter pi session context. */
  startupWarnings?: readonly string[];
  onSandboxModeChange?: (mode: NonNullable<PumSettings["sandboxMode"]>) => void;
  sandboxWarningSource?: { subscribeWarnings(listener: (warning: string) => void): () => void };
}) {
  const cwd = process.cwd();
  const [session, setSession] = useState(initialSession);
  const [tx, setTx] = useState<Transcript>(() => ({
    // A resumed session already holds messages; show them instead of a blank pane.
    lines: [
      ...replayEntries(
        initialSession.sessionManager.buildContextEntries(),
        cwd,
        initial.showThinking,
      ),
      ...startupWarnings.map((text): Line => ({ kind: "text", role: "system", text })),
    ],
    stream: null,
    pending: [],
  }));
  const [busy, setBusy] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScrollOffset, setHelpScrollOffset] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<SessionHistoryItem[]>([]);
  const [page, setPage] = useState<"main" | "models" | "checkModels">("main");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [settingsSearchFocused, setSettingsSearchFocused] = useState(true);
  const [selectedSettingId, setSelectedSettingId] = useState<SettingRowId | null>(SETTINGS_ROWS[0]!.id);
  const [settings, setSettings] = useState(initial);
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
  const [checkApproval, setCheckApproval] = useState<CheckApprovalRequest | null>(null);
  const [checkApprovalDecision, setCheckApprovalDecision] = useState<CheckApprovalDecision>("allowOnce");
  const [, setAgentRevision] = useState(0);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [triggerCursor, setTriggerCursor] = useState(0);
  const [, setTriggerRevision] = useState(0);

  const newsRef = useRef<NewsItem[]>([]);
  const [news, setNews] = useState<NewsItem[]>(() => {
    const items = loadNewsItems(initialSession.sessionFile);
    newsRef.current = items;
    return items;
  });
  const [newsOpen, setNewsOpen] = useState(false);
  const newsOpenRef = useRef(false);
  const [newsCursor, setNewsCursor] = useState(0);
  const newsCursorRef = useRef(0);

  const theme = useMemo(() => loadTheme(settings.theme), [settings.theme]);
  const { width, height } = useTerminalDimensions();
  const syntaxStyle = useMemo(() => buildSyntaxStyle(theme), [theme]);
  const newsReadById = useMemo(
    () => new Map(news.map((item) => [item.id, item.read || item.answered])),
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
  const visibleTx = activeAgent?.transcript ?? tx;
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
  const inputHint = cancelArmed
    ? " esc again to cancel "
    : quitArmed
      ? " ctrl+c again to quit "
      : "";
  const promptRightColumns = width >= 12 ? 6 : Math.max(2, width - 3);
  const promptInputColumns = Math.max(
    1,
    width - 2 - promptRightColumns - inputHint.length,
  );
  const commandSuggestions = stashOpen ? [] : matchingCommands(commandInput).slice(0, 5);
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
  const settingsPageRef = useRef(page);
  const settingsSearchFocusedRef = useRef(settingsSearchFocused);
  const focusInputAfterSwitch = useRef(false);
  const activeAgentIdRef = useRef<string | null>(null);
  const agentSelectorCursorRef = useRef(0);
  const triggerCursorRef = useRef(0);
  const commandCursorRef = useRef(0);
  const stashRef = useRef(stash);
  const stashOpenRef = useRef(false);
  const stashCursorRef = useRef(-1);
  const stashSelectionRef = useRef<Set<number>>(new Set());
  const stashSelectionAnchor = useRef<number | null>(null);
  const pendingImages = useRef<PendingImage[]>([]);
  const nextImageId = useRef(1);
  const lastInputValue = useRef("");
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
    setStashMode(false);
    const nextCursor = Math.min(triggerCursorRef.current, Math.max(0, triggers.length - 1));
    triggerCursorRef.current = nextCursor;
    setTriggerCursor(nextCursor);
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
    if (editingIndex === index) editingStashIndex.current = null;
    else if (editingIndex !== null && editingIndex > index) {
      editingStashIndex.current = editingIndex - 1;
    }

    if (next.length === 0) setStashMode(false);
    else setSelectedStash(Math.min(index, next.length - 1));
  };

  const clearPendingImages = () => {
    for (const image of pendingImages.current) removePendingImage(image);
    pendingImages.current = [];
    nextImageId.current = 1;
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
    const input = inputRef.current;
    if (input) {
      input.setText(value);
      input.cursorOffset = Math.max(0, Math.min(cursorOffset, value.length));
    }
    lastInputValue.current = value;
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

    if (value !== nextValue && inputRef.current) {
      inputRef.current.setText(value);
      inputRef.current.cursorOffset = Math.min(cleanupCursor ?? value.length, value.length);
    }
    lastInputValue.current = value;
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
    editingStashIndex.current = null;
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

      const id = nextImageId.current++;
      const marker = `[Image #${id}]`;
      const current = input.plainText;
      const leadingSpace = current && !/\s$/.test(current) ? " " : "";
      const start = current.length + leadingSpace.length;
      const value = `${current}${leadingSpace}${marker}`;
      const image: PendingImage = {
        ...captured,
        id,
        marker,
        start,
        end: start + marker.length,
      };
      pendingImages.current.push(image);
      setEditorText(value, value.length, true);
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

  useEffect(() => checkApprovalCoordinator?.subscribe((request) => {
    setCheckApproval(request);
    setCheckApprovalDecision("allowOnce");
  }), [checkApprovalCoordinator]);

  useEffect(() => triggerManager?.subscribe(() => {
    setTriggerRevision((revision) => revision + 1);
    const count = triggerManager.getTriggers().length;
    const next = Math.min(triggerCursorRef.current, Math.max(0, count - 1));
    triggerCursorRef.current = next;
    setTriggerCursor(next);
  }), [triggerManager]);

  useEffect(
    () => subagentManager.subscribe((event) => {
      if (event.type === "main-line") append(event.line);
      else if (event.type === "main-pending-add") addPending(event.pending);
      else if (event.type === "main-pending-resolve") resolvePending(event.id);
      else if (event.type === "main-pending-drop") dropPending(event.id);
      setAgentRevision((revision) => revision + 1);
    }),
    [subagentManager],
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
            },
          });
          break;
        case "tool_execution_end":
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
          });
          break;
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
      spawnPreviewManager?.cancelAll("shutdown");
    },
    [spawnPreviewManager],
  );

  useEffect(() => {
    resetCancelArm();
  }, [activeAgentId, visibleBusy]);

  // Recalculate visual rows after wrapping, terminal resizes, or editor height changes.
  useEffect(() => {
    const timer = setTimeout(syncInputMetrics, 0);
    return () => clearTimeout(timer);
  }, [width, commandInput, inputRows, quitArmed, cancelArmed]);

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
    const next = { ...settings, ...patch };
    setSettings(next);
    if (patch.webSearch !== undefined) webSearch.enabled = patch.webSearch;
    if (patch.writingStyle !== undefined) setWritingStyle(patch.writingStyle);
    if (patch.explanationStrength !== undefined) {
      setExplanationStrength(patch.explanationStrength);
    }
    if (patch.sandboxMode !== undefined) onSandboxModeChange?.(patch.sandboxMode);
    if (patch.checkMode !== undefined || patch.checkModel !== undefined || patch.checkPaths !== undefined) {
      setCheckModeConfig({
        profile: next.checkMode,
        model: next.checkModel,
        additionalPaths: checkPathsForProject(next, cwd),
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

  const openLogin = () => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setHelpOpen(false);
    setHistoryOpen(false);
    setAgentSelectorOpen(false);
    setTriggerPopup(false, false);
    setNewsOpen(false);
    newsOpenRef.current = false;
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

  const moveNewsCursor = (direction: number) => {
    const count = newsRef.current.length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, newsCursorRef.current + direction));
    newsCursorRef.current = next;
    setNewsCursor(next);
  };

  const markCurrentNewsRead = () => {
    const item = newsRef.current[newsCursorRef.current];
    if (!item || item.read || item.answered) return;
    commitNews(
      newsRef.current.map((entry) =>
        entry.id === item.id ? { ...entry, read: true } : entry,
      ),
    );
  };

  const markNewestNewsAnswered = () => {
    const first = newsRef.current[0];
    if (!first || (first.read && first.answered)) return;
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
    viewDrafts.current.set("main", quote);
    if (activeAgentIdRef.current !== null) selectAgentView(null);
    else setEditorText(quote);
    queueMicrotask(() => {
      inputRef.current?.focus();
      const transcriptScroll = transcriptScrollRef.current;
      if (transcriptScroll) transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
    });
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
    // Hand a prompt back for editing: the queued steer if there is one, since
    // that is the newest thing written, otherwise the prompt that was running.
    const queued = session.clearQueue().steering;
    setTx((value) => ({
      ...value,
      pending: value.pending.filter((item) => item.line.kind === "agent-message"),
    }));
    const restore = queued.length ? queued[queued.length - 1]! : inFlight.current;
    if (inputRef.current && !inputRef.current.plainText) setEditorText(restore);
    histCursor.current = null;
    session.abort().finally(() => setWorking(false));
  };

  const recallQueuedUserMessage = async (target: string | null) => {
    const recalled = target
      ? await subagentManager.recallQueuedUserMessage(target)
      : await recallNewestQueuedUserMessage(session, tx.pending);
    if (!recalled) return;
    if (!target) dropPending(recalled.id);
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
    editingStashIndex.current = null;
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
    const newsCommand = trimmed === "/news";
    const worktreeCommand = /^\/worktree(?:\s+([a-zA-Z0-9_-]+))?$/.exec(trimmed);
    if (!compress && !clear && !historyCommand && !loginCommand && !checkPathCommand && !triggersCommand && !newsCommand && !worktreeCommand) return false;
    editingStashIndex.current = null;

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
    if (newsCommand) {
      setEditorText("");
      openNews();
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
      text: displayText.trim(),
    };

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
    const displayText = value ?? inputRef.current?.plainText ?? "";
    const attachments = value === undefined ? [...pendingImages.current] : [];
    let promptText = displayText;
    for (const image of attachments) promptText = promptText.replace(image.marker, "");
    promptText = promptText.replace(/[ \t]{2,}/g, " ").trim();

    if (!promptText && attachments.length === 0) return;

    let images;
    try {
      images = attachments.map(imageContent);
    } catch (error) {
      append({ kind: "text", role: "error", text: `image attachment failed: ${String(error)}` });
      return;
    }

    setEditorText("");
    clearPendingImages();

    if (attachments.length === 0 && promptText === "/login") {
      openLogin();
      return;
    }

    if (activeAgentId) {
      void subagentManager
        .sendUserMessage(activeAgentId, promptText, images, displayText.trim())
        .catch((error) => append({ kind: "text", role: "error", text: String(error) }));
      return;
    }

    if (attachments.length === 0 && runCommand(promptText)) return;

    if (promptText) history.current = promptHistoryStore.append(cwd, promptText);
    if (promptText && stashIndex === undefined) {
      const editingIndex = editingStashIndex.current;
      if (editingIndex === null) addToStash(promptText, true);
      else replaceStashedPrompt(editingIndex, promptText, true);
    }
    editingStashIndex.current = null;
    histCursor.current = null;
    draft.current = "";
    setSelectedStash(-1);
    void deliverMainPrompt(promptText, displayText, images).catch(() => {});
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
    editingStashIndex.current = null;
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

  const resolveCheckApproval = (decision: CheckApprovalDecision) => {
    if (!checkApproval || !checkApprovalCoordinator) return;
    const choice = decision === "allowOnce"
      ? "allow-once"
      : decision === "allowSession"
        ? "allow-session"
        : decision === "allowProject"
          ? "allow-project"
          : "deny";
    checkApprovalCoordinator.resolve(checkApproval.id, choice);
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
    clearCheckApprovals: { enter: () => {
      const removed = checkApprovalStore?.clearProject(cwd) ?? 0;
      append({ kind: "text", role: "system", text: removed > 0
        ? `cleared ${removed} Check mode project approval${removed === 1 ? "" : "s"}`
        : "no Check mode project approvals were stored" });
    } },
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
    webSearch: `‹ ${settings.webSearch ? "on" : "off"} ›${searchProviders.length ? "" : "  (not on provider)"}`,
    writingStyle: `‹ ${settings.writingStyle} ›`,
    explanationStrength: `‹ ${settings.explanationStrength} ›`,
    checkMode: `‹ ${settings.checkMode} ›`,
    sandboxMode: `‹ ${settings.sandboxMode ?? "auto"} ›`,
    checkModel: `${settings.checkModel} ›`,
    checkPaths: `${checkPathsForProject(settings, cwd).length} additional · /check-path ›`,
    clearCheckApprovals: "clear ›",
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
    const current = activeAgentIdRef.current;
    if (target === current) return true;
    const currentKey = current ?? "main";
    const targetKey = target ?? "main";
    viewDrafts.current.set(currentKey, inputRef.current?.plainText ?? "");
    viewEditingStashIndices.current.set(currentKey, editingStashIndex.current);
    activeAgentIdRef.current = target;
    setActiveAgentId(target);
    editingStashIndex.current = viewEditingStashIndices.current.get(targetKey) ?? null;
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
    if (!loginOpen || !controller?.acceptsTextPaste()) return;
    event.stopPropagation();
    controller.pasteText(decodePasteBytes(event.bytes));
  });

  useKeyboard((key) => {
    if (checkApproval) {
      key.stopPropagation();
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        resolveCheckApproval("deny");
        return;
      }
      const decisions: CheckApprovalDecision[] = ["allowOnce", "allowSession", "allowProject", "deny"];
      const index = decisions.indexOf(checkApprovalDecision);
      if (["left", "up"].includes(key.name)) {
        setCheckApprovalDecision(decisions[(index - 1 + decisions.length) % decisions.length]!);
      } else if (["right", "down", "tab"].includes(key.name)) {
        setCheckApprovalDecision(decisions[(index + 1) % decisions.length]!);
      } else if (["return", "enter", "kpenter", "linefeed"].includes(key.name)) {
        invokeCheckApprovalDecision(checkApprovalDecision, {
          onAllowOnce: () => resolveCheckApproval("allowOnce"),
          onAllowSession: () => resolveCheckApproval("allowSession"),
          onAllowProject: () => resolveCheckApproval("allowProject"),
          onDeny: () => resolveCheckApproval("deny"),
        });
      }
      return;
    }

    if (spawnPreview) {
      const isPreviewReturn = ["return", "enter", "kpenter", "linefeed"].includes(key.name);
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        key.stopPropagation();
        spawnPreviewInputRef.current?.setText("");
        spawnPreviewManager?.cancel();
      } else if (isPreviewReturn && !key.shift && !key.ctrl && !key.meta && !key.option) {
        key.stopPropagation();
        const note = spawnPreviewInputRef.current?.plainText ?? "";
        spawnPreviewInputRef.current?.setText("");
        spawnPreviewManager?.approve(note);
      }
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
        !settingsOpenRef.current;
      const inputValue = inputRef.current?.plainText ?? "";
      if (promptOwnsInput && (inputValue.length > 0 || pendingImages.current.length > 0)) {
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

    if (key.ctrl && key.name === "t") {
      key.stopPropagation();
      if (triggersOpenRef.current) setTriggerPopup(false);
      else openTriggers();
      return;
    }

    if (triggersOpenRef.current) {
      key.stopPropagation();
      if (key.name === "escape") {
        setTriggerPopup(false);
      } else if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") {
        const direction = key.name === "up" || key.name === "pageup" ? -1 : 1;
        const steps = key.name === "pageup" || key.name === "pagedown" ? 5 : 1;
        let next = triggerCursorRef.current;
        for (let index = 0; index < steps; index++) {
          next = moveTriggerSelection(next, triggers.length, direction);
        }
        triggerCursorRef.current = next;
        setTriggerCursor(next);
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

    if (key.ctrl && key.name === "n") {
      key.stopPropagation();
      if (newsOpenRef.current) closeNews();
      else openNews();
      return;
    }
    if (newsOpenRef.current) {
      key.stopPropagation();
      if (key.name === "escape") closeNews();
      else if (key.name === "left") moveNewsCursor(1);
      else if (key.name === "right") moveNewsCursor(-1);
      else if (key.name === "space" || key.sequence === " ") markCurrentNewsRead();
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
    // Ctrl+Alt+Enter is an explicit cache alias for terminals that reserve
    // Alt+Enter, such as Windows Terminal's default fullscreen binding.
    const isCacheReturn = hasAlt && isReturn;
    const isNewlineReturn = (key.ctrl || key.shift) && !hasAlt && isReturn;
    const isPlainReturn =
      isReturn && !key.ctrl && !key.shift && !key.meta && !key.option;
    const inputValue = inputRef.current?.plainText ?? "";
    const commandMatches = stashOpenRef.current
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
      if (pendingImages.current.length > 0) {
        append({
          kind: "text",
          role: "error",
          text: "image prompts cannot be stored in the cache; send or remove the image first",
        });
        return;
      }
      if (inputValue.trim()) {
        const editingIndex = editingStashIndex.current;
        if (editingIndex === null) addToStash(inputValue);
        else replaceStashedPrompt(editingIndex, inputValue, false);
        editingStashIndex.current = null;
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
            editingStashIndex.current = index;
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
      if (activeAgentId) return;
      if (commandMatches.length > 0 && !/\s/.test(inputValue)) {
        key.stopPropagation();
        const selected = commandMatches[Math.min(commandCursorRef.current, commandMatches.length - 1)]!;
        setEditorText(selected.name);
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
      if ((inputRef.current?.editorView.getTotalVirtualLineCount() ?? 1) > 1) return;
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

    if (key.name === "escape") {
      if (stashOpenRef.current) {
        key.stopPropagation();
        resetCancelArm();
        setStashMode(false);
      } else if (
        inputValue.startsWith("/") &&
        !/\s/.test(inputValue) &&
        matchingCommands(inputValue).length > 0
      ) {
        key.stopPropagation();
        resetCancelArm();
        setEditorText("");
      } else if ((activeAgentId && visibleBusy) || (!activeAgentId && busyRef.current)) {
        key.stopPropagation();
        const now = Date.now();
        const target = activeAgentId ?? "main";
        if (confirmsCancellation(lastCancelPress.current, cancelTarget.current, target, now)) {
          resetCancelArm();
          if (activeAgentId) void subagentManager.abortAgent(activeAgentId);
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

  const lastLine = visibleTx.lines[visibleTx.lines.length - 1];
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
          {visibleTx.lines.map((line, i) => {
            const workingCaret = visibleBusy && !visibleTx.stream && i === visibleTx.lines.length - 1;
            const row =
              line.kind === "tool" ? (
                <ToolLine theme={theme} call={line.call} workingCaret={workingCaret} />
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
            const gapBefore = needsTranscriptGap(visibleTx.lines[i - 1], line);
            const lineKey =
              line.kind === "tool"
                ? `tool:${line.call.id}`
                : line.kind === "agent-message"
                  ? `agent:${line.sender}:${line.recipient}:${i}:${line.text}`
                  : `text:${line.role}:${i}:${line.text}`;
            return (
              <Fragment key={lineKey}>
                {gapBefore ? <Gap /> : null}
                {row}
              </Fragment>
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
              {(visibleTx.lines.length > 0 || visibleTx.stream) ? <Gap /> : null}
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
            focused={!settingsOpen && !helpOpen && !historyOpen && !agentSelectorOpen && !triggersOpen && !loginOpen && !questionnaire && !spawnPreview && !checkApproval}
            onContentChange={handleTextareaChange}
            onCursorChange={scheduleInputMetrics}
            onSubmit={() => submitPrompt()}
            style={{ width: promptInputColumns, flexShrink: 0, minWidth: 0, height: inputRows }}
          />
          {/* Reserve six columns on normal terminals. This forces wrapping
              before cursor movement can briefly overdraw the terminal edge. */}
          <box style={{ width: promptRightColumns, height: inputRows, flexShrink: 0 }} />
          {inputHint ? <text content={inputHint} fg={theme.warn} /> : null}
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
          <TriggersPopup
            theme={theme}
            triggers={triggers}
            cursor={triggerCursor}
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
        {checkApproval ? (
          <CheckApprovalPopup
            theme={theme}
            request={{
              tool: checkApproval.toolName,
              summary: checkApproval.summary,
              reason: checkApproval.reason,
              paths: checkApproval.paths,
              preview: { kind: checkApproval.toolName === "bash" ? "command" : "diff", text: checkApproval.preview },
              agentLabel: checkApproval.target?.agentId
                ? agents.find((agent) => agent.id === checkApproval.target?.agentId)?.name ?? "subagent"
                : checkApproval.target?.sessionId
                  ? "main"
                  : checkApproval.cwd === cwd
                    ? "main"
                    : agents.find((agent) => agent.worktree.path === checkApproval.cwd)?.name ?? "subagent",
            }}
            selectedDecision={checkApprovalDecision}
            terminalWidth={width}
            terminalHeight={height}
            onAllowOnce={() => resolveCheckApproval("allowOnce")}
            onAllowSession={() => resolveCheckApproval("allowSession")}
            onAllowProject={() => resolveCheckApproval("allowProject")}
            onDeny={() => resolveCheckApproval("deny")}
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

import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime, SessionInfo } from "@earendil-works/pi-coding-agent";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AnimationProvider, supportsTrueColor } from "./animation";
import { ROWS, SettingsPopup, THINKING_LEVELS, type ThinkingLevel } from "./settings-popup";
import { saveSettings, type PumSettings } from "./settings";
import { StatusBar } from "./status-bar";
import { StreamLine, TextLine, ToolLine, type Line, type Role } from "./transcript";
import { editCounts, toolArg, type ToolCall } from "./tool-line";
import { readBranch, watchBranch } from "./git-branch";
import { HelpPopup } from "./help-popup";
import { appendHistory, loadHistory } from "./history";
import { replayMessages } from "./replay";
import { loadTheme, PRESET_NAMES } from "./theme";
import { buildSyntaxStyle } from "./syntax";
import { observeSearchCalls, webSearch } from "./web-search";
import { matchingCommands } from "./commands";
import { SessionHistoryPopup } from "./session-history-popup";

type Stream = { kind: "assistant" | "thinking"; text: string } | null;
type Transcript = { lines: Line[]; stream: Stream };

const QUIT_WINDOW_MS = 2000;
/** Keys that move around without changing the text. */
const NAV_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

/** A blank row. An empty <text> measures to nothing, so this needs a height. */
const Gap = () => <box style={{ height: 1, flexShrink: 0 }} />;

/** Move any buffered stream into the transcript so later lines land in order. */
function flushed(t: Transcript): Transcript {
  if (t.stream && t.stream.text.trim()) {
    const line: Line = { kind: "text", role: t.stream.kind, text: t.stream.text.trim() };
    return { lines: [...t.lines, line], stream: null };
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
}: {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  onNewSession: () => Promise<AgentSession>;
  loadSessions: () => Promise<SessionInfo[]>;
  onSwitchSession: (path: string) => Promise<AgentSession>;
  settings: PumSettings;
  /** Provider ids that carry the hosted web-search tool; empty means none. */
  searchProviders: string[];
}) {
  const [session, setSession] = useState(initialSession);
  const [tx, setTx] = useState<Transcript>(() => ({
    // A resumed session already holds messages; show them instead of a blank pane.
    lines: replayMessages(initialSession.agent.state.messages, process.cwd(), initial.showThinking),
    stream: null,
  }));
  const [busy, setBusy] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<SessionInfo[]>([]);
  const [page, setPage] = useState<"main" | "models">("main");
  const [cursor, setCursor] = useState(0);
  const [settings, setSettings] = useState(initial);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    session.agent.state.thinkingLevel as ThinkingLevel,
  );
  const [modelId, setModelId] = useState(session.agent.state.model.id);
  const [branch, setBranch] = useState<string | null>(null);
  const [usage, setUsage] = useState({ tokens: 0, cost: 0, contextPct: null as number | null });
  const [elapsedSec, setElapsedSec] = useState(0);
  const [commandInput, setCommandInput] = useState("");

  const theme = useMemo(() => loadTheme(settings.theme), [settings.theme]);
  const { width } = useTerminalDimensions();
  const syntaxStyle = useMemo(() => buildSyntaxStyle(theme), [theme]);
  const animations = settings.animations && supportsTrueColor();

  const inputRef = useRef<InputRenderable>(null);
  const quitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastQuitPress = useRef(0);
  // Prompt history. `cursor` is null while editing a fresh line; `draft` holds
  // that line so walking back down restores it.
  const history = useRef<string[]>(loadHistory(process.cwd()));
  const histCursor = useRef<number | null>(null);
  const draft = useRef("");
  /** The prompt in flight, so Esc can hand it back for editing. */
  const inFlight = useRef("");
  // Mirrors `busy` for the keyboard handler: a keypress can land before React
  // has re-rendered, and the handler's closure would still read the old value.
  const busyRef = useRef(false);
  const setWorking = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  // The event subscription is set up once, so it reads the toggle via a ref.
  const showThinkingRef = useRef(initial.showThinking);

  const append = (line: Line) =>
    setTx((t) => {
      const f = flushed(t);
      return { ...f, lines: [...f.lines, line] };
    });

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
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
    setModelId(session.agent.state.model.id);
    setTx({
      lines: replayMessages(session.agent.state.messages, process.cwd(), showThinkingRef.current),
      stream: null,
    });
    setUsage({ tokens: 0, cost: 0, contextPct: null });

    const cwd = process.cwd();
    return session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") delta("assistant", update.delta);
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
            state: event.isError ? "error" : "ok",
            detail: event.toolName === "edit" ? editCounts(event.result) : undefined,
          });
          break;
        case "turn_end": {
          const u = (event.message as any)?.usage;
          if (u) {
            const window = session.agent.state.model.contextWindow;
            setUsage((prev) => ({
              tokens: prev.tokens + (u.totalTokens ?? 0),
              cost: prev.cost + (u.cost?.total ?? 0),
              contextPct: window
                ? Math.min(100, Math.round(((u.input + u.cacheRead) / window) * 100))
                : null,
            }));
          }
          break;
        }
        case "thinking_level_changed":
          setThinkingLevel(event.level as ThinkingLevel);
          break;
        // agent_end fires before auto-retries; agent_settled means truly done.
        case "agent_settled":
          setTx(flushed);
          setWorking(false);
          break;
      }
    });
  }, [session]);

  useEffect(() => () => clearTimeout(quitTimer.current), []);

  // Hosted web searches are not pi tool calls, so they arrive out of band.
  useEffect(() => {
    observeSearchCalls((call) => {
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
    });
  }, []);

  // Git branch, live-watched.
  useEffect(() => {
    const cwd = process.cwd();
    setBranch(readBranch(cwd));
    return watchBranch(cwd, () => setBranch(readBranch(cwd)));
  }, []);

  // Turn timer, only while working.
  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const started = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const update = (patch: Partial<PumSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (patch.webSearch !== undefined) webSearch.enabled = patch.webSearch;
    if (patch.showThinking !== undefined) showThinkingRef.current = patch.showThinking;
    saveSettings(next);
  };

  const stepThinking = (step: number) => {
    const i = THINKING_LEVELS.indexOf(thinkingLevel);
    const target = THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, i + step))]!;
    session.setThinkingLevel(target);
    // setThinkingLevel clamps to what the model supports — show the real value.
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
  };

  const stepTheme = (step: number) => {
    const i = PRESET_NAMES.indexOf(settings.theme);
    const next = PRESET_NAMES[(i + step + PRESET_NAMES.length) % PRESET_NAMES.length]!;
    update({ theme: next });
  };

  const selectModel = (model: Model<any>) => {
    setPage("main");
    session
      .setModel(model)
      .then(() => setModelId(session.agent.state.model.id))
      .catch((err) => append({ kind: "text", role: "error", text: String(err) }));
  };

  const openHistory = () => {
    if (busyRef.current) {
      append({ kind: "text", role: "error", text: "wait for the current turn to finish before opening history" });
      return;
    }
    setSettingsOpen(false);
    setHelpOpen(false);
    loadSessions()
      .then((sessions) => {
        const currentPath = session.sessionFile;
        setHistorySessions(sessions.filter((candidate) => candidate.path !== currentPath));
        setHistoryOpen(true);
      })
      .catch((err) => append({ kind: "text", role: "error", text: String(err) }));
  };

  const selectHistorySession = (path: string) => {
    setHistoryOpen(false);
    setWorking(true);
    onSwitchSession(path)
      .then((next) => setSession(next))
      .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
      .finally(() => setWorking(false));
  };

  const cancel = () => {
    append({ kind: "text", role: "system", text: "cancelled" });
    // Hand a prompt back for editing: the queued steer if there is one, since
    // that is the newest thing written, otherwise the prompt that was running.
    const queued = session.clearQueue().steering;
    const restore = queued.length ? queued[queued.length - 1]! : inFlight.current;
    if (inputRef.current && !inputRef.current.value) inputRef.current.value = restore;
    histCursor.current = null;
    session.abort().finally(() => setWorking(false));
  };

  /** Up walks back through sent prompts, down returns to the current draft. */
  const recall = (direction: -1 | 1) => {
    const input = inputRef.current;
    const list = history.current;
    if (!input || list.length === 0) return;

    if (histCursor.current === null) {
      if (direction === 1) return; // already on the draft line
      draft.current = input.value;
      histCursor.current = list.length - 1;
    } else {
      const next = histCursor.current + direction;
      if (next >= list.length) {
        histCursor.current = null;
        input.value = draft.current;
        return;
      }
      histCursor.current = Math.max(0, next);
    }
    input.value = list[histCursor.current]!;
  };

  // One entry per popup row, so adding a row cannot desynchronise the indices.
  const rowActions: { step?: (n: number) => void; enter?: () => void }[] = [
    { step: stepTheme },
    { step: () => update({ animations: !settings.animations }) },
    { step: () => update({ webSearch: !settings.webSearch }) },
    { step: stepThinking },
    { step: () => update({ showThinking: !settings.showThinking }) },
    { enter: () => setPage("models") },
  ];

  const rowValues = [
    `‹ ${theme.name} ›`,
    `‹ ${settings.animations ? "on" : "off"} ›${settings.animations && !animations ? "  (no truecolor)" : ""}`,
    `‹ ${settings.webSearch ? "on" : "off"} ›${searchProviders.length ? "" : "  (not on this provider)"}`,
    `‹ ${thinkingLevel} ›`,
    `‹ ${settings.showThinking ? "on" : "off"} ›`,
    `${modelId} ›`,
  ];

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.stopPropagation();
      // Keyed off a timestamp, not `quitArmed`: two fast presses can land in
      // one React batch, where the state has not updated between them yet.
      const now = Date.now();
      if (now - lastQuitPress.current < QUIT_WINDOW_MS) process.exit(0);
      lastQuitPress.current = now;
      setQuitArmed(true);
      clearTimeout(quitTimer.current);
      quitTimer.current = setTimeout(() => setQuitArmed(false), QUIT_WINDOW_MS);
      return;
    }
    // Any other key disarms, so Ctrl+C · x · Ctrl+C does not quit.
    if (lastQuitPress.current) {
      lastQuitPress.current = 0;
      clearTimeout(quitTimer.current);
      setQuitArmed(false);
    }

    if (helpOpen) {
      key.stopPropagation();
      if (key.name === "escape" || key.sequence === "?") setHelpOpen(false);
      return;
    }

    if (historyOpen) {
      if (key.name === "escape") {
        key.stopPropagation();
        setHistoryOpen(false);
      }
      return; // navigation and Enter belong to the focused select
    }

    if (key.ctrl && key.name === "h") {
      key.stopPropagation();
      openHistory();
      return;
    }

    // `?` on an empty prompt opens help instead of typing a question mark.
    // With text already in the line it is just a character.
    if (key.sequence === "?" && !settingsOpen && !inputRef.current?.value) {
      key.stopPropagation();
      setHelpOpen(true);
      return;
    }

    if (settingsOpen) {
      if (key.name === "escape") {
        key.stopPropagation();
        if (page === "models") setPage("main");
        else setSettingsOpen(false);
        return;
      }
      if (page === "models") return; // up/down/return belong to the <select>

      key.stopPropagation();
      const action = rowActions[cursor];
      const confirming = key.name === "space" || key.sequence === " " || key.name === "return";
      if (key.name === "up") setCursor((c) => (c + ROWS.length - 1) % ROWS.length);
      else if (key.name === "down") setCursor((c) => (c + 1) % ROWS.length);
      else if (key.name === "left") action?.step?.(-1);
      else if (key.name === "right") action?.step?.(1);
      else if (confirming) (action?.enter ?? (() => action?.step?.(1)))();
      return;
    }

    const inputValue = inputRef.current?.value ?? "";

    // Tab completes a PUM command instead of moving focus. If there are ever
    // multiple matches, repeated Tab cycles through them.
    if (key.name === "tab") {
      const matches = matchingCommands(inputValue);
      if (matches.length > 0 && !/\s/.test(inputValue)) {
        key.stopPropagation();
        const current = matches.findIndex((command) => command.name === inputValue);
        const next = matches[(current + 1) % matches.length]!;
        inputRef.current!.value = next.name;
        setCommandInput(next.name);
        return;
      }
    }

    // Editing puts you back on a fresh line, so the next Up starts from the
    // most recent prompt and Down returns to what you just typed.
    if (!NAV_KEYS.has(key.name)) histCursor.current = null;

    if (key.name === "up" || key.name === "down") {
      key.stopPropagation();
      recall(key.name === "up" ? -1 : 1);
      return;
    }

    if (key.name === "escape") {
      if (busyRef.current) {
        key.stopPropagation();
        cancel();
      }
      return;
    }
    if (key.ctrl && key.name === "p") {
      key.stopPropagation();
      setCursor(0);
      setPage("main");
      setSettingsOpen(true);
    }
  });

  const lastLine = tx.lines[tx.lines.length - 1];
  const streamGap =
    tx.stream?.kind === "assistant" &&
    !!lastLine &&
    !(lastLine.kind === "text" && lastLine.role === "user");

  const runCommand = (text: string): boolean => {
    const trimmed = text.trim();
    const compress = /^\/compress(?:\s+(.*))?$/s.exec(trimmed);
    const clear = /^\/(?:clear|new)$/.test(trimmed);
    const history = trimmed === "/history";
    if (!compress && !clear && !history) return false;

    if (history) {
      if (inputRef.current) inputRef.current.value = "";
      setCommandInput("");
      openHistory();
      return true;
    }

    if (inputRef.current) inputRef.current.value = "";
    setCommandInput("");
    histCursor.current = null;
    draft.current = "";

    if (busyRef.current) {
      append({ kind: "text", role: "error", text: "wait for the current turn to finish before running a command" });
      return true;
    }

    setWorking(true);
    if (clear) {
      onNewSession()
        .then((next) => setSession(next))
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(false));
    } else {
      session
        .compact(compress![1]?.trim() || undefined)
        .then((result) => {
          append({
            kind: "text",
            role: "system",
            text: `compressed context (${result.tokensBefore.toLocaleString()} tokens before)`,
          });
        })
        .catch((err) => append({ kind: "text", role: "error", text: String(err) }))
        .finally(() => setWorking(false));
    }
    return true;
  };

  const submit = () => {
    const text = inputRef.current?.value ?? "";
    if (!text.trim()) return;
    if (runCommand(text)) return;
    inputRef.current!.value = "";
    setCommandInput("");
    history.current = appendHistory(process.cwd(), text);
    histCursor.current = null;
    draft.current = "";
    append({ kind: "text", role: "user", text });

    // Working already: queue it as steering, delivered once the current step's
    // tool calls finish, rather than starting a second turn.
    if (busyRef.current) {
      session.steer(text).catch((err) => {
        append({ kind: "text", role: "error", text: String(err) });
      });
      return;
    }

    inFlight.current = text;
    setWorking(true);
    session.prompt(text).catch((err) => {
      append({ kind: "text", role: "error", text: String(err) });
      setWorking(false);
    });
  };

  return (
    <AnimationProvider enabled={animations}>
      <box style={{ flexDirection: "column", height: "100%", backgroundColor: theme.bg }}>
        <text
          content={"─".repeat(Math.max(0, width))}
          fg={theme.border}
          style={{ flexShrink: 0 }}
        />
        <StatusBar
          theme={theme}
          modelId={modelId}
          thinkingLevel={thinkingLevel}
          branch={branch}
          tokens={usage.tokens}
          cost={usage.cost}
          contextPct={usage.contextPct}
          busy={busy}
          elapsedSec={elapsedSec}
        />
        <scrollbox
          style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
          stickyScroll
          stickyStart="bottom"
          verticalScrollbarOptions={{ visible: true }}
        >
          {tx.lines.map((line, i) => {
            const row =
              line.kind === "tool" ? (
                <ToolLine theme={theme} call={line.call} />
              ) : (
                <TextLine
                  theme={theme}
                  syntaxStyle={syntaxStyle}
                  role={line.role as Role}
                  text={line.text}
                />
              );
            // A user turn gets a blank row on each side, and the answer gets
            // one above it so it reads as its own block rather than trailing
            // the tool calls. A user turn already emits a trailing gap, so
            // never add a second one straight after it.
            const isUser = line.kind === "text" && line.role === "user";
            const prev = tx.lines[i - 1];
            const afterUser = prev?.kind === "text" && prev.role === "user";
            const isAnswer = line.kind === "text" && line.role === "assistant";
            const gapBefore = (isUser && i > 0) || (isAnswer && !!prev && !afterUser);
            return (
              <Fragment key={i}>
                {gapBefore ? <Gap /> : null}
                {row}
                {isUser ? <Gap /> : null}
              </Fragment>
            );
          })}
          {tx.stream ? (
            <>
              {/* Same gap while the answer is still arriving, so it does not
                  jump down a row when the message settles. */}
              {streamGap ? <Gap /> : null}
              <StreamLine theme={theme} role={tx.stream.kind} text={tx.stream.text} />
            </>
          ) : null}
        </scrollbox>
        <text
          content={"─".repeat(Math.max(0, width))}
          fg={theme.border}
          style={{ flexShrink: 0 }}
        />
        {matchingCommands(commandInput).length > 0 ? (
          <box style={{ height: 1, flexShrink: 0, paddingLeft: 2 }}>
            <text
              content={`${matchingCommands(commandInput)[0]!.name}  —  ${matchingCommands(commandInput)[0]!.description}  [Tab to complete]`}
              fg={theme.dim}
            />
          </box>
        ) : null}
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text content="❯ " fg={theme.accent} />
          <input
            ref={inputRef}
            placeholder={busy ? "Steer…" : "Ask something…"}
            focused={!settingsOpen && !helpOpen}
            onInput={setCommandInput}
            onSubmit={submit}
            style={{ flexGrow: 1 }}
          />
          {quitArmed ? <text content=" ctrl+c again to quit " fg={theme.warn} /> : null}
        </box>
        <text
          content={"─".repeat(Math.max(0, width))}
          fg={theme.border}
          style={{ flexShrink: 0 }}
        />
        {helpOpen ? <HelpPopup theme={theme} /> : null}
        {historyOpen ? (
          <SessionHistoryPopup
            theme={theme}
            sessions={historySessions}
            onSelect={selectHistorySession}
          />
        ) : null}
        {settingsOpen ? (
          <SettingsPopup
            theme={theme}
            page={page}
            cursor={cursor}
            values={rowValues}
            models={modelRuntime.getAvailableSnapshot()}
            onSelectModel={selectModel}
          />
        ) : null}
      </box>
    </AnimationProvider>
  );
}

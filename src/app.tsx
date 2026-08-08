import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimationProvider, supportsTrueColor } from "./animation";
import { ROWS, SettingsPopup, THINKING_LEVELS, type ThinkingLevel } from "./settings-popup";
import { saveSettings, type PumSettings } from "./settings";
import { StatusBar } from "./status-bar";
import { StreamLine, TextLine, ToolLine, type Line, type Role } from "./transcript";
import { editCounts, toolArg, type ToolCall } from "./tool-line";
import { readBranch, watchBranch } from "./git-branch";
import { loadTheme, PRESET_NAMES } from "./theme";

type Stream = { kind: "assistant" | "thinking"; text: string } | null;
type Transcript = { lines: Line[]; stream: Stream };

const QUIT_WINDOW_MS = 2000;

/** Move any buffered stream into the transcript so later lines land in order. */
function flushed(t: Transcript): Transcript {
  if (t.stream && t.stream.text.trim()) {
    const line: Line = { kind: "text", role: t.stream.kind, text: t.stream.text.trim() };
    return { lines: [...t.lines, line], stream: null };
  }
  return { ...t, stream: null };
}

export function App({
  session,
  modelRuntime,
  settings: initial,
}: {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  settings: PumSettings;
}) {
  const [tx, setTx] = useState<Transcript>({ lines: [], stream: null });
  const [busy, setBusy] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const theme = useMemo(() => loadTheme(settings.theme), [settings.theme]);
  const animations = settings.animations && supportsTrueColor();

  const inputRef = useRef<InputRenderable>(null);
  const quitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastQuitPress = useRef(0);
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
          setBusy(false);
          break;
      }
    });
  }, [session]);

  useEffect(() => () => clearTimeout(quitTimer.current), []);

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

  const cancel = () => {
    append({ kind: "text", role: "system", text: "cancelled" });
    session.abort().finally(() => setBusy(false));
  };

  // One entry per popup row, so adding a row cannot desynchronise the indices.
  const rowActions: { step?: (n: number) => void; enter?: () => void }[] = [
    { step: stepTheme },
    { step: () => update({ animations: !settings.animations }) },
    { step: stepThinking },
    { step: () => update({ showThinking: !settings.showThinking }) },
    { enter: () => setPage("models") },
  ];

  const rowValues = [
    `‹ ${theme.name} ›`,
    `‹ ${settings.animations ? "on" : "off"} ›${settings.animations && !animations ? "  (no truecolor)" : ""}`,
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

    if (key.name === "escape") {
      if (busy) {
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

  const submit = () => {
    const text = inputRef.current?.value ?? "";
    if (!text.trim() || busy) return;
    inputRef.current!.value = "";
    append({ kind: "text", role: "user", text });
    setBusy(true);
    session.prompt(text).catch((err) => {
      append({ kind: "text", role: "error", text: String(err) });
      setBusy(false);
    });
  };

  return (
    <AnimationProvider enabled={animations}>
      <box style={{ flexDirection: "column", height: "100%", backgroundColor: theme.bg }}>
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
          {tx.lines.map((line, i) =>
            line.kind === "tool" ? (
              <ToolLine key={i} theme={theme} call={line.call} />
            ) : (
              <TextLine key={i} theme={theme} role={line.role as Role} text={line.text} />
            ),
          )}
          {tx.stream ? (
            <StreamLine theme={theme} role={tx.stream.kind} text={tx.stream.text} />
          ) : null}
        </scrollbox>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text content="❯ " fg={theme.accent} />
          <input
            ref={inputRef}
            placeholder="Ask something…"
            focused={!settingsOpen}
            onSubmit={submit}
            style={{ flexGrow: 1 }}
          />
          {quitArmed ? <text content=" ctrl+c again to quit " fg={theme.warn} /> : null}
        </box>
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

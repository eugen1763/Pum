import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { useEffect, useRef, useState } from "react";
import { ROWS, SettingsPopup, THINKING_LEVELS, type ThinkingLevel } from "./settings-popup";
import { saveSettings, type PumSettings } from "./settings";

type Role = "user" | "assistant" | "thinking" | "tool" | "system" | "error";
type Line = { role: Role; text: string };
type Stream = { kind: "assistant" | "thinking"; text: string } | null;
type Transcript = { lines: Line[]; stream: Stream };

const COLORS: Record<Role, string> = {
  user: "#7aa2f7",
  assistant: "#c0caf5",
  thinking: "#565f89",
  tool: "#e0af68",
  system: "#565f89",
  error: "#f7768e",
};

const PREFIX: Record<Role, string> = {
  user: "› ",
  assistant: "",
  thinking: "  ",
  tool: "⚒ ",
  system: "⊘ ",
  error: "! ",
};

const QUIT_WINDOW_MS = 2000;

/** Move any buffered stream into the transcript so later lines land in order. */
function flushed(t: Transcript): Transcript {
  if (t.stream && t.stream.text.trim()) {
    return { lines: [...t.lines, { role: t.stream.kind, text: t.stream.text.trim() }], stream: null };
  }
  return { ...t, stream: null };
}

export function App({
  session,
  modelRuntime,
  settings,
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
  const [showThinking, setShowThinking] = useState(settings.showThinking);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    session.agent.state.thinkingLevel as ThinkingLevel,
  );
  const [modelId, setModelId] = useState(session.agent.state.model.id);

  const inputRef = useRef<InputRenderable>(null);
  const quitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastQuitPress = useRef(0);
  // The event subscription is set up once, so it reads the toggle via a ref.
  const showThinkingRef = useRef(settings.showThinking);

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

  useEffect(() => {
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
          append({ role: "tool", text: event.toolName });
          break;
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

  const toggleTraces = () => {
    const next = !showThinking;
    setShowThinking(next);
    showThinkingRef.current = next;
    saveSettings({ ...settings, showThinking: next });
  };

  const stepThinking = (step: number) => {
    const i = THINKING_LEVELS.indexOf(thinkingLevel);
    const target = THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, i + step))]!;
    session.setThinkingLevel(target);
    // setThinkingLevel clamps to what the model supports — show the real value.
    setThinkingLevel(session.agent.state.thinkingLevel as ThinkingLevel);
  };

  const selectModel = (model: Model<any>) => {
    setPage("main");
    session
      .setModel(model)
      .then(() => setModelId(session.agent.state.model.id))
      .catch((err) => append({ role: "error", text: String(err) }));
  };

  const cancel = () => {
    append({ role: "system", text: "cancelled" });
    session.abort().finally(() => setBusy(false));
  };

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
      const toggling = key.name === "space" || key.sequence === " " || key.name === "return";
      if (key.name === "up") setCursor((c) => (c + ROWS.length - 1) % ROWS.length);
      else if (key.name === "down") setCursor((c) => (c + 1) % ROWS.length);
      else if (key.name === "left" || key.name === "right") {
        if (cursor === 0) stepThinking(key.name === "right" ? 1 : -1);
        else if (cursor === 1) toggleTraces();
      } else if (toggling) {
        if (cursor === 1) toggleTraces();
        else if (cursor === 2) setPage("models");
      }
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
    append({ role: "user", text });
    setBusy(true);
    session.prompt(text).catch((err) => {
      append({ role: "error", text: String(err) });
      setBusy(false);
    });
  };

  const title = quitArmed
    ? " Press Ctrl+C again to quit "
    : ` pum · ${modelId} · thinking ${thinkingLevel}${busy ? " · working…" : ""} `;

  return (
    <box style={{ flexDirection: "column", height: "100%" }}>
      <scrollbox style={{ flexGrow: 1, padding: 1 }} stickyScroll stickyStart="bottom">
        {tx.lines.map((line, i) => (
          <text key={i} content={PREFIX[line.role] + line.text} fg={COLORS[line.role]} />
        ))}
        {tx.stream ? (
          <text content={PREFIX[tx.stream.kind] + tx.stream.text} fg={COLORS[tx.stream.kind]} />
        ) : null}
      </scrollbox>
      <box title={title} style={{ border: true, height: 3 }}>
        <input
          ref={inputRef}
          placeholder="Ask something. Ctrl+P settings, Esc cancels, Ctrl+C twice quits."
          focused={!settingsOpen}
          onSubmit={submit}
        />
      </box>
      {settingsOpen ? (
        <SettingsPopup
          page={page}
          cursor={cursor}
          thinkingLevel={thinkingLevel}
          showThinking={showThinking}
          modelId={modelId}
          models={modelRuntime.getAvailableSnapshot()}
          onSelectModel={selectModel}
        />
      ) : null}
    </box>
  );
}

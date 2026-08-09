import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { QuestionnaireRequest } from "./questionnaire";
import type { Theme } from "./theme";

export function questionnairePopupGeometry(width: number, height: number) {
  const margin = width < 4 ? 0 : width < 60 ? 1 : Math.max(2, Math.floor(width * 0.1));
  const popupWidth = Math.max(1, width - margin * 2);
  const popupHeight = Math.max(1, Math.min(height, Math.max(8, Math.floor(height * 0.8))));
  return {
    left: margin,
    top: Math.max(0, Math.floor((height - popupHeight) / 2)),
    width: popupWidth,
    height: popupHeight,
    compact: popupHeight < 8,
  };
}

export function QuestionnairePopup({
  theme,
  request,
  terminalWidth,
  terminalHeight,
  inputRef,
}: {
  theme: Theme;
  request: QuestionnaireRequest;
  terminalWidth: number;
  terminalHeight: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
}) {
  const geometry = questionnairePopupGeometry(terminalWidth, terminalHeight);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const question = request.questions[request.page];
  const selected = request.optionIndices[request.page] ?? 0;
  const submitPage = request.page === request.questions.length;
  const answered = request.answers.size;

  useEffect(() => {
    const timer = setTimeout(() => {
      if (submitPage) return;
      scrollRef.current?.scrollChildIntoView(`questionnaire-option-${selected}`);
    }, 0);
    return () => clearTimeout(timer);
  }, [request.id, request.page, selected, submitPage]);

  useEffect(() => {
    if (request.customInput) queueMicrotask(() => inputRef.current?.focus());
  }, [request.id, request.customInput, inputRef]);

  const pageLabel = submitPage
    ? "Submit"
    : question?.label ?? `Question ${request.page + 1}`;

  return (
    <box
      title={geometry.compact ? undefined : ` Questionnaire · ${request.requester.name} `}
      style={{
        position: "absolute",
        top: geometry.top,
        left: geometry.left,
        width: geometry.width,
        height: geometry.height,
        zIndex: 120,
        border: !geometry.compact,
        borderColor: theme.border,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding: geometry.compact ? 0 : 1,
      }}
    >
      {!geometry.compact ? (
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text content={pageLabel} fg={theme.accent} bg={theme.popupBg} wrapMode="none" />
          <text
            content={`  ${answered}/${request.questions.length} answered`}
            fg={theme.dim}
            bg={theme.popupBg}
            wrapMode="none"
            style={{ flexGrow: 1, minWidth: 0 }}
          />
        </box>
      ) : null}

      <scrollbox
        ref={scrollRef}
        style={{ flexGrow: 1, minHeight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <box style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}>
          {submitPage ? (
            <>
              <text content="Review complete" fg={theme.fg} bg={theme.popupBg} />
              {request.questions.map((item, index) => {
                const answer = request.answers.get(item.id);
                return (
                  <box key={item.id} style={{ flexDirection: "row", width: "100%", flexShrink: 0 }}>
                    <box style={{ width: 2, flexShrink: 0 }}>
                      <text content={answer ? "✓ " : "○ "} fg={answer ? theme.success : theme.warn} bg={theme.popupBg} />
                    </box>
                    <text
                      content={`${item.label ?? `Q${index + 1}`}: ${answer ? (answer.custom ? "custom answer entered" : answer.label) : "unanswered"}`}
                      fg={answer ? theme.fg : theme.warn}
                      bg={theme.popupBg}
                      wrapMode="word"
                      style={{ flexGrow: 1, minWidth: 0 }}
                    />
                  </box>
                );
              })}
              <text
                content={answered === request.questions.length ? "Press Enter to submit." : "Answer every question before submission."}
                fg={answered === request.questions.length ? theme.success : theme.warn}
                bg={theme.popupBg}
                wrapMode="word"
                style={{ marginTop: 1 }}
              />
            </>
          ) : question ? (
            <>
              <text content={question.prompt} fg={theme.fg} bg={theme.popupBg} wrapMode="word" />
              <box style={{ height: 1, flexShrink: 0 }} />
              {question.options.map((option, index) => {
                const active = selected === index;
                return (
                  <box
                    id={`questionnaire-option-${index}`}
                    key={`${option.value}:${index}`}
                    style={{
                      flexDirection: "column",
                      width: "100%",
                      flexShrink: 0,
                      backgroundColor: active ? theme.selectionBg : theme.popupBg,
                    }}
                  >
                    <text
                      content={`${active ? "› " : "  "}${option.label}`}
                      fg={active ? theme.accent : theme.fg}
                      bg={active ? theme.selectionBg : theme.popupBg}
                      wrapMode="word"
                    />
                    {option.description ? (
                      <text
                        content={`  ${option.description}`}
                        fg={theme.dim}
                        bg={active ? theme.selectionBg : theme.popupBg}
                        wrapMode="word"
                      />
                    ) : null}
                  </box>
                );
              })}
              <box
                id={`questionnaire-option-${question.options.length}`}
                style={{
                  flexDirection: "column",
                  width: "100%",
                  flexShrink: 0,
                  backgroundColor: selected === question.options.length ? theme.selectionBg : theme.popupBg,
                }}
              >
                <text
                  content={`${selected === question.options.length ? "› " : "  "}Custom answer`}
                  fg={selected === question.options.length ? theme.accent : theme.fg}
                  bg={selected === question.options.length ? theme.selectionBg : theme.popupBg}
                />
              </box>
              {request.customInput ? (
                <box style={{ flexDirection: "column", width: "100%", flexShrink: 0, marginTop: 1 }}>
                  <text content="Your answer" fg={theme.dim} bg={theme.popupBg} />
                  <textarea
                    ref={inputRef}
                    focused
                    placeholder="Type a custom answer…"
                    placeholderColor={theme.dim}
                    textColor={theme.fg}
                    cursorColor={theme.accent}
                    selectionBg={theme.selectionBg}
                    wrapMode="char"
                    style={{ width: "100%", height: Math.min(4, Math.max(1, terminalHeight - 8)), flexShrink: 0 }}
                  />
                </box>
              ) : null}
            </>
          ) : null}
        </box>
      </scrollbox>

      {!geometry.compact ? (
        <text
          content={request.customInput
            ? "Enter save   Esc back"
            : request.questions.length > 1
              ? "←→/Tab question   ↑↓ option   Enter select   Esc cancel"
              : "↑↓ option   Enter select   Esc cancel"}
          fg={theme.dim}
          bg={theme.popupBg}
          wrapMode="none"
          style={{ height: 1, flexShrink: 0 }}
        />
      ) : null}
    </box>
  );
}

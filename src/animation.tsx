import {
  StyledText,
  bg,
  fg,
  type MarkdownRenderable,
  type RGBA,
  type TextChunk,
  type TextRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { mix, rgba } from "./theme";
import type { WorkingRuleAnimationMode } from "./settings";

/** A colour sweep quantised to 256 colours reads as flicker, not motion. */
export function supportsTrueColor(): boolean {
  const v = process.env.COLORTERM;
  return v === "truecolor" || v === "24bit";
}

export const PULSE = "▁▂▃▄▅▆▇▆▅▄▃▂".split("");
const PULSE_MS = 70;

// "Brisk": the shimmer head travels ~28 characters a second. Motion is derived
// from elapsed time, so it looks the same whatever the renderer's frame rate is.
const SHIMMER_CHARS_PER_MS = 0.028;
const SHIMMER_WIDTH = 7;
/** Longest run the sweep covers, so a growing answer costs a fixed amount. */
const SHIMMER_TAIL = 120;

const CARET = "▊";
/**
 * Same display width as the caret, so blinking never changes layout.
 * Braille blank is not whitespace, so it cannot turn a partial `#` into a
 * Markdown heading when the caret blinks off.
 */
export const CARET_PLACEHOLDER = "\u2800";
const CARET_PERIOD_MS = 900;

const RULE_CHARS_PER_MS = 0.08;
const RULE_HIGHLIGHT_WIDTH = 10;

export type WorkingRuleRole = "headerTop" | "headerBottom" | "inputTop" | "inputBottom";
export type CoordinatedRuleState = {
  head: number;
  direction: 1 | -1;
  pair: "input" | "header";
};

const isInputRule = (role: WorkingRuleRole) => role === "inputTop" || role === "inputBottom";

/**
 * Route one wave around the two rule pairs. Each half-cycle has enough time for
 * the head to traverse the full terminal width at the original rule speed.
 */
export function coordinatedRuleState(
  width: number,
  elapsedMs: number,
  cycleWidth = width,
): CoordinatedRuleState {
  const safeWidth = Math.max(1, width);
  const safeCycleWidth = Math.max(1, cycleWidth);
  const halfCycleMs = Math.max(1, safeCycleWidth - 1) / RULE_CHARS_PER_MS;
  const cycleElapsed = ((elapsedMs % (halfCycleMs * 2)) + halfCycleMs * 2) % (halfCycleMs * 2);
  const headerPhase = cycleElapsed >= halfCycleMs;
  const halfElapsed = headerPhase ? cycleElapsed - halfCycleMs : cycleElapsed;
  const progress = Math.min(1, halfElapsed / halfCycleMs);
  const distance = (safeWidth - 1) * progress;

  return headerPhase
    ? { head: safeWidth - 1 - distance, direction: -1, pair: "header" }
    : { head: distance, direction: 1, pair: "input" };
}

/** Return the frame state for a visible rule, or null when that rule is static. */
export function workingRuleFrameState(
  mode: WorkingRuleAnimationMode,
  role: WorkingRuleRole,
  width: number,
  elapsedMs: number,
  cycleWidth = width,
): CoordinatedRuleState | null {
  if (mode === "off" || width <= 0) return null;
  if (mode === "input-only") {
    if (!isInputRule(role)) return null;
    return {
      head: (elapsedMs * RULE_CHARS_PER_MS) % Math.max(1, width),
      direction: 1,
      pair: "input",
    };
  }

  const state = coordinatedRuleState(width, elapsedMs, cycleWidth);
  return (state.pair === "input") === isInputRule(role) ? state : null;
}

type Subscriber = (elapsedMs: number) => void;

type Clock = {
  subscribe: (cb: Subscriber) => () => void;
  workingElapsed: () => number;
  workingRuleCycleWidth: () => number;
  enabled: boolean;
};

const ClockContext = createContext<Clock>({
  subscribe: () => () => {},
  workingElapsed: () => 0,
  workingRuleCycleWidth: () => 1,
  enabled: false,
});

export const useClock = () => useContext(ClockContext);

/**
 * One frame callback for the whole app. Animated components write straight to
 * their own renderable, so no React render happens per frame. The renderer is
 * on-demand, so the clock holds it live only while something is animating.
 */
export function AnimationProvider({
  enabled,
  working = false,
  workingRuleWidth = 1,
  children,
}: {
  enabled: boolean;
  working?: boolean;
  workingRuleWidth?: number;
  children: ReactNode;
}) {
  const renderer = useRenderer();
  const subs = useRef(new Set<Subscriber>());
  const elapsed = useRef(0);
  const workingStartedAt = useRef(0);
  const workingCycleWidth = useRef(1);
  const live = useRef(false);

  useEffect(() => {
    if (working) {
      workingStartedAt.current = elapsed.current;
      workingCycleWidth.current = Math.max(1, workingRuleWidth);
    }
  }, [working]);

  useEffect(() => {
    const onFrame = async (dt: number) => {
      if (subs.current.size === 0) return;
      elapsed.current += dt;
      for (const cb of subs.current) cb(elapsed.current);
    };
    renderer.setFrameCallback(onFrame);
    return () => renderer.removeFrameCallback(onFrame);
  }, [renderer]);

  const subscribe = useCallback(
    (cb: Subscriber) => {
      subs.current.add(cb);
      if (!live.current) {
        live.current = true;
        renderer.requestLive();
      }
      return () => {
        subs.current.delete(cb);
        if (subs.current.size === 0 && live.current) {
          live.current = false;
          renderer.dropLive();
        }
      };
    },
    [renderer],
  );

  const workingElapsed = useCallback(
    () => Math.max(0, elapsed.current - workingStartedAt.current),
    [],
  );
  const workingRuleCycleWidth = useCallback(() => workingCycleWidth.current, []);

  return (
    <ClockContext.Provider
      value={{ subscribe, workingElapsed, workingRuleCycleWidth, enabled }}
    >
      {children}
    </ClockContext.Provider>
  );
}

function shimmer(text: string, base: RGBA, hi: RGBA, elapsedMs: number): StyledText {
  const start = Math.max(0, text.length - SHIMMER_TAIL);
  const tail = text.slice(start);
  const chunks = [];
  if (start > 0) chunks.push(fg(base)(text.slice(0, start)));

  // The head runs past the end before wrapping, so there is a beat between sweeps.
  const period = tail.length + SHIMMER_WIDTH * 3;
  const head = ((elapsedMs * SHIMMER_CHARS_PER_MS) % period) - SHIMMER_WIDTH;
  for (let i = 0; i < tail.length; i++) {
    const d = Math.abs(i - head);
    const w = d < SHIMMER_WIDTH ? 1 - d / SHIMMER_WIDTH : 0;
    chunks.push(fg(w > 0 ? mix(base, hi, w * w) : base)(tail[i]!));
  }
  return new StyledText(chunks);
}

/**
 * Owns the renderable's `content` outright — pass the returned ref to a bare
 * `<text ref={...} />` and set no `content` prop, or the two will fight.
 *
 * The caret rides inside the same styled text rather than sitting in its own
 * element, so it follows the last character even when the text wraps.
 */
export function useShimmerText(opts: {
  text: string;
  color: string;
  highlight: string;
  active: boolean;
  caret?: boolean;
}) {
  const { text, color, highlight, active, caret = false } = opts;
  const ref = useRef<TextRenderable>(null);
  const { subscribe, enabled } = useClock();
  const latest = useRef(text);
  latest.current = text;

  const plain = useCallback(() => {
    if (!ref.current) return;
    const chunks = [fg(color)(latest.current)];
    if (caret) chunks.push(fg(color)(CARET));
    ref.current.content = new StyledText(chunks);
  }, [color, caret]);

  useEffect(() => {
    if (!active || !enabled) {
      plain();
      return;
    }
    const base = rgba(color);
    const hi = rgba(highlight);
    const stop = subscribe((elapsedMs) => {
      if (!ref.current) return;
      const styled = shimmer(latest.current, base, hi, elapsedMs);
      if (caret) {
        const visible = elapsedMs % CARET_PERIOD_MS < CARET_PERIOD_MS * 0.6;
        styled.chunks.push(fg(visible ? hi : base)(visible ? CARET : CARET_PLACEHOLDER));
      }
      ref.current.content = styled;
    });
    return () => {
      stop();
      plain();
    };
  }, [active, enabled, color, highlight, caret, subscribe, plain]);

  // Repaint when the text changes but nothing is animating.
  useEffect(() => {
    if (!active || !enabled) plain();
  }, [text, active, enabled, plain]);

  return ref;
}

/** Own styled text and append a width-stable blinking caret while active. */
export function useBlinkingText(opts: {
  chunks: TextChunk[];
  contentKey: string;
  caretColor: string;
  active: boolean;
}): RefObject<TextRenderable | null> {
  const { chunks, contentKey, caretColor, active } = opts;
  const ref = useRef<TextRenderable>(null);
  const { subscribe, enabled } = useClock();
  const latest = useRef(chunks);
  const caretVisible = useRef(true);
  latest.current = chunks;

  const paint = useCallback(() => {
    if (!ref.current) return;
    const caret = caretVisible.current ? CARET : CARET_PLACEHOLDER;
    ref.current.content = new StyledText([...latest.current, fg(caretColor)(caret)]);
  }, [caretColor]);

  useEffect(() => {
    if (!active) return;
    if (!enabled) {
      caretVisible.current = true;
      paint();
      return;
    }

    let lastVisible = caretVisible.current;
    const stop = subscribe((elapsedMs) => {
      const nextVisible = elapsedMs % CARET_PERIOD_MS < CARET_PERIOD_MS * 0.6;
      if (nextVisible === lastVisible) return;
      lastVisible = nextVisible;
      caretVisible.current = nextVisible;
      paint();
    });
    paint();
    return stop;
  }, [active, enabled, paint, subscribe]);

  useEffect(() => {
    if (active) paint();
  }, [contentKey, active, paint]);

  return ref;
}

/** Append a stable caret without scheduling Markdown-only source changes. */
export function markdownCaretContent(text: string): string {
  return text + CARET;
}

export type MarkdownCaretBinding = {
  ref: RefObject<MarkdownRenderable | null>;
  content: string;
};

/** Keep a stable caret at the end of incrementally rendered Markdown. */
export function useMarkdownCaret(
  text: string,
  active: boolean,
): MarkdownCaretBinding {
  const ref = useRef<MarkdownRenderable>(null);

  // A blink would assign MarkdownRenderable.content twice per period. Each
  // assignment starts another incremental parse and asynchronous highlight.
  // Slow terminals can draw the source markers between those highlight passes.
  return {
    ref,
    content: active ? markdownCaretContent(text) : text,
  };
}

/** A right-aligned label painted on the rule, with the rule colour behind it. */
export type WorkingRuleLabel = {
  text: string;
  width: number;
  color: string;
};

/** One label or an ordered row of them, each keeping its own foreground. */
export type WorkingRuleLabels = WorkingRuleLabel | readonly WorkingRuleLabel[] | null;

const toLabels = (labels: WorkingRuleLabels): readonly WorkingRuleLabel[] => {
  if (!labels) return [];
  return Array.isArray(labels)
    ? (labels as readonly WorkingRuleLabel[])
    : [labels as WorkingRuleLabel];
};

const labelSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Highlight strength at one column, 0 when the sweep head is far away. */
type RuleStrength = (column: number) => number;

const STATIC_STRENGTH: RuleStrength = () => 0;

const linearStrength = (head: number): RuleStrength => (column) => {
  const distance = Math.abs(column - head);
  return distance < RULE_HIGHLIGHT_WIDTH ? 1 - distance / RULE_HIGHLIGHT_WIDTH : 0;
};

/** The original input-rule sweep, including its wrapped highlight tail. */
const wrappedStrength = (head: number, width: number): RuleStrength => (column) => {
  const clockwise = (head - column + width) % width;
  const counterclockwise = (column - head + width) % width;
  const distance = Math.min(clockwise, counterclockwise);
  return distance < RULE_HIGHLIGHT_WIDTH ? 1 - distance / RULE_HIGHLIGHT_WIDTH : 0;
};

/**
 * One rule row. The labels sit at the right end as a group and take the swept
 * rule colour as their background, so the whole row animates as a single wave.
 */
export function ruleText(
  width: number,
  base: RGBA,
  hi: RGBA,
  strength: RuleStrength,
  labels: WorkingRuleLabels = null,
): StyledText {
  const swept = (column: number) => {
    const value = strength(column);
    return value > 0 ? mix(base, hi, value * 0.8) : base;
  };
  const list = toLabels(labels);
  const labelWidth = Math.min(
    list.reduce((total, label) => total + Math.max(0, label.width), 0),
    width,
  );
  const ruleColumns = Math.max(0, width - labelWidth);
  const chunks: TextChunk[] = [];
  for (let column = 0; column < ruleColumns; column++) chunks.push(fg(swept(column))("─"));

  let column = ruleColumns;
  paint: for (const label of list) {
    for (const { segment } of labelSegmenter.segment(label.text)) {
      const segmentWidth = Bun.stringWidth(segment);
      // Never split a grapheme across the right edge, even mid-label.
      if (column + segmentWidth > width) break paint;
      chunks.push(bg(swept(column))(fg(label.color)(segment)));
      column += segmentWidth;
    }
  }
  // A clipped grapheme can leave the row short. Finish it with plain rule.
  for (; column < width; column++) chunks.push(fg(swept(column))("─"));
  return new StyledText(chunks);
}

/** Paint one rule from the shared frame clock without per-frame React state. */
export function useWorkingRule(opts: {
  width: number;
  color: string;
  highlight: string;
  active: boolean;
  mode: WorkingRuleAnimationMode;
  role: WorkingRuleRole;
  /** Optional right-aligned labels painted on the rule colour, left to right. */
  label?: WorkingRuleLabels;
}): RefObject<TextRenderable | null> {
  const { width, color, highlight, active, mode, role, label = null } = opts;
  const ref = useRef<TextRenderable>(null);
  const { subscribe, workingElapsed, workingRuleCycleWidth, enabled } = useClock();
  // The only dependency-array proxy for the labels, so it has to cover them all.
  const labelKey = toLabels(label)
    .map((one) => `${one.text}|${one.width}|${one.color}`)
    .join("\u0000");

  const plain = useCallback(() => {
    if (ref.current) ref.current.content = ruleText(width, rgba(color), rgba(color), STATIC_STRENGTH, label);
    // The base and highlight are the same colour here, so nothing is swept.
  }, [color, width, labelKey]);

  useEffect(() => {
    const canAnimate = mode === "coordinated" || (mode === "input-only" && isInputRule(role));
    if (!active || !enabled || width <= 0 || !canAnimate) {
      plain();
      return;
    }

    const base = rgba(color);
    const hi = rgba(highlight);
    return subscribe(() => {
      if (!ref.current) return;
      const state = workingRuleFrameState(
        mode,
        role,
        width,
        workingElapsed(),
        workingRuleCycleWidth(),
      );
      if (!state) {
        ref.current.content = ruleText(width, base, base, STATIC_STRENGTH, label);
        return;
      }
      ref.current.content = ruleText(
        width,
        base,
        hi,
        mode === "input-only" ? wrappedStrength(state.head, width) : linearStrength(state.head),
        label,
      );
    });
  }, [
    active,
    enabled,
    mode,
    role,
    width,
    color,
    highlight,
    labelKey,
    plain,
    subscribe,
    workingElapsed,
    workingRuleCycleWidth,
  ]);

  useEffect(() => {
    if (!active || !enabled || mode === "off") plain();
  }, [width, color, active, enabled, mode, plain]);

  return ref;
}

/** Pulse-bar frame, or a static dot when animation is off. */
export function useSpinner(active: boolean): RefObject<TextRenderable | null> {
  const ref = useRef<TextRenderable>(null);
  const { subscribe, enabled } = useClock();

  useEffect(() => {
    if (!active) {
      if (ref.current) ref.current.content = " ";
      return;
    }
    if (!enabled) {
      if (ref.current) ref.current.content = "•";
      return;
    }
    return subscribe((elapsedMs) => {
      if (ref.current) ref.current.content = PULSE[Math.floor(elapsedMs / PULSE_MS) % PULSE.length]!;
    });
  }, [active, enabled, subscribe]);

  return ref;
}

import {
  StyledText,
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

export type WorkingRuleRole = "header" | "inputTop" | "inputBottom";
export type CoordinatedRuleState = {
  activeRole: "header" | "inputBottom";
  head: number;
  direction: -1 | 1;
};

/** Shared elapsed time makes the bottom and header rules one continuous route. */
export function coordinatedRuleState(width: number, elapsedMs: number): CoordinatedRuleState {
  const safeWidth = Math.max(1, width);
  const route = safeWidth * 2;
  const position = (elapsedMs * RULE_CHARS_PER_MS) % route;
  if (position < safeWidth) {
    return { activeRole: "inputBottom", head: position, direction: 1 };
  }
  return { activeRole: "header", head: route - position - 1, direction: -1 };
}

type Subscriber = (elapsedMs: number) => void;

type Clock = { subscribe: (cb: Subscriber) => () => void; enabled: boolean };

const ClockContext = createContext<Clock>({ subscribe: () => () => {}, enabled: false });

export const useClock = () => useContext(ClockContext);

/**
 * One frame callback for the whole app. Animated components write straight to
 * their own renderable, so no React render happens per frame. The renderer is
 * on-demand, so the clock holds it live only while something is animating.
 */
export function AnimationProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const renderer = useRenderer();
  const subs = useRef(new Set<Subscriber>());
  const elapsed = useRef(0);
  const live = useRef(false);

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

  return <ClockContext.Provider value={{ subscribe, enabled }}>{children}</ClockContext.Provider>;
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

/** Keep both caret frames equivalent to the Markdown parser. */
export function markdownCaretContent(text: string, visible: boolean): string {
  return text + (visible ? CARET : CARET_PLACEHOLDER);
}

/** Keep a blinking caret at the end of incrementally rendered Markdown. */
export function useMarkdownCaret(
  text: string,
  active: boolean,
): RefObject<MarkdownRenderable | null> {
  const ref = useRef<MarkdownRenderable>(null);
  const { subscribe, enabled } = useClock();
  const latest = useRef(text);
  const caretVisible = useRef(true);
  latest.current = text;

  const paint = useCallback(() => {
    if (ref.current) {
      ref.current.content = markdownCaretContent(latest.current, caretVisible.current);
    }
  }, []);

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
  }, [text, active, paint]);

  return ref;
}

function ruleText(width: number, base: RGBA, hi: RGBA, head: number): StyledText {
  const chunks = [];
  for (let i = 0; i < width; i++) {
    const distance = Math.abs(i - head);
    const strength = distance < RULE_HIGHLIGHT_WIDTH
      ? 1 - distance / RULE_HIGHLIGHT_WIDTH
      : 0;
    chunks.push(fg(strength > 0 ? mix(base, hi, strength * 0.8) : base)("─"));
  }
  return new StyledText(chunks);
}

/** Preserve the original input-rule sweep, including its wrapped highlight tail. */
function inputRuleText(width: number, base: RGBA, hi: RGBA, head: number): StyledText {
  const chunks = [];
  for (let i = 0; i < width; i++) {
    const clockwise = (head - i + width) % width;
    const counterclockwise = (i - head + width) % width;
    const distance = Math.min(clockwise, counterclockwise);
    const strength = distance < RULE_HIGHLIGHT_WIDTH
      ? 1 - distance / RULE_HIGHLIGHT_WIDTH
      : 0;
    chunks.push(fg(strength > 0 ? mix(base, hi, strength * 0.8) : base)("─"));
  }
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
}): RefObject<TextRenderable | null> {
  const { width, color, highlight, active, mode, role } = opts;
  const ref = useRef<TextRenderable>(null);
  const { subscribe, enabled } = useClock();

  const plain = useCallback(() => {
    if (ref.current) ref.current.content = new StyledText([fg(color)("─".repeat(width))]);
  }, [color, width]);

  useEffect(() => {
    const animatesInput = mode === "input-only" && role !== "header";
    const animatesCoordinated = mode === "coordinated" && role !== "inputTop";
    if (!active || !enabled || mode === "off" || width <= 0 || (!animatesInput && !animatesCoordinated)) {
      plain();
      return;
    }

    const base = rgba(color);
    const hi = rgba(highlight);
    return subscribe((elapsedMs) => {
      if (!ref.current) return;
      if (mode === "input-only") {
        const head = (elapsedMs * RULE_CHARS_PER_MS) % width;
        ref.current.content = inputRuleText(width, base, hi, head);
        return;
      }

      const state = coordinatedRuleState(width, elapsedMs);
      ref.current.content = state.activeRole === role
        ? ruleText(width, base, hi, state.head)
        : new StyledText([fg(color)("─".repeat(width))]);
    });
  }, [active, enabled, mode, role, width, color, highlight, plain, subscribe]);

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

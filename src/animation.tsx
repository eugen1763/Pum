import { StyledText, fg, type RGBA, type TextRenderable } from "@opentui/core";
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
const CARET_PERIOD_MS = 900;

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
    if (ref.current) ref.current.content = new StyledText([fg(color)(latest.current)]);
  }, [color]);

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
      if (caret && elapsedMs % CARET_PERIOD_MS < CARET_PERIOD_MS * 0.6) {
        styled.chunks.push(fg(hi)(CARET));
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

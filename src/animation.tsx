import {
  StyledText,
  bg,
  fg,
  type MarkdownRenderable,
  type RGBA,
  type TextChunk,
  type TextareaRenderable,
  type TextRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { mixLight, rgba } from "./theme";
import type { WorkingRuleAnimationMode } from "./settings";

/** A colour sweep quantised to 256 colours reads as flicker, not motion. */
export function supportsTrueColor(): boolean {
  const v = process.env.COLORTERM;
  return v === "truecolor" || v === "24bit";
}

export const PULSE_LEVELS = "▁▂▃▄▅▆▇█".split("");
export const PULSE_PERIOD_MS = 840;

/**
 * The pulse height rides a cosine rather than a frame counter, so it slows at
 * the top and the bottom of the swing instead of stepping at a constant rate.
 */
export function pulseGlyph(elapsedMs: number): string {
  const phase = ((elapsedMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  const height = (1 - Math.cos((phase / PULSE_PERIOD_MS) * 2 * Math.PI)) / 2;
  const level = Math.min(PULSE_LEVELS.length - 1, Math.floor(height * PULSE_LEVELS.length));
  return PULSE_LEVELS[level]!;
}

// "Brisk": the shimmer head travels ~28 characters a second. Motion is derived
// from elapsed time, so it looks the same whatever the renderer's frame rate is.
const SHIMMER_CHARS_PER_MS = 0.028;
const SHIMMER_WIDTH = 7;
/** Longest run the sweep covers, so a growing answer costs a fixed amount. */
const SHIMMER_TAIL = 120;

const CARET = "▊";
export const CARET_PERIOD_MS = 1_800;
/** Ramp length at each end of the caret's cycle, as a share of the period. */
const CARET_RAMP = 0.12;
/** Quantised fade steps, so one ramp costs a bounded number of repaints. */
export const CARET_FADE_STEPS = 16;

/** Smoothstep by cosine: flat at both ends, so neither end shows a corner. */
const ease = (t: number) => (1 - Math.cos(Math.max(0, Math.min(1, t)) * Math.PI)) / 2;

/**
 * The caret dissolves into the background instead of switching off. The block
 * glyph stays in place for the whole cycle, so the row's width never changes
 * and no glyph swap can rewrite the text underneath it.
 */
export function caretAlpha(elapsedMs: number): number {
  const phase = (((elapsedMs % CARET_PERIOD_MS) + CARET_PERIOD_MS) % CARET_PERIOD_MS)
    / CARET_PERIOD_MS;
  const lit = 0.6;
  if (phase < CARET_RAMP) return ease(phase / CARET_RAMP);
  if (phase < lit) return 1;
  if (phase < lit + CARET_RAMP) return ease(1 - (phase - lit) / CARET_RAMP);
  return 0;
}

/**
 * How far a lit cell carries after the head has passed it.
 *
 * A terminal cell is enormous next to the thing being animated, so motion on
 * this grid reads as stepping unless every cell keeps a fading wake. Decay is
 * per millisecond rather than per frame, so the wake is the same length
 * whatever rate the renderer runs at.
 */
export const TRAIL_HALF_LIFE_MS = 90;
/** Below this a trailing cell can no longer tint an eight-bit channel. */
const TRAIL_FLOOR = 1 / 255;

export function decayTrail(previous: number, current: number, deltaMs: number): number {
  // A negative step means the working clock restarted. Drop the old wake.
  if (deltaMs < 0) return current;
  if (deltaMs === 0) return Math.max(previous, current);
  const faded = previous * 0.5 ** (deltaMs / TRAIL_HALF_LIFE_MS);
  return Math.max(current, faded < TRAIL_FLOOR ? 0 : faded);
}

/**
 * Raised-cosine falloff. A linear ramp holds one slope from head to tail, so
 * the eye reads a sliding wedge with a corner on it. Flattening at the peak
 * and again at the edge turns the same motion into a glow.
 */
export function glowFalloff(distance: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const spread = Math.abs(distance) / radius;
  if (spread >= 1) return 0;
  return (Math.cos(spread * Math.PI) + 1) / 2;
}

/** Where the ramp reaches the highlight and starts blooming past it. */
export const GLOW_KNEE = 0.85;
/**
 * Strength is shaped before it becomes colour. Blending in linear light makes
 * even a two-percent wake visible, which left every trail smeared across the
 * whole rule; this keeps a faint cell faint without a cutoff to pop at.
 */
const GLOW_SHAPE = 1.8;
const WHITE = rgba("#ffffff");

/** The hot core of a sweep: the highlight lifted towards white. */
export function bloomColor(highlight: RGBA): RGBA {
  return mixLight(highlight, WHITE, 0.45);
}

/**
 * Base up to the knee, then a hot core above it. Two stops rather than one
 * give the head somewhere brighter to go than the plain highlight colour.
 */
export function glowColor(base: RGBA, highlight: RGBA, bloom: RGBA, strength: number): RGBA {
  if (strength <= 0) return base;
  if (strength >= 1) return bloom;
  return strength >= GLOW_KNEE
    ? mixLight(highlight, bloom, (strength - GLOW_KNEE) / (1 - GLOW_KNEE))
    : mixLight(base, highlight, (strength / GLOW_KNEE) ** GLOW_SHAPE);
}

/** Weight is a second channel: the core of a sweep draws a heavier rule. */
const HEAVY_RULE_STRENGTH = 0.62;
export function weightedGlyph(glyph: string, strength: number): string {
  return glyph === "\u2500" && strength >= HEAVY_RULE_STRENGTH ? "\u2501" : glyph;
}

const RULE_CHARS_PER_MS = 0.04;
const RULE_HIGHLIGHT_WIDTH = 10;
const COMET_CHARS_PER_MS = 0.035;
const ELECTRIC_FRAME_MS = 140;
const CONSTELLATION_SPACING = 13;
const RANDOM_CONSTELLATION_CYCLE_MS = 2000;
/** How much of one cycle a single sparkle burns for, start to finish. */
const RANDOM_CONSTELLATION_LIFETIME = 0.5;
const CONSTELLATION_HALO = 0.34;
const ENERGY_CYCLE_MS = 3600;

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

  // A fresh object here would be a changed context value on every render of the
  // app, and React answers that by walking the whole tree below the provider to
  // find consumers. With a long transcript that walk is the largest part of the
  // cost of one keystroke, so the value keeps its identity while its parts do.
  const clock = useMemo(
    () => ({ subscribe, workingElapsed, workingRuleCycleWidth, enabled }),
    [subscribe, workingElapsed, workingRuleCycleWidth, enabled],
  );

  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

/** Exported for the test that guards the run-coalescing loop below. */
export function shimmer(text: string, base: RGBA, hi: RGBA, elapsedMs: number): StyledText {
  const start = Math.max(0, text.length - SHIMMER_TAIL);
  const tail = text.slice(start);
  const bloom = bloomColor(hi);
  const chunks: TextChunk[] = [];
  if (start > 0) chunks.push(fg(base)(text.slice(0, start)));

  // The head runs past the end before wrapping, so there is a beat between sweeps.
  const period = tail.length + SHIMMER_WIDTH * 3;
  const head = ((elapsedMs * SHIMMER_CHARS_PER_MS) % period) - SHIMMER_WIDTH;
  // Everything outside the head is one colour, so it is also one chunk.
  let runColor: RGBA | null = null;
  let runText = "";
  for (let i = 0; i < tail.length; i++) {
    const color = glowColor(base, hi, bloom, glowFalloff(i - head, SHIMMER_WIDTH));
    if (runColor && sameColor(runColor, color)) runText += tail[i]!;
    else {
      if (runColor && runText) chunks.push(fg(runColor)(runText));
      runColor = color;
      runText = tail[i]!;
    }
  }
  if (runColor && runText) chunks.push(fg(runColor)(runText));
  return new StyledText(chunks);
}

/**
 * True raised forms, and only those.
 *
 * A terminal cell grid has no half-row offset, so a letter cannot be drawn
 * between two rows. These modifier letters are the same letter cut higher in
 * the cell, which is as close as the grid allows. The map holds no lookalike
 * substitutes: a letter with no raised form of its own — uppercase F, digits,
 * punctuation — is left exactly as it is rather than replaced by a glyph that
 * reads as a different character.
 */
const RAISED_LETTERS: Record<string, string> = {
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ",
  k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ",
  v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ",
  M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
};

/** How long one crest takes to cross the phrase, and the rest between sweeps. */
const WAVE_CHARS_PER_MS = 0.011;
const WAVE_WIDTH = 5;
const WAVE_REST_CHARS = 90;

/**
 * One bright crest travelling across the first `crestEnd` characters, with a
 * long rest between sweeps. The remainder — the steer hint — never moves, so
 * it keeps reading as a fixed note rather than as part of the motion.
 */
export function placeholderWave(
  text: string,
  crestEnd: number,
  base: RGBA,
  hi: RGBA,
  elapsedMs: number,
  lift = true,
): StyledText {
  const characters = Array.from(text);
  const crest = Math.max(0, Math.min(crestEnd, characters.length));
  const bloom = bloomColor(hi);
  const period = crest + WAVE_REST_CHARS;
  const head = ((elapsedMs * WAVE_CHARS_PER_MS) % period) - WAVE_WIDTH;
  // Exactly one letter rides the top of the crest. A strength threshold would
  // lift two or three at once, or none at all between cells.
  const peak = Math.round(head);
  const chunks: TextChunk[] = [];
  let runColor: RGBA | null = null;
  let runText = "";
  const flush = () => {
    if (runColor && runText) chunks.push(fg(runColor)(runText));
    runText = "";
  };

  for (let index = 0; index < crest; index++) {
    const strength = glowFalloff(index - head, WAVE_WIDTH);
    const color = glowColor(base, hi, bloom, strength);
    const raised = lift && index === peak ? RAISED_LETTERS[characters[index]!] : undefined;
    const glyph = raised ?? characters[index]!;
    if (runColor && sameColor(runColor, color) && !raised) {
      runText += glyph;
      continue;
    }
    flush();
    runColor = color;
    runText = glyph;
    // A raised cell is one cell wide and never merges with its neighbours.
    if (raised) {
      flush();
      runColor = null;
    }
  }
  flush();
  if (crest < characters.length) {
    chunks.push(fg(base)(characters.slice(crest).join("")));
  }
  return new StyledText(chunks);
}

/**
 * Animates a textarea placeholder in place.
 *
 * The textarea accepts StyledText for its placeholder, so the wave needs no
 * overlay element. React keeps passing the plain string, which is what shows
 * whenever the wave is inactive — with animations off, or without true colour,
 * the placeholder is exactly the one PUM has always drawn.
 */
export function usePlaceholderWave(opts: {
  inputRef: RefObject<TextareaRenderable | null>;
  text: string;
  crestEnd: number;
  color: string;
  highlight: string;
  active: boolean;
  lift?: boolean;
}) {
  const { inputRef, text, crestEnd, color, highlight, active, lift = true } = opts;
  const { subscribe, enabled } = useClock();
  const latest = useRef({ text, crestEnd });
  latest.current = { text, crestEnd };

  useEffect(() => {
    if (!active || !enabled) {
      if (inputRef.current) inputRef.current.placeholder = text;
      return;
    }
    const base = rgba(color);
    const hi = rgba(highlight);
    const stop = subscribe((elapsedMs) => {
      if (!inputRef.current) return;
      inputRef.current.placeholder = placeholderWave(
        latest.current.text,
        latest.current.crestEnd,
        base,
        hi,
        elapsedMs,
        lift,
      );
    });
    return () => {
      stop();
      // Hand the plain string back, or the last frame would stay frozen on it.
      if (inputRef.current) inputRef.current.placeholder = latest.current.text;
    };
  }, [inputRef, text, active, enabled, color, highlight, lift, subscribe]);
}

/**
 * The clock provider sits below App, so the wave runs from a child that draws
 * nothing and only owns the placeholder of the textarea it is given.
 */
export function PlaceholderWave(props: Parameters<typeof usePlaceholderWave>[0]): null {
  usePlaceholderWave(props);
  return null;
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
  /** What the caret dissolves into between blinks. */
  background: string;
  active: boolean;
  caret?: boolean;
}) {
  const { text, color, highlight, background, active, caret = false } = opts;
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
    const behind = rgba(background);
    const stop = subscribe((elapsedMs) => {
      if (!ref.current) return;
      const styled = shimmer(latest.current, base, hi, elapsedMs);
      if (caret) styled.chunks.push(fg(mixLight(behind, hi, caretAlpha(elapsedMs)))(CARET));
      ref.current.content = styled;
    });
    return () => {
      stop();
      plain();
    };
  }, [active, enabled, color, highlight, background, caret, subscribe, plain]);

  // Repaint when the text changes but nothing is animating.
  useEffect(() => {
    if (!active || !enabled) plain();
  }, [text, active, enabled, plain]);

  return ref;
}

/** Own styled text and append a width-stable fading caret while active. */
export function useBlinkingText(opts: {
  chunks: TextChunk[];
  contentKey: string;
  caretColor: string;
  /** What the caret dissolves into between blinks. */
  background: string;
  active: boolean;
}): RefObject<TextRenderable | null> {
  const { chunks, contentKey, caretColor, background, active } = opts;
  const ref = useRef<TextRenderable>(null);
  const { subscribe, enabled } = useClock();
  const latest = useRef(chunks);
  const caretStep = useRef(CARET_FADE_STEPS);
  latest.current = chunks;

  // Parsing two colour strings a repaint is wasted work on a hot path.
  const behind = useMemo(() => rgba(background), [background]);
  const lit = useMemo(() => rgba(caretColor), [caretColor]);

  const paint = useCallback(() => {
    if (!ref.current) return;
    const color = mixLight(behind, lit, caretStep.current / CARET_FADE_STEPS);
    ref.current.content = new StyledText([...latest.current, fg(color)(CARET)]);
  }, [behind, lit]);

  useEffect(() => {
    if (!active) return;
    if (!enabled) {
      caretStep.current = CARET_FADE_STEPS;
      paint();
      return;
    }

    // Repaint on a quantised step rather than every frame: the fade is only
    // worth as many repaints as the eye can tell apart.
    const stop = subscribe((elapsedMs) => {
      const step = Math.round(caretAlpha(elapsedMs) * CARET_FADE_STEPS);
      if (step === caretStep.current) return;
      caretStep.current = step;
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
type RuleGlyph = (column: number) => string;

export type WorkingRuleCell = {
  strength: number;
  glyph: string;
};

const STATIC_STRENGTH: RuleStrength = () => 0;
const STATIC_GLYPH: RuleGlyph = () => "─";

const clampStrength = (value: number) => Math.max(0, Math.min(1, value));

/** A trapezoid envelope with eased shoulders, for cross-fading two beats. */
const window = (
  value: number,
  riseFrom: number,
  riseTo: number,
  fallFrom: number,
  fallTo: number,
) => {
  if (value <= riseFrom || value >= fallTo) return 0;
  if (value < riseTo) return ease((value - riseFrom) / (riseTo - riseFrom));
  if (value <= fallFrom) return 1;
  return ease(1 - (value - fallFrom) / (fallTo - fallFrom));
};

const roleSeed = (role: WorkingRuleRole) => {
  switch (role) {
    case "headerTop": return 1;
    case "headerBottom": return 2;
    case "inputTop": return 3;
    case "inputBottom": return 4;
  }
};

const hashPosition = (frame: number, seed: number, width: number) => {
  if (width <= 1) return 0;
  let value = Math.imul(frame + 1, 1103515245) ^ Math.imul(seed + 17, 12345);
  value ^= value >>> 16;
  return Math.abs(value) % width;
};

/** Choose stable, random-looking sparkle centers for one two-second cycle. */
export function randomConstellationCenters(
  width: number,
  cycle: number,
  role: WorkingRuleRole,
): number[] {
  if (width <= 0) return [];
  if (width < 3) return [Math.floor((width - 1) / 2)];
  const wanted = Math.max(1, Math.floor(width / 18));
  const centers: number[] = [];
  const seed = roleSeed(role);
  for (let attempt = 0; attempt < wanted * 8 && centers.length < wanted; attempt++) {
    const candidate = 1 + hashPosition(cycle * 37 + attempt, seed * 41 + attempt, width - 2);
    if (centers.every((center) => Math.abs(center - candidate) > 3)) centers.push(candidate);
  }
  return centers.sort((a, b) => a - b);
}

/**
 * Where in the cycle one sparkle wakes up, as a share of the cycle.
 *
 * Every sparkle used to ride the cycle's own fade, so a whole constellation
 * lit and died on the same beat. Each one now gets its own start, and each
 * burns for `RANDOM_CONSTELLATION_LIFETIME` and is gone before the cycle ends,
 * so nothing is cut off when the next cycle picks fresh positions.
 */
export function randomConstellationStart(
  center: number,
  cycle: number,
  role: WorkingRuleRole,
): number {
  const spread = 1 - RANDOM_CONSTELLATION_LIFETIME;
  return (hashPosition(cycle * 53 + center, roleSeed(role) * 19 + center, 1000) / 1000) * spread;
}

const linearStrength = (head: number): RuleStrength => (column) =>
  glowFalloff(column - head, RULE_HIGHLIGHT_WIDTH);

/** The original input-rule sweep, including its wrapped highlight tail. */
const wrappedStrength = (head: number, width: number): RuleStrength => (column) => {
  const clockwise = (head - column + width) % width;
  const counterclockwise = (column - head + width) % width;
  return glowFalloff(Math.min(clockwise, counterclockwise), RULE_HIGHLIGHT_WIDTH);
};

/** Return one animated rule cell for all selectable working-rule modes. */
export function workingRuleCell(
  mode: WorkingRuleAnimationMode,
  role: WorkingRuleRole,
  width: number,
  elapsedMs: number,
  column: number,
  cycleWidth = width,
): WorkingRuleCell {
  if (mode === "off" || width <= 0 || column < 0 || column >= width) {
    return { strength: 0, glyph: "─" };
  }

  if (mode === "input-only" || mode === "coordinated") {
    const state = workingRuleFrameState(mode, role, width, elapsedMs, cycleWidth);
    if (!state) return { strength: 0, glyph: "─" };
    const strength = mode === "input-only"
      ? wrappedStrength(state.head, width)(column)
      : linearStrength(state.head)(column);
    return { strength, glyph: "─" };
  }

  if (mode === "comet-pair") {
    const travel = (elapsedMs * COMET_CHARS_PER_MS) % Math.max(1, width);
    const heads = [travel, width - 1 - travel];
    const distance = Math.min(...heads.map((head) => Math.abs(column - head)));
    return { strength: glowFalloff(distance, RULE_HIGHLIGHT_WIDTH), glyph: "─" };
  }

  if (mode === "electric-spark") {
    const frame = Math.floor(elapsedMs / ELECTRIC_FRAME_MS);
    const frameProgress = (elapsedMs % ELECTRIC_FRAME_MS) / ELECTRIC_FRAME_MS;
    if (frameProgress > 0.68) return { strength: 0, glyph: "─" };
    const seed = roleSeed(role);
    const primary = hashPosition(frame, seed, Math.max(1, width - 1));
    const secondary = hashPosition(frame, seed + 29, width);
    // Strike hard, then fall away on a curve. A linear decay reads as a
    // shutter closing; this one keeps the arc alive as it dies.
    const fade = ease(1 - frameProgress / 0.68);
    const primaryDistance = Math.min(Math.abs(column - primary), Math.abs(column - (primary + 1)));
    const secondaryDistance = Math.abs(column - secondary);
    const strength = Math.max(
      fade * glowFalloff(primaryDistance, 3),
      fade * 0.45 * glowFalloff(secondaryDistance, 2),
    );
    const glyph = column === primary ? "╴" : column === primary + 1 ? "╶" :
      column === secondary ? "·" : "─";
    return { strength: clampStrength(strength), glyph };
  }

  if (mode === "constellation") {
    const seed = roleSeed(role);
    const spacing = (offset: number) => (column + offset + seed * 3) % CONSTELLATION_SPACING === 0;
    // A star ends at its own cell unless it carries a halo, which is what
    // makes it bloom on the rule rather than switch on and off in place.
    const halo = spacing(1) || spacing(-1);
    if (!spacing(0) && !halo) return { strength: 0, glyph: "─" };
    const star = spacing(0) ? column : spacing(1) ? column + 1 : column - 1;
    // Stars sit thirteen columns apart, so any fixed phase step per column put
    // them all within a fifth of a radian of each other and they blinked in
    // unison. A hashed offset gives each one its own place in the cycle.
    const phase = elapsedMs / 620 + hashPosition(star, seed, 628) / 100;
    const peak = 0.12 + ((Math.sin(phase) + 1) / 2) * 0.88;
    if (!spacing(0)) return { strength: peak * CONSTELLATION_HALO, glyph: "·" };
    return { strength: peak, glyph: peak > 0.82 ? "✦" : peak > 0.48 ? "✧" : "·" };
  }

  if (mode === "random-constellation") {
    const cycle = Math.floor(elapsedMs / RANDOM_CONSTELLATION_CYCLE_MS);
    const progress = (elapsedMs % RANDOM_CONSTELLATION_CYCLE_MS) /
      RANDOM_CONSTELLATION_CYCLE_MS;
    let strength = 0;
    let glyph = "─";
    for (const center of randomConstellationCenters(width, cycle, role)) {
      const distance = Math.abs(column - center);
      if (distance > 2) continue;
      const life = (progress - randomConstellationStart(center, cycle, role))
        / RANDOM_CONSTELLATION_LIFETIME;
      if (life <= 0 || life >= 1) continue;
      // The outer ring is what gives each sparkle somewhere to bloom into.
      const lit = Math.sin(life * Math.PI) * (distance === 0 ? 1 : distance === 1 ? 0.62 : 0.24);
      if (lit <= strength) continue;
      strength = lit;
      glyph = distance === 2 || lit < 0.2 ? "·" :
        lit < 0.58 ? "✧" :
          distance === 0 ? "✦" : "✧";
    }
    return { strength, glyph };
  }

  if (mode === "energy-transfer") {
    const phase = (elapsedMs % ENERGY_CYCLE_MS) / ENERGY_CYCLE_MS;
    const center = (width - 1) / 2;
    const input = isInputRule(role);
    // The three beats overlap and cross-fade. Cutting between them left a
    // visible step at each handover, which is the one thing a wave must not do.
    let strength = 0;
    let glyph = "─";

    if (input) {
      const charge = window(phase, 0, 0.04, 0.42, 0.48);
      if (charge > 0) {
        const progress = ease(phase / 0.48);
        const leftHead = center * progress;
        const rightHead = width - 1 - center * progress;
        const charged = column <= leftHead || column >= rightHead;
        const distance = Math.min(Math.abs(column - leftHead), Math.abs(column - rightHead));
        // The glow spills past each head, so the charged wire has no hard end.
        strength = charge * Math.max(charged ? 0.22 : 0, glowFalloff(distance, 7));
      }

      const flash = window(phase, 0.42, 0.5, 0.5, 0.6);
      if (flash > 0) {
        const distance = Math.abs(column - center);
        strength = Math.max(strength, flash * glowFalloff(distance, 8));
        if (distance < 0.6 && flash > 0.35) glyph = "✦";
      }
    } else {
      const discharge = window(phase, 0.54, 0.6, 0.88, 0.94);
      if (discharge > 0) {
        const progress = ease((phase - 0.54) / 0.4);
        const heads = [center - progress * center, center + progress * center];
        const distance = Math.min(...heads.map((head) => Math.abs(column - head)));
        strength = discharge * glowFalloff(distance, RULE_HIGHLIGHT_WIDTH);
        if (distance < 0.55 && discharge > 0.35) glyph = "✧";
      }
    }

    return { strength: clampStrength(strength), glyph };
  }

  return { strength: 0, glyph: "─" };
}

/**
 * One rule row. The labels sit near the right end as a group and take the swept
 * rule colour as their background. Optional trailing rule columns stay visible.
 */
export function ruleText(
  width: number,
  base: RGBA,
  hi: RGBA,
  strength: RuleStrength,
  labels: WorkingRuleLabels = null,
  trailingRuleColumns = 0,
  glyph: RuleGlyph = STATIC_GLYPH,
): StyledText {
  const bloom = bloomColor(hi);
  const list = toLabels(labels);
  const trailingColumns = Math.max(0, Math.min(width, trailingRuleColumns));
  const labelEdge = width - trailingColumns;
  const labelWidth = Math.min(
    list.reduce((total, label) => total + Math.max(0, label.width), 0),
    labelEdge,
  );
  const ruleColumns = Math.max(0, labelEdge - labelWidth);
  const chunks: TextChunk[] = [];

  // Most of a rule is one flat colour. Emitting a chunk a column costs the
  // renderer a few hundred spans a frame for no visible gain, so equal-colour
  // columns are merged into one run and only a change flushes it.
  let runColor: RGBA | null = null;
  let runText = "";
  const flush = () => {
    if (runColor && runText) chunks.push(fg(runColor)(runText));
    runColor = null;
    runText = "";
  };
  const paintColumn = (column: number) => {
    const value = strength(column);
    const color = glowColor(base, hi, bloom, value);
    const text = weightedGlyph(glyph(column), value);
    if (runColor && sameColor(runColor, color)) runText += text;
    else {
      flush();
      runColor = color;
      runText = text;
    }
  };

  for (let column = 0; column < ruleColumns; column++) paintColumn(column);
  flush();

  let column = ruleColumns;
  paint: for (const label of list) {
    for (const { segment } of labelSegmenter.segment(label.text)) {
      const segmentWidth = Bun.stringWidth(segment);
      // Never split a grapheme across the right edge, even mid-label.
      if (column + segmentWidth > labelEdge) break paint;
      chunks.push(bg(glowColor(base, hi, bloom, strength(column)))(fg(label.color)(segment)));
      column += segmentWidth;
    }
  }
  // A clipped grapheme can leave the row short. Finish it with plain rule.
  for (; column < width; column++) paintColumn(column);
  flush();
  return new StyledText(chunks);
}

const sameColor = (a: RGBA, b: RGBA) => a === b || (a.r === b.r && a.g === b.g && a.b === b.b);

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
  /** Plain rule columns kept after the right-aligned labels. */
  trailingRuleColumns?: number;
}): RefObject<TextRenderable | null> {
  const { width, color, highlight, active, mode, role, label = null, trailingRuleColumns = 0 } = opts;
  const ref = useRef<TextRenderable>(null);
  const { subscribe, workingElapsed, workingRuleCycleWidth, enabled } = useClock();
  // The only dependency-array proxy for the labels, so it has to cover them all.
  const labelKey = toLabels(label)
    .map((one) => `${one.text}|${one.width}|${one.color}`)
    .join("\u0000");

  const plain = useCallback(() => {
    if (ref.current) {
      ref.current.content = ruleText(
        width,
        rgba(color),
        rgba(color),
        STATIC_STRENGTH,
        label,
        trailingRuleColumns,
      );
    }
    // The base and highlight are the same colour here, so nothing is swept.
  }, [color, width, labelKey, trailingRuleColumns]);

  useEffect(() => {
    const canAnimate = mode !== "off" && (mode !== "input-only" || isInputRule(role));
    if (!active || !enabled || width <= 0 || !canAnimate) {
      plain();
      return;
    }

    const base = rgba(color);
    const hi = rgba(highlight);
    // The wake each cell carries between frames, and the glyph it is showing.
    // Both are kept for the life of this rule, so a frame allocates neither.
    const trail = new Float64Array(width);
    const glyphs = new Array<string>(width).fill("─");
    let lastElapsedMs = -1;

    return subscribe(() => {
      if (!ref.current) return;
      const elapsedMs = workingElapsed();
      const deltaMs = lastElapsedMs < 0 ? 0 : elapsedMs - lastElapsedMs;
      lastElapsedMs = elapsedMs;
      const cycleWidth = workingRuleCycleWidth();
      for (let column = 0; column < width; column++) {
        const cell = workingRuleCell(mode, role, width, elapsedMs, column, cycleWidth);
        trail[column] = decayTrail(trail[column]!, cell.strength, deltaMs);
        glyphs[column] = cell.glyph;
      }
      ref.current.content = ruleText(
        width,
        base,
        hi,
        (column) => trail[column] ?? 0,
        label,
        trailingRuleColumns,
        (column) => glyphs[column] ?? "─",
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
    trailingRuleColumns,
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
    let last = "";
    return subscribe((elapsedMs) => {
      const glyph = pulseGlyph(elapsedMs);
      if (glyph === last) return;
      last = glyph;
      if (ref.current) ref.current.content = glyph;
    });
  }, [active, enabled, subscribe]);

  return ref;
}

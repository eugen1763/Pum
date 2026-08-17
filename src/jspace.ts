import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { companionFileFor, readCompanion, writeCompanion } from "./session-companion";

/** J-Space state stored beside one PUM session. */
export const JSPACE_SUFFIX = "jspace.json";
export const JSPACE_CONTEXT_CUSTOM_TYPE = "pum.jspace.context";

export const JSPACE_MODES = ["fast", "full", "loop"] as const;
export type JSpaceMode = (typeof JSPACE_MODES)[number];

export const JSPACE_PHASES = ["orient", "act", "verify", "recover"] as const;
export type JSpacePhase = (typeof JSPACE_PHASES)[number];

export type JSpaceCheckpoint = {
  label: string;
  at: number;
};

export type JSpaceCoverage = {
  attempted: number;
  successful: number;
  failed: number;
  lastTool?: string;
  lastResult?: "ok" | "error";
};

export type JSpaceState = {
  version: 1;
  mode: JSpaceMode;
  phase: JSpacePhase;
  turn: number;
  goal: string;
  core: string[];
  verified: string[];
  open: string[];
  next: string;
  checkpoint: JSpaceCheckpoint | null;
  coverage: JSpaceCoverage;
  updatedAt: number;
};

// Keep the ledger smaller than the user prompt it summarizes.
export const MAX_JSPACE_TEXT = 1_200;
export const MAX_JSPACE_ITEM = 180;
export const MAX_JSPACE_ITEMS = 6;

// J-Space is opt-in. PUM keeps the existing behavior unless the user enables it.
let jspaceEnabled = false;

/** Enable or disable the J-Space prompt and state layer for future turns. */
export function setJspaceEnabled(enabled: boolean): void {
  jspaceEnabled = enabled;
}

export function isJspaceEnabled(): boolean {
  return jspaceEnabled;
}

export function jspaceFileFor(sessionFile: string): string {
  return companionFileFor(sessionFile, JSPACE_SUFFIX);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : undefined;
}

function boundedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = boundedText(item, MAX_JSPACE_ITEM);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= MAX_JSPACE_ITEMS) break;
  }
  return result;
}

function validMode(value: unknown): value is JSpaceMode {
  return JSPACE_MODES.includes(value as JSpaceMode);
}

function validPhase(value: unknown): value is JSpacePhase {
  return JSPACE_PHASES.includes(value as JSpacePhase);
}

function validResult(value: unknown): value is "ok" | "error" {
  return value === "ok" || value === "error";
}

function normalizeCoverage(value: unknown): JSpaceCoverage {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const attempted = Number.isInteger(raw.attempted) && (raw.attempted as number) >= 0
    ? raw.attempted as number
    : 0;
  const successful = Number.isInteger(raw.successful) && (raw.successful as number) >= 0
    ? raw.successful as number
    : 0;
  const failed = Number.isInteger(raw.failed) && (raw.failed as number) >= 0
    ? raw.failed as number
    : 0;
  const lastTool = boundedText(raw.lastTool, 80);
  const lastResult = validResult(raw.lastResult) ? raw.lastResult : undefined;
  return {
    attempted,
    successful,
    failed,
    ...(lastTool ? { lastTool } : {}),
    ...(lastResult ? { lastResult } : {}),
  };
}

export function normalizeJspaceState(value: unknown): JSpaceState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !validMode(raw.mode) || !validPhase(raw.phase)) return null;
  const goal = boundedText(raw.goal, MAX_JSPACE_TEXT);
  const next = boundedText(raw.next, MAX_JSPACE_ITEM);
  if (!goal || !next) return null;
  const checkpointRaw = raw.checkpoint;
  let checkpoint: JSpaceCheckpoint | null = null;
  if (checkpointRaw !== null && checkpointRaw !== undefined) {
    if (!checkpointRaw || typeof checkpointRaw !== "object") return null;
    const checkpointRecord = checkpointRaw as Record<string, unknown>;
    const label = boundedText(checkpointRecord.label, MAX_JSPACE_ITEM);
    const at = checkpointRecord.at;
    if (!label || typeof at !== "number" || !Number.isSafeInteger(at)
      || Math.abs(at) > 8_640_000_000_000_000) {
      return null;
    }
    checkpoint = { label, at };
  }
  const turn = Number.isInteger(raw.turn) && (raw.turn as number) >= 0 ? raw.turn as number : 0;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
    ? raw.updatedAt
    : Date.now();
  return {
    version: 1,
    mode: raw.mode,
    phase: raw.phase,
    turn,
    goal,
    core: boundedList(raw.core),
    verified: boundedList(raw.verified),
    open: boundedList(raw.open),
    next,
    checkpoint,
    coverage: normalizeCoverage(raw.coverage),
    updatedAt,
  };
}

export function createJspaceState(now = Date.now()): JSpaceState {
  return {
    version: 1,
    mode: "full",
    phase: "orient",
    turn: 0,
    goal: "No task has started.",
    core: [],
    verified: [],
    open: [],
    next: "Choose the smallest useful next action.",
    checkpoint: null,
    coverage: { attempted: 0, successful: 0, failed: 0 },
    updatedAt: now,
  };
}

/**
 * Read the ledger, then normalize it.
 *
 * `readCompanion` returns the parsed value, not the value the predicate built,
 * so the normalizer must run on the result. A file that omits an optional field
 * passes validation, and only the normalized state has every field and every
 * bound applied.
 */
export function loadJspace(sessionFile: string | undefined): JSpaceState | null {
  const stored = readCompanion<unknown>(sessionFile, JSPACE_SUFFIX, (_value): _value is unknown => true, null);
  return normalizeJspaceState(stored);
}

export function saveJspace(sessionFile: string | undefined, state: JSpaceState | null): void {
  writeCompanion(sessionFile, JSPACE_SUFFIX, state);
}

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function continuationPrompt(prompt: string): boolean {
  return /\b(?:continue|next|retry|again|finish|resume|proceed|fix it|keep going)\b/i.test(prompt);
}

/**
 * True when a short continuation prompt carries on the previous loop task.
 *
 * The mode choice and the ledger carry-over must agree, so both read this.
 */
function loopContinuation(prompt: string, previous?: JSpaceState | null): boolean {
  const text = prompt.trim();
  return previous?.mode === "loop" && continuationPrompt(text) && text.length <= 240;
}

/** Select the smallest control mode that fits the current request. */
export function classifyJspaceMode(prompt: string, previous?: JSpaceState | null): JSpaceMode {
  if (loopContinuation(prompt, previous)) return "loop";
  const text = prompt.trim();
  const explanatory = /\b(?:explain|describe|how does|why does|understand|compare|summari[sz]e)\b/i.test(text);
  const multiStep = /\b(?:implement|build|create|fix|debug|refactor|test|migrate|investigate|analy[sz]e|repository|repo|codebase|run tests|update|change|add|remove|across|multiple)\b/i.test(text)
    || /[\\/]\w+/.test(text)
    || text.includes("\n")
    || text.length > 600;
  if (text.length <= 180 && explanatory) return "full";
  if (text.length <= 180 && !multiStep) return "fast";
  return multiStep ? "loop" : "full";
}

function extractCore(prompt: string): string[] {
  const lines = prompt
    .split(/[\n.!?]+/)
    .map((line) => compact(line, MAX_JSPACE_ITEM))
    .filter(Boolean);
  const constrained = lines.filter((line) =>
    /\b(?:must|should|required|avoid|do not|only|preserve|keep|without|within|exactly|never)\b/i.test(line),
  );
  const selected = constrained.length > 0 ? constrained : lines.slice(0, 2);
  return [...new Set(selected)].slice(0, MAX_JSPACE_ITEMS);
}

function addUnique(items: readonly string[], item: string): string[] {
  return [item, ...items.filter((value) => value !== item)].slice(0, MAX_JSPACE_ITEMS);
}

/** Start a new turn and derive a compact task ledger from the user prompt. */
export function startJspaceTurn(
  previous: JSpaceState,
  prompt: string,
  now = Date.now(),
): JSpaceState {
  const mode = classifyJspaceMode(prompt, previous);
  const continuing = loopContinuation(prompt, previous);
  return {
    ...previous,
    mode,
    phase: mode === "fast" ? "act" : "orient",
    turn: previous.turn + 1,
    goal: continuing ? previous.goal : compact(prompt, MAX_JSPACE_TEXT),
    core: continuing && previous.core.length > 0 ? previous.core : extractCore(prompt),
    verified: continuing ? previous.verified : [],
    open: continuing ? previous.open : [],
    next: mode === "fast"
      ? "Complete the direct request and verify the result briefly."
      : "Choose the smallest useful next action.",
    checkpoint: continuing ? previous.checkpoint : null,
    coverage: continuing
      ? previous.coverage
      : { attempted: 0, successful: 0, failed: 0 },
    updatedAt: now,
  };
}

export function noteJspaceToolStart(
  state: JSpaceState,
  toolName: string,
  now = Date.now(),
): JSpaceState {
  return {
    ...state,
    phase: "act",
    next: `Review the ${toolName} result against the goal.`,
    coverage: { ...state.coverage, lastTool: toolName },
    updatedAt: now,
  };
}

export function noteJspaceToolEnd(
  state: JSpaceState,
  toolName: string,
  isError: boolean,
  now = Date.now(),
): JSpaceState {
  const coverage = {
    ...state.coverage,
    attempted: state.coverage.attempted + 1,
    successful: state.coverage.successful + (isError ? 0 : 1),
    failed: state.coverage.failed + (isError ? 1 : 0),
    lastTool: toolName,
    lastResult: isError ? "error" as const : "ok" as const,
  };
  if (isError) {
    return {
      ...state,
      phase: "recover",
      open: addUnique(state.open, `${toolName} failed`),
      next: `Carry the ${toolName} failure diagnosis into one retry or choose a different route.`,
      coverage,
      updatedAt: now,
    };
  }
  return {
    ...state,
    phase: "verify",
    verified: addUnique(state.verified, `${toolName} succeeded`),
    open: state.open.filter((item) => item !== `${toolName} failed`),
    next: `Check the ${toolName} result against the goal before continuing.`,
    checkpoint: { label: `after ${toolName}`, at: now },
    coverage,
    updatedAt: now,
  };
}

export function noteJspaceSettled(state: JSpaceState, now = Date.now()): JSpaceState {
  const failed = state.open.length > 0;
  return {
    ...state,
    phase: failed ? "recover" : "verify",
    next: failed
      ? "Resolve the recorded failure before declaring the goal complete."
      : "Verify that the result covers the goal before declaring completion.",
    checkpoint: { label: `turn ${state.turn} settled`, at: now },
    updatedAt: now,
  };
}

export function formatJspaceState(state: JSpaceState): string {
  const list = (items: readonly string[]) => items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
  const checkpoint = state.checkpoint ? `${state.checkpoint.label} at ${new Date(state.checkpoint.at).toISOString()}` : "(none)";
  const coverage = `${state.coverage.attempted} attempted, ${state.coverage.successful} successful, ${state.coverage.failed} failed`;
  return [
    `Mode: ${state.mode}`,
    `Phase: ${state.phase}`,
    `Goal: ${state.goal}`,
    "Core:",
    list(state.core),
    "Verified signals:",
    list(state.verified),
    "Open:",
    list(state.open),
    `Next: ${state.next}`,
    `Checkpoint: ${checkpoint}`,
    `Coverage: ${coverage}`,
  ].join("\n");
}

export function buildJspacePrompt(state: JSpaceState, includeState = true): string {
  const stateBlock = formatJspaceState(state);
  const stateLines = includeState ? [`\n${stateBlock}`] : [];
  if (state.mode === "fast") {
    return [
      "## J-Space task control",
      "Current control mode: fast.",
      "Use one direct action for this small request.",
      "Verify the result briefly and do not add planning prose.",
      "Keep private reasoning private.",
      ...stateLines,
    ].join("\n");
  }
  const loopRules = state.mode === "loop"
    ? [
      "- Re-evaluate the next action after every tool result.",
      "- Carry failure diagnoses into retries.",
      "- Use a different route after a repeated or non-diagnostic failure.",
      "- Treat tool success as evidence, not proof that the full goal is complete.",
      "- Keep the active tool set small. Reveal a hidden PUM tool group only when needed.",
    ]
    : [
      "- Make a short decision, take the relevant action, and verify the result.",
      "- Do not load unrelated PUM tool groups.",
      "- Treat tool success as evidence, not proof that the full goal is complete.",
    ];
  return [
    "## J-Space task control",
    `Current control mode: ${state.mode}.`,
    "J-Space is an external task-state protocol. It is not private chain-of-thought.",
    "Use the ledger as a control summary. Do not print the ledger unless the user asks.",
    ...loopRules,
    "- Keep the user goal and important constraints active across tool and file seams.",
    "- Before the final answer, check the goal, open items, and verification coverage.",
    ...stateLines,
  ].join("\n");
}

export function buildJspaceContextMessage(state: JSpaceState): AgentMessage {
  return {
    role: "custom",
    customType: JSPACE_CONTEXT_CUSTOM_TYPE,
    content: `<jspace_state>\n${formatJspaceState(state)}\n</jspace_state>`,
    display: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * Adds J-Space control to one pi session.
 *
 * State changes stay in the session companion file. Tool arguments and tool
 * output are never persisted by this extension.
 */
export const jspaceExtension: InlineExtension = {
  name: "pum-jspace",
  factory(pi) {
    let state = createJspaceState();
    let sessionFile: string | undefined;
    let loaded = false;

    const ensureLoaded = (ctx: { sessionManager: { getSessionFile(): string | undefined } }): void => {
      const nextSessionFile = ctx.sessionManager.getSessionFile();
      if (loaded && nextSessionFile === sessionFile) return;
      sessionFile = nextSessionFile;
      state = loadJspace(sessionFile) ?? createJspaceState();
      loaded = true;
    };

    const persist = (): void => {
      if (jspaceEnabled) saveJspace(sessionFile, state);
    };

    pi.on("session_start", (_event, ctx) => {
      if (!jspaceEnabled) return;
      ensureLoaded(ctx);
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (!jspaceEnabled) return;
      ensureLoaded(ctx);
      state = startJspaceTurn(state, event.prompt);
      persist();
      return { systemPrompt: `${event.systemPrompt}\n\n${buildJspacePrompt(state, false)}` };
    });

    // Refresh the bounded ledger before every provider call. This keeps tool
    // failures and successful evidence visible during the same agent run.
    pi.on("context", (event, ctx) => {
      if (!jspaceEnabled) return;
      ensureLoaded(ctx);
      const messages = event.messages.filter((message) => {
        const custom = message as AgentMessage & { customType?: string };
        return custom.customType !== JSPACE_CONTEXT_CUSTOM_TYPE;
      });
      return { messages: [...messages, buildJspaceContextMessage(state)] };
    });

    pi.on("tool_execution_start", (event, ctx) => {
      if (!jspaceEnabled) return;
      ensureLoaded(ctx);
      state = noteJspaceToolStart(state, event.toolName);
    });

    pi.on("tool_execution_end", (event, ctx) => {
      if (!jspaceEnabled) return;
      ensureLoaded(ctx);
      state = noteJspaceToolEnd(state, event.toolName, event.isError);
      persist();
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!jspaceEnabled) return;
      ensureLoaded(ctx);
      state = noteJspaceSettled(state);
      persist();
    });

    pi.on("session_shutdown", () => {
      if (jspaceEnabled) persist();
    });
  },
};


import { createHash, randomUUID } from "node:crypto";
import type { AgentSession, ModelRuntime, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const CONVERSATION_BRANCH_CUSTOM_TYPE = "pum.conversation_branch";
const MAX_ENTRIES = 100_000;
const MAX_TEXT = 100_000;
const runtimeTokens = new WeakMap<AgentSession, { token: string; manager: SessionManager; id: string; cwd: string; file: string | undefined }>();
const inputTracking = new WeakMap<AgentSession, { disposed: boolean; nextTurnSeen: boolean }>();

/** Bind immediately after SDK creation, BEFORE extension startup/first admission.
 * pi's public pending count excludes nextTurn custom messages, and it has no
 * public getter or unique consumption receipt for that queue. Conservatively
 * refuse branching for the remainder of a runtime that ever accepted nextTurn.
 * No private SDK fields, content copies, or persisted trust markers are used.
 */
export function bindConversationBranchSession(session: AgentSession): void {
  if (inputTracking.has(session)) return;
  const state = { disposed: false, nextTurnSeen: false };
  inputTracking.set(session, state);
  const send = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (...args) => {
    if (state.disposed) return Promise.reject(new Error("The conversation runtime is disposed."));
    if (args[1]?.deliverAs === "nextTurn") state.nextTurnSeen = true;
    return send(...args);
  };
  const dispose = session.dispose.bind(session);
  session.dispose = () => { state.disposed = true; dispose(); };
}

export function hasConversationBranchPendingInput(session: AgentSession): boolean {
  const state = inputTracking.get(session);
  return !state || state.disposed || state.nextTurnSeen || session.agent.hasQueuedMessages();
}

/** The SDK ignores recorded model/effort when the selected context has no
 * messages. Explicitly restore navigation-anchored state even before root-user
 * re-edit, using pi's catalog and creation options, never global-default writes.
 */
export function conversationBranchState(manager: SessionManager, models: ModelRuntime): {
  model: AgentSession["model"]; thinkingLevel: AgentSession["thinkingLevel"];
} | undefined {
  const entries = manager.getEntries();
  if (!entries.some((entry) => entry.type === "custom" && entry.customType === CONVERSATION_BRANCH_CUSTOM_TYPE)) return;
  // Selection limits must not become a new general resume limit after a session
  // grows. Bound traversal by the already-loaded entry count instead, without
  // copying the tree or letting a malformed cycle enter SDK context building.
  let remaining = entries.length;
  let cursor = manager.getLeafId();
  let anchored = false;
  while (cursor !== null) {
    const entry = manager.getEntry(cursor);
    if (!entry || remaining-- <= 0) throw new Error("Conversation branch history has invalid ancestry.");
    if (entry.type === "custom" && entry.customType === CONVERSATION_BRANCH_CUSTOM_TYPE) anchored = true;
    cursor = entry.parentId;
  }
  if (!anchored) return;
  const state = manager.buildSessionContext();
  const model = state.model ? models.getModel(state.model.provider, state.model.modelId) : undefined;
  if (state.model && !model) throw new Error("The conversation branch's recorded model is unavailable. Refusing to substitute global defaults.");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(state.thinkingLevel)) {
    throw new Error("The conversation branch's recorded effort is invalid.");
  }
  return { model, thinkingLevel: state.thinkingLevel as AgentSession["thinkingLevel"] };
}

/** An opaque, runtime-local confirmation snapshot, never command authority. */
export interface ConversationBranchSelection {
  entryId: string;
  runtimeToken: string;
  leafId: string | null;
  entryCount: number;
  prefixDigest: string;
  textDigest: string;
}
export interface ConversationBranchPoint {
  selection: ConversationBranchSelection;
  entryId: string;
  kind: "user" | "assistant";
  label: string;
  currentPath: boolean;
  archived: boolean;
}
export interface ConversationBranchPage {
  points: ConversationBranchPoint[];
  total: number;
  nextOffset: number | null;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function token(session: AgentSession): string {
  let value = runtimeTokens.get(session);
  const manager = session.sessionManager;
  if (!value) {
    value = { token: randomUUID(), manager, id: manager.getSessionId(), cwd: manager.getCwd(), file: manager.getSessionFile() };
    runtimeTokens.set(session, value);
  }
  return value.token;
}
/** Identity/ancestry only: never inspect private custom-entry data. */
function prefix(entries: SessionEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify([entry.id, entry.parentId, entry.type])).update("\n");
  return hash.digest("hex");
}
function plainText(content: unknown, user: boolean): string | undefined {
  if (typeof content === "string") return user && content.length <= MAX_TEXT && content.trim() ? content : undefined;
  if (!Array.isArray(content) || !content.length || content.length > 4096) return;
  let text = "";
  for (const part of content) {
    if (!part || typeof part !== "object") return;
    if (part.type === "text" && typeof part.text === "string") {
      if (text.length + part.text.length > MAX_TEXT) return;
      text += part.text;
    }
    else if (!user && part.type === "thinking") continue; // Never read reasoning/signatures.
    else return; // No attachment loss, tool payloads, or unknown content kinds.
    if (text.length > MAX_TEXT) return;
  }
  return text.trim() ? text : undefined;
}
type State = { pending: ReadonlyMap<string, string>; valid: boolean };
type Candidate = { entry: SessionEntry; kind: "user" | "assistant" };
function project(session: AgentSession) {
  const entries = session.sessionManager.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error("Conversation branch history exceeds the safe selection limit.");
  const byId = new Map<string, SessionEntry>();
  const states = new Map<string, State>();
  const candidates: Candidate[] = [];
  const empty: State = { pending: new Map(), valid: true };
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || byId.has(entry.id)
      || (entry.parentId !== null && !byId.has(entry.parentId))) {
      throw new Error("Conversation branch history has invalid ancestry.");
    }
    byId.set(entry.id, entry);
    const parent = entry.parentId === null ? empty : states.get(entry.parentId)!;
    let state = parent;
    if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message !== "object") throw new Error("Conversation branch history has an invalid message.");
      if (message.role === "assistant") {
        const boundedContent = Array.isArray(message.content) && message.content.length <= 4096;
        const calls = boundedContent ? message.content.filter((part) => part?.type === "toolCall") : [];
        const pending = new Map<string, string>();
        let valid = parent.valid && parent.pending.size === 0 && boundedContent && message.stopReason !== "pending"
          && message.content.every((part) => part && ["text", "thinking", "toolCall"].includes(part.type));
        for (const call of calls) {
          if (typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name || pending.has(call.id)) valid = false;
          pending.set(call.id, call.name);
        }
        if (pending.size > 256) valid = false;
        state = { pending, valid };
        const text = plainText(message.content, false);
        if (valid && !pending.size && message.stopReason === "stop" && text !== undefined) {
          candidates.push({ entry, kind: "assistant" });
        }
      } else if (message.role === "toolResult") {
        const pending = new Map(parent.pending);
        const valid = parent.valid && typeof message.toolCallId === "string" && typeof message.toolName === "string"
          && pending.has(message.toolCallId) && pending.get(message.toolCallId) === message.toolName;
        pending.delete(message.toolCallId);
        state = { pending, valid };
      } else if (message.role === "user") {
        state = { pending: parent.pending, valid: parent.valid && parent.pending.size === 0 };
        const text = plainText(message.content, true);
        if (state.valid && text !== undefined) candidates.push({ entry, kind: "user" });
      }
    }
    states.set(entry.id, state);
  }
  const current = new Set<string>();
  let cursor = session.sessionManager.getLeafId();
  if (cursor !== null && !byId.has(cursor)) throw new Error("Conversation branch history has an invalid leaf.");
  while (cursor !== null) { current.add(cursor); cursor = byId.get(cursor)!.parentId; }
  // Structural metadata only: a boundary archives its ancestors, not its literal handoff.
  const archived = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if ((archived.has(entry.id) || (entry.type === "custom" && entry.customType === "pum.context_window")) && entry.parentId !== null) {
      archived.add(entry.parentId);
    }
  }
  return { entries, candidates, current, archived };
}

/** Bounded newest-first UI projection. No IO, private bodies, summaries, or mutation. */
export function listConversationBranchPoints(session: AgentSession, options: { offset?: number; limit?: number } = {}): ConversationBranchPage {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid conversation branch page.");
  }
  const { entries, candidates, current, archived } = project(session);
  const snapshot = { runtimeToken: token(session), leafId: session.sessionManager.getLeafId(), entryCount: entries.length, prefixDigest: prefix(entries) };
  const ordered = candidates.reverse();
  return {
    points: ordered.slice(offset, offset + limit).map(({ entry, kind }) => {
      const text = entry.type === "message" && "content" in entry.message ? plainText(entry.message.content, kind === "user")! : "";
      return {
        entryId: entry.id, kind,
        label: text.slice(0, 512).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160),
        currentPath: current.has(entry.id), archived: archived.has(entry.id),
        selection: { ...snapshot, entryId: entry.id, textDigest: digest(text) },
      };
    }),
    total: ordered.length,
    nextOffset: offset + limit < ordered.length ? offset + limit : null,
  };
}

/** Re-run safety, identity, leaf and immutable-prefix validation at confirmation. */
export function validateConversationBranchSelection(session: AgentSession, selection: ConversationBranchSelection): { targetId: string | null; editorText?: string } {
  const stale = () => new Error("Conversation branch selection is stale or unsafe. Open /branch again.");
  const bound = runtimeTokens.get(session);
  const manager = session.sessionManager;
  if (!bound || !selection || selection.runtimeToken !== bound.token || bound.manager !== manager
    || bound.id !== manager.getSessionId() || bound.cwd !== manager.getCwd() || bound.file !== manager.getSessionFile()
    || selection.leafId !== manager.getLeafId()) throw stale();
  const { entries, candidates } = project(session);
  if (selection.entryCount !== entries.length || selection.prefixDigest !== prefix(entries)) throw stale();
  const candidate = candidates.find(({ entry }) => entry.id === selection.entryId);
  if (!candidate || candidate.entry.type !== "message" || !("content" in candidate.entry.message)) throw stale();
  const text = plainText(candidate.entry.message.content, candidate.kind === "user");
  if (text === undefined || selection.textDigest !== digest(text)) throw stale();
  return candidate.kind === "user"
    ? { targetId: candidate.entry.parentId, editorText: text }
    : { targetId: candidate.entry.id };
}

import {
  AgentSessionRuntime, createAgentSessionRuntime, SessionManager,
  type AgentSession, type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { sessionDir } from "./config";
import { listProjectSessions } from "./session-resume-alias";
import { SessionLockOwner, releaseSessionLockOnDispose } from "./session-lock";
import { freezeRuntimeAdmissions, isRuntimeIdle } from "./runtime-settings";
import { CONVERSATION_BRANCH_CUSTOM_TYPE, hasConversationBranchPendingInput, validateConversationBranchSelection, type ConversationBranchSelection } from "./conversation-branch";

/** Reserve before SessionManager.open: opening old JSONL can migrate it. */
export async function lockedProjectSession(cwd: string, resume: boolean, owner: SessionLockOwner) {
  const recent = resume ? (await listProjectSessions(cwd))[0] : undefined;
  if (!recent) return { sessionManager: SessionManager.create(cwd, sessionDir(cwd)), release: () => {} };
  const release = owner.acquire(recent.path);
  try {
    return { sessionManager: SessionManager.open(recent.path, dirname(recent.path), cwd), release };
  } catch (error) { release(); throw error; }
}

export type ConversationRuntimeState = { model: AgentSession["model"]; thinkingLevel: AgentSession["thinkingLevel"] };
export type LockedRuntimeFactory = (context: Parameters<CreateAgentSessionRuntimeFactory>[0] & {
  /** Branch/recovery only. Pass to the SDK's model/thinkingLevel creation options. */
  conversationState?: ConversationRuntimeState;
}) => Promise<Awaited<ReturnType<CreateAgentSessionRuntimeFactory>> & {
  /** Synchronous revocation of exact-session PUM capabilities before SDK cleanup. */
  retireConversation?: () => void;
}>;
export interface ConversationBranchResult {
  session: AgentSession;
  editorText?: string;
  cancelled?: boolean;
  recovered?: boolean;
}
export type LockedAgentSessionRuntime = Pick<AgentSessionRuntime, keyof AgentSessionRuntime> & {
  branchConversation(selection: ConversationBranchSelection, options?: {
    validate?: () => void;
    /** App-only manager/input guards after shutdown; the old runtime is frozen. */
    validateRetired?: () => void;
  }): Promise<ConversationBranchResult>;
};

const RECOVERY_REQUIRED = "Conversation branch recovery required. Further session work is blocked. Unfinished shutdown keeps ownership until cleanup settles or this process exits.";
export const CONVERSATION_SHUTDOWN_TIMEOUT_MS = 5_000;
function assertBranchIdle(session: AgentSession) {
  if (!isRuntimeIdle(session) || session.pendingMessageCount !== 0 || session.isBashRunning !== false || session.hasPendingBashMessages !== false
    || session.isCompacting !== false || session.isRetrying !== false || hasConversationBranchPendingInput(session)) {
    throw new Error("Conversation branching requires an idle session with no pending messages, summaries, retries or Bash work.");
  }
}
/** A bounded, strict read also prevents SDK open from migrating or silently ignoring
 * a partial/corrupt record. Raw bytes never leave this transaction or enter diagnostics. */
function readBranchFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) {
    throw new Error("Conversation branch file is unsafe or exceeds the size limit.");
  }
  const same = (other: typeof stat) => stat.dev === other.dev && stat.ino === other.ino && stat.size === other.size
    && stat.mtimeMs === other.mtimeMs && stat.ctimeMs === other.ctimeMs && other.nlink === 1 && other.isFile();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const bytes = Buffer.alloc(stat.size);
  try {
    if (!same(fstatSync(fd))) throw new Error("Conversation branch file changed.");
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Conversation branch file is incomplete.");
      offset += count;
    }
    if (!same(fstatSync(fd)) || !same(lstatSync(path)) || !bytes.length || bytes.at(-1) !== 10) {
      throw new Error("Conversation branch file changed or is incomplete.");
    }
  } finally { closeSync(fd); }
  let records: any[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    records = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  } catch { throw new Error("Conversation branch file contains invalid or incomplete records."); }
  if (records[0]?.type !== "session" || records[0]?.version !== 3 || records.slice(1).some((entry) => entry?.type === "session")) {
    throw new Error("Conversation branch file requires repair or migration before branching.");
  }
  return { bytes, records, dev: stat.dev, ino: stat.ino };
}
function diskSnapshot(manager: SessionManager) {
  const path = manager.getSessionFile();
  if (!path || !manager.isPersisted()) throw new Error("Conversation branching requires a saved session.");
  const snapshot = readBranchFile(path);
  if (snapshot.records[0]?.id !== manager.getSessionId()
    || JSON.stringify(snapshot.records.slice(1)) !== JSON.stringify(manager.getEntries())) {
    throw new Error("Conversation branch file does not match the live transcript.");
  }
  return snapshot;
}
function reopenBranch(path: string, cwd: string, original: ReturnType<typeof diskSnapshot>): SessionManager {
  // Check BEFORE SDK open: empty/missing/old-version files can otherwise be
  // initialized or migrated by open, and malformed trailing lines are ignored.
  const current = readBranchFile(path);
  if (current.dev !== original.dev || current.ino !== original.ino || !current.bytes.subarray(0, original.bytes.length).equals(original.bytes)) {
    throw new Error("Conversation branch transcript prefix changed.");
  }
  return SessionManager.open(path, dirname(path), cwd);
}
function assertPrefix(manager: SessionManager, original: ReturnType<typeof diskSnapshot>) {
  const current = diskSnapshot(manager);
  if (current.dev !== original.dev || current.ino !== original.ino || !current.bytes.subarray(0, original.bytes.length).equals(original.bytes)) {
    throw new Error("Conversation branch transcript prefix changed.");
  }
}

export async function createLockedAgentSessionRuntime(
  factory: LockedRuntimeFactory,
  options: Parameters<typeof createAgentSessionRuntime>[1],
  owner: SessionLockOwner,
): Promise<LockedAgentSessionRuntime> {
  const retireCapabilities = new WeakMap<AgentSession, () => void>();
  const lockedFactory: LockedRuntimeFactory = async (context) => {
    const release = owner.acquire(context.sessionManager.getSessionFile());
    try {
      const result = await factory(context);
      releaseSessionLockOnDispose(result.session, release);
      if (result.retireConversation) retireCapabilities.set(result.session, result.retireConversation);
      return result;
    } catch (error) { release(); throw error; }
  };
  let runtime = await createAgentSessionRuntime(lockedFactory, options);
  let replacement: Promise<unknown> | undefined;
  let closing = false;
  let failed = false;
  let recoveryReservation: (() => void) | undefined;
  let retirement: { runtime: AgentSessionRuntime; settled: boolean } | undefined;
  let rebind: Parameters<AgentSessionRuntime["setRebindSession"]>[0];
  let beforeInvalidate: Parameters<AgentSessionRuntime["setBeforeSessionInvalidate"]>[0];
  const replace = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) throw new Error("The session is closing.");
    if (failed) throw new Error(RECOVERY_REQUIRED);
    if (replacement) throw new Error("A session switch is already in progress.");
    const pending = Promise.resolve().then(operation);
    replacement = pending;
    try { return await pending; }
    finally { replacement = undefined; }
  };
  let disposing: Promise<void> | undefined;
  const facade: LockedAgentSessionRuntime = {
    get session() { return runtime.session; },
    get services() { return runtime.services; },
    get cwd() { return runtime.cwd; },
    get diagnostics() { return runtime.diagnostics; },
    get modelFallbackMessage() { return runtime.modelFallbackMessage; },
    setRebindSession(callback) { rebind = callback; runtime.setRebindSession(callback); },
    setBeforeSessionInvalidate(callback) { beforeInvalidate = callback; runtime.setBeforeSessionInvalidate(callback); },
    switchSession: (path, switchOptions) => replace(async () => {
      const release = owner.acquire(path);
      try { return await runtime.switchSession(path, switchOptions); }
      finally { release(); }
    }),
    newSession: (newOptions) => replace(() => runtime.newSession(newOptions)),
    fork: (entryId, forkOptions) => replace(() => runtime.fork(entryId, forkOptions)),
    importFromJsonl: (path, cwd) => replace(() => runtime.importFromJsonl(path, cwd)),
    branchConversation: (selection, branchOptions) => replace(async () => {
      const original = runtime.session;
      assertBranchIdle(original);
      const selected = validateConversationBranchSelection(original, selection);
      const path = original.sessionFile;
      if (!path) throw new Error("Conversation branching requires a saved session.");
      const release = owner.acquire(path);
      let keepReservation = false;
      let retired = false;
      try {
        const manager = original.sessionManager;
        const snapshot = diskSnapshot(manager);
        const originalLeaf = manager.getLeafId();
        const state: ConversationRuntimeState = { model: original.model, thinkingLevel: original.thinkingLevel };
        const cwd = runtime.cwd;
        const agentDir = runtime.services.agentDir;
        const appendAnchor = (target: SessionManager, leaf: string | null, rollback: boolean) => {
          if (leaf === null) target.resetLeaf(); else target.branch(leaf);
          target.appendCustomEntry(CONVERSATION_BRANCH_CUSTOM_TYPE, { version: 1, rollback });
          // Public SDK session metadata, not Settings/default setters. Needed when
          // historical ancestry selects a different model and for immediate resume.
          if (state.model) target.appendModelChange(state.model.provider, state.model.id);
          target.appendThinkingLevelChange(state.thinkingLevel);
          assertPrefix(target, snapshot);
        };
        const rebuild = async (target: SessionManager) => {
          const result = await lockedFactory({ cwd, agentDir, sessionManager: target, conversationState: state,
            sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: path } });
          try {
            if (result.session === original || result.session.sessionManager !== target || result.session.sessionId !== original.sessionId
              || result.session.sessionFile !== path || result.services.cwd !== cwd
              || result.session.model?.provider !== state.model?.provider || result.session.model?.id !== state.model?.id
              || result.session.thinkingLevel !== state.thinkingLevel) throw new Error("Branch runtime identity/state mismatch.");
            assertBranchIdle(result.session);
            assertPrefix(target, snapshot);
            runtime = new AgentSessionRuntime(result.session, result.services, lockedFactory, result.diagnostics, result.modelFallbackMessage);
            runtime.setRebindSession(rebind);
            runtime.setBeforeSessionInvalidate(beforeInvalidate);
            await rebind?.(result.session);
            return result.session;
          } catch (error) { result.session.dispose(); throw error; }
        };
        // Freeze synchronously at exact idle, before any awaited arbitrary cleanup.
        // App holds its manager/input transition guard across this whole operation.
        branchOptions?.validate?.();
        assertBranchIdle(original);
        validateConversationBranchSelection(original, selection);
        assertPrefix(manager, snapshot);
        freezeRuntimeAdmissions(original);
        retired = true;
        retireCapabilities.get(original)?.();
        let cleanupFailed = false;
        const unsubscribeError = original.extensionRunner.onError((error) => {
          // SDK emit catches handler exceptions. Observe only its event code,
          // never retain or surface the handler's raw error/stack/private data.
          if (error.event === "session_shutdown") cleanupFailed = true;
        });
        const retiring: { runtime: AgentSessionRuntime; settled: boolean } = { runtime, settled: false };
        retirement = retiring;
        // Match native same-file replacement's public lifecycle ordering, but
        // never its mutable tree/fork hooks or runtime.dispose's quit-only reason.
        // Abort is unnecessary here: exact idle was proven and admissions frozen.
        const cleanup = (async () => {
          if (original.extensionRunner.hasHandlers("session_shutdown")) {
            await original.extensionRunner.emit({ type: "session_shutdown", reason: "resume", targetSessionFile: path });
          }
          beforeInvalidate?.();
          original.dispose();
        })().finally(() => { retiring.settled = true; unsubscribeError(); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([cleanup, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Conversation shutdown did not settle.")), CONVERSATION_SHUTDOWN_TIMEOUT_MS);
          })]);
        } finally { if (timer) clearTimeout(timer); }
        if (cleanupFailed) throw new Error("Conversation shutdown cleanup failed.");
        branchOptions?.validateRetired?.();
        validateConversationBranchSelection(original, selection);
        assertPrefix(manager, snapshot);
        // The original manager's branch/file setters are permanently fenced by
        // retirement. Only PUM's newly reopened manager may publish selection.
        appendAnchor(reopenBranch(path, cwd, snapshot), selected.targetId, false);
        try {
          const session = await rebuild(reopenBranch(path, cwd, snapshot));
          return { session, ...("editorText" in selected ? { editorText: selected.editorText } : {}) };
        } catch {
          // A factory may have appended startup metadata before failing. Preserve
          // those bytes too, and select original ancestry with a second anchor.
          const recovery = reopenBranch(path, cwd, snapshot);
          assertPrefix(recovery, snapshot);
          appendAnchor(recovery, originalLeaf, true);
          return { session: await rebuild(recovery), recovered: true };
        }
      } catch (error) {
        if (!retired) throw error;
        failed = true;
        keepReservation = true;
        recoveryReservation = release;
        if (retirement?.runtime === runtime && retirement.settled) {
          try { runtime.session.dispose(); } catch { /* Keep ownership and fail closed. */ }
        }
        throw new Error(RECOVERY_REQUIRED);
      } finally { if (!keepReservation) release(); }
    }),
    dispose: () => {
      closing = true;
      return disposing ??= (async () => {
        await replacement?.catch(() => {});
        if (retirement?.runtime === runtime && !retirement.settled) {
          // JavaScript shutdown hooks cannot be forcibly stopped. Do not release
          // ownership, rerun cleanup, or invalidate a still-running extension.
          // Permit a later explicit disposal attempt after actual settlement.
          disposing = undefined;
          throw new Error("Conversation shutdown is still pending; session ownership remains held.");
        }
        try {
          if (retirement?.runtime !== runtime) {
            await runtime.session.abort();
            await runtime.dispose();
          }
        } finally {
          try { runtime.session.dispose(); }
          finally { recoveryReservation?.(); recoveryReservation = undefined; }
        }
      })();
    },
  };
  return facade;
}

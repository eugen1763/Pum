import { rmSync, writeFileSync } from "node:fs";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ForkOrigin, ForkSource } from "./types";
import { SessionLockOwner } from "../session-lock";

type ForkSessionSource = Pick<
  SessionManager,
  "getSessionId" | "getSessionFile" | "getLeafId" | "getBranch" | "buildContextEntries"
>;

export function captureForkSource(
  sessionManager: ForkSessionSource,
  sourceAgentId: string | null,
): ForkSource {
  const cutoffEntryId = sessionManager.getLeafId();
  const entries = cutoffEntryId === null ? [] : sessionManager.getBranch(cutoffEntryId);
  if (cutoffEntryId !== null && entries.at(-1)?.id !== cutoffEntryId) {
    throw new Error(`Cannot fork: cutoff entry ${cutoffEntryId} is not on the active branch`);
  }
  return {
    origin: {
      sourceSessionId: sessionManager.getSessionId(),
      cutoffEntryId,
      sourceAgentId,
    },
    sourceSessionFile: sessionManager.getSessionFile(),
    entries: structuredClone(entries) as SessionEntry[],
  };
}

export function createForkedSession(
  source: ForkSource,
  targetCwd: string,
  sessionDir: string,
  reserve?: (path: string) => void,
): SessionManager {
  const cutoff = source.origin.cutoffEntryId;
  if ((cutoff === null && source.entries.length !== 0)
    || (cutoff !== null && source.entries.at(-1)?.id !== cutoff)) {
    throw new Error("Cannot fork: captured active branch does not match the cutoff entry");
  }

  const target = SessionManager.create(targetCwd, sessionDir, {
    parentSession: source.sourceSessionFile,
  });
  const sessionFile = target.getSessionFile();
  const header = target.getHeader();
  if (!sessionFile || !header) throw new Error("Cannot fork: target session could not be allocated");

  const forkHeader = {
    ...header,
    version: CURRENT_SESSION_VERSION,
    cwd: targetCwd,
    parentSession: source.sourceSessionFile,
  };
  const content = [forkHeader, ...source.entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  // The caller can retain the reservation through child-runtime setup.
  const release = reserve ? (reserve(sessionFile), () => {}) : new SessionLockOwner().acquire(sessionFile);
  try {
    writeFileSync(sessionFile, content, { flag: "wx" });
    return SessionManager.open(sessionFile, sessionDir, targetCwd);
  } catch (error) {
    rmSync(sessionFile, { force: true });
    throw error;
  } finally { release(); }
}

export function entriesAfterForkCutoff(
  sessionManager: ForkSessionSource,
  origin?: ForkOrigin,
): SessionEntry[] {
  if (!origin) return sessionManager.buildContextEntries();
  const branch = sessionManager.getBranch();
  if (origin.cutoffEntryId === null) return branch;
  const cutoffIndex = branch.findIndex((entry) => entry.id === origin.cutoffEntryId);
  if (cutoffIndex < 0) return [];
  return branch.slice(cutoffIndex + 1);
}

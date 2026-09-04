import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AGENT_DIR, sessionDir } from "./config";
import { readBranch } from "./git-branch";
import {
  loadRelocation,
  relocationPathsTrusted,
  type RelocationRecord,
} from "./relocation";
import { isPathInsideOrSame, pathIdentity } from "./platform";

const ALIAS_SUFFIX = ".resume-alias.json";
const ALIAS_VERSION = 1;
const MAX_ALIAS_FIELD = 4_096;

export type SessionResumeAlias = {
  version: typeof ALIAS_VERSION;
  side: "source" | "worktree";
  relocationId: string;
  sessionFile: string;
  sourceRoot: string;
  worktreePath: string;
  branch: string;
  updatedAt: number;
};

export type ResolvedSessionResumeAlias = SessionResumeAlias & {
  aliasFile: string;
};

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ALIAS_FIELD
    && !value.includes("\0");
}

function isAlias(value: unknown): value is SessionResumeAlias {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const alias = value as Record<string, unknown>;
  return alias.version === ALIAS_VERSION
    && (alias.side === "source" || alias.side === "worktree")
    && boundedText(alias.relocationId)
    && boundedText(alias.sessionFile)
    && boundedText(alias.sourceRoot)
    && boundedText(alias.worktreePath)
    && boundedText(alias.branch)
    && typeof alias.updatedAt === "number"
    && Number.isFinite(alias.updatedAt);
}

function aliasName(sessionFile: string, side: SessionResumeAlias["side"]): string {
  const stem = basename(sessionFile).replace(/\.jsonl?$/, "");
  return `${stem}.${side}${ALIAS_SUFFIX}`;
}

export function resumeAliasFileFor(
  lookupCwd: string,
  sessionFile: string,
  side: SessionResumeAlias["side"],
): string {
  return join(sessionDir(lookupCwd), aliasName(sessionFile, side));
}

function targetPathIsAllowed(sessionFile: string): boolean {
  const sessionsRoot = join(AGENT_DIR, "sessions");
  if (!isPathInsideOrSame(sessionsRoot, sessionFile)) return false;
  return basename(sessionFile).endsWith(".jsonl");
}

function targetIsTrustedFile(sessionFile: string): boolean {
  if (!targetPathIsAllowed(sessionFile)) return false;
  try {
    const stats = lstatSync(sessionFile);
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
  } catch {
    return false;
  }
}

function sameRecord(alias: SessionResumeAlias, record: RelocationRecord): boolean {
  return alias.relocationId === record.id
    && pathIdentity(alias.sourceRoot) === pathIdentity(record.sourceRoot)
    && pathIdentity(alias.worktreePath) === pathIdentity(record.worktreePath)
    && alias.branch === record.branch;
}

function removeAliasFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale alias is only a discovery hint. A failed cleanup must not stop startup.
  }
}

function validateAlias(
  aliasFile: string,
  alias: SessionResumeAlias,
  lookupCwd: string,
): ResolvedSessionResumeAlias | null {
  const expectedLookup = alias.side === "source" ? alias.sourceRoot : alias.worktreePath;
  if (pathIdentity(expectedLookup) !== pathIdentity(lookupCwd)
    || !targetIsTrustedFile(alias.sessionFile)) {
    removeAliasFile(aliasFile);
    return null;
  }

  const record = loadRelocation(alias.sessionFile);
  if (record) {
    if (!sameRecord(alias, record)) {
      removeAliasFile(aliasFile);
      return null;
    }
    if (record.location === "worktree" && alias.side === "worktree") {
      const trusted = relocationPathsTrusted(record, {
        worktreeExists: existsSync(record.worktreePath),
        worktreeBranch: readBranch(record.worktreePath) ?? undefined,
        sourceRoot: record.sourceRoot,
      });
      if (!trusted) {
        removeAliasFile(aliasFile);
        return null;
      }
    }
  } else if (alias.side === "worktree") {
    // A worktree alias without its relocation record could authorize a stale path.
    removeAliasFile(aliasFile);
    return null;
  }

  return { ...alias, aliasFile };
}

function readAlias(path: string, lookupCwd: string): ResolvedSessionResumeAlias | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isAlias(parsed)) {
      removeAliasFile(path);
      return null;
    }
    return validateAlias(path, parsed, lookupCwd);
  } catch {
    removeAliasFile(path);
    return null;
  }
}

/** Read and validate every resume alias for one project directory. */
export function resolveSessionResumeAliases(lookupCwd: string): ResolvedSessionResumeAlias[] {
  const directory = sessionDir(lookupCwd);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(ALIAS_SUFFIX));
  } catch {
    return [];
  }
  return names
    .map((name) => readAlias(join(directory, name), lookupCwd))
    .filter((alias): alias is ResolvedSessionResumeAlias => alias !== null);
}

function writeAlias(
  lookupCwd: string,
  side: SessionResumeAlias["side"],
  sessionFile: string,
  record: RelocationRecord,
): void {
  const file = resumeAliasFileFor(lookupCwd, sessionFile, side);
  const alias: SessionResumeAlias = {
    version: ALIAS_VERSION,
    side,
    relocationId: record.id,
    sessionFile: resolve(sessionFile),
    sourceRoot: record.sourceRoot,
    worktreePath: record.worktreePath,
    branch: record.branch,
    updatedAt: Date.now(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(alias, null, 2), "utf8");
    renameSync(temporary, file);
  } catch (error) {
    removeAliasFile(temporary);
    throw error;
  }
}

/**
 * Keep session discovery consistent with a completed relocation.
 *
 * The canonical JSONL never moves. A source alias is needed only when that
 * JSONL belongs to a source subdirectory. A worktree alias exists only while
 * the session is active in the generated worktree.
 */
export function syncSessionResumeAliases(
  sessionFile: string | undefined,
  record: RelocationRecord,
): void {
  if (!sessionFile || !targetPathIsAllowed(sessionFile)) return;
  const sourceFile = resumeAliasFileFor(record.sourceRoot, sessionFile, "source");
  const canonicalSourceDirectory = sessionDir(record.sourceRoot);
  if (pathIdentity(dirname(sessionFile)) === pathIdentity(canonicalSourceDirectory)) {
    removeAliasFile(sourceFile);
  } else {
    writeAlias(record.sourceRoot, "source", sessionFile, record);
  }

  const worktreeFile = resumeAliasFileFor(record.worktreePath, sessionFile, "worktree");
  if (record.location === "worktree") {
    writeAlias(record.worktreePath, "worktree", sessionFile, record);
  } else {
    removeAliasFile(worktreeFile);
  }
}

/** Remove a stale worktree alias while preserving source-side discovery. */
export function settleSessionResumeAliasesAtSource(
  sessionFile: string | undefined,
  record: RelocationRecord,
): void {
  if (!sessionFile) return;
  syncSessionResumeAliases(sessionFile, { ...record, location: "source", pending: undefined });
}

async function sessionInfoForAlias(
  alias: ResolvedSessionResumeAlias,
): Promise<SessionInfo | null> {
  const sessions = await SessionManager.listAll(dirname(alias.sessionFile));
  const target = pathIdentity(alias.sessionFile);
  const info = sessions.find((session) => pathIdentity(session.path) === target) ?? null;
  if (!info) removeAliasFile(alias.aliasFile);
  return info;
}

/** List canonical sessions and trusted aliases without duplicating one JSONL. */
export async function listProjectSessions(cwd: string): Promise<SessionInfo[]> {
  const canonical = await SessionManager.list(cwd, sessionDir(cwd));
  const aliases = resolveSessionResumeAliases(cwd);
  const aliased = await Promise.all(aliases.map(sessionInfoForAlias));
  const byPath = new Map<string, SessionInfo>();
  for (const session of [...canonical, ...aliased.filter((item): item is SessionInfo => item !== null)]) {
    byPath.set(pathIdentity(session.path), session);
  }
  return [...byPath.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// Mutable startup lives in session-lock-runtime.ts: reserve canonical ownership
// before SessionManager.open, which can rewrite legacy or empty JSONL files.

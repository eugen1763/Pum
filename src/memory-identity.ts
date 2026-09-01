import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix, win32 } from "node:path";
import {
  canonicalRealpathSync,
  projectStorageKey,
  type RuntimePlatform,
} from "./platform";

export type MemoryIdentity = {
  key: string;
  digest: string;
  kind: "git" | "directory";
};

type MemoryIdentityOptions = {
  platform?: RuntimePlatform;
  gitPath?: (cwd: string, args: string[]) => string;
  realpath?: (path: string, platform: RuntimePlatform) => string;
};

const resolvedIdentities = new Map<string, MemoryIdentity>();

function defaultGitPath(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).replace(/\r?\n$/, "");
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Use Git's shared administrative directory as the repository identity.
 * Every linked worktree reports the same directory, even when its checkout
 * path is unrelated to the primary checkout path.
 */
export function resolveMemoryIdentity(
  cwd: string,
  options: MemoryIdentityOptions = {},
): MemoryIdentity {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const realpath = options.realpath ?? canonicalRealpathSync;
  const gitPath = options.gitPath ?? defaultGitPath;
  const cacheKey = `${platform}\0${projectStorageKey(cwd, platform)}`;
  const cacheable = options.gitPath === undefined && options.realpath === undefined;
  if (cacheable) {
    const cached = resolvedIdentities.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const raw = gitPath(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const absolute = paths.isAbsolute(raw) ? raw : paths.resolve(cwd, raw);
    const canonical = realpath(absolute, platform);
    const key = `git:${projectStorageKey(canonical, platform)}`;
    const identity: MemoryIdentity = { key, digest: digest(key), kind: "git" };
    if (cacheable) resolvedIdentities.set(cacheKey, identity);
    return identity;
  } catch {
    let canonical = paths.resolve(cwd);
    try {
      canonical = realpath(canonical, platform);
    } catch { /* the session startup owns directory validation */ }
    const key = `directory:${projectStorageKey(canonical, platform)}`;
    const identity: MemoryIdentity = { key, digest: digest(key), kind: "directory" };
    if (cacheable) resolvedIdentities.set(cacheKey, identity);
    return identity;
  }
}

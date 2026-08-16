import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  canonicalRealpathSync,
  projectStorageKey,
  type RuntimePlatform,
} from "./platform";

export type PromptCacheIdentity = {
  key: string;
  aliases: string[];
};

export type PromptCacheIdentityResolver = (
  cwd: string,
  platform: RuntimePlatform,
) => PromptCacheIdentity;

const resolvedIdentities = new Map<string, PromptCacheIdentity>();

function fallbackIdentity(cwd: string, platform: RuntimePlatform): PromptCacheIdentity {
  const key = projectStorageKey(cwd, platform);
  return { key, aliases: [key] };
}

function hasGitMarker(cwd: string, platform: RuntimePlatform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  let directory = paths.resolve(cwd);
  for (;;) {
    try {
      const marker = lstatSync(paths.join(directory, ".git"));
      if (marker.isDirectory() || marker.isFile()) return true;
    } catch { /* keep walking */ }
    const parent = paths.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function gitPath(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  }).replace(/\r?\n$/, "");
}

function firstWorktree(output: string): string | undefined {
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) return field.slice("worktree ".length);
    if (field) return undefined;
  }
  return undefined;
}

/**
 * Map a linked Git worktree directory to the corresponding directory in the
 * primary worktree. Non-Git directories keep their existing isolated key.
 */
export const resolvePromptCacheIdentity: PromptCacheIdentityResolver = (cwd, platform) => {
  const fallback = fallbackIdentity(cwd, platform);
  // A simulated Windows path cannot be inspected correctly on a non-Windows host.
  if (platform !== process.platform || !hasGitMarker(cwd, platform)) return fallback;

  const cacheKey = `${platform}\0${projectStorageKey(cwd, platform)}`;
  const cached = resolvedIdentities.get(cacheKey);
  if (cached) return cached;

  try {
    const paths = platform === "win32" ? win32 : posix;
    const current = canonicalRealpathSync(cwd, platform);
    const currentRoot = canonicalRealpathSync(
      gitPath(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
      platform,
    );
    const primaryRaw = firstWorktree(gitPath(cwd, ["worktree", "list", "--porcelain", "-z"]));
    if (!primaryRaw) return fallback;
    const primaryRoot = canonicalRealpathSync(primaryRaw, platform);
    const suffix = paths.relative(currentRoot, current);
    if (suffix === ".." || suffix.startsWith(`..${paths.sep}`) || paths.isAbsolute(suffix)) return fallback;

    const primaryDirectory = paths.resolve(primaryRoot, suffix);
    let canonicalPrimaryDirectory = primaryDirectory;
    try {
      canonicalPrimaryDirectory = canonicalRealpathSync(primaryDirectory, platform);
    } catch { /* the corresponding directory need not exist in every worktree */ }
    const key = projectStorageKey(canonicalPrimaryDirectory, platform);
    const aliases = [...new Set([
      key,
      projectStorageKey(cwd, platform),
      projectStorageKey(current, platform),
    ])];
    const identity = { key, aliases };
    resolvedIdentities.set(cacheKey, identity);
    return identity;
  } catch {
    return fallback;
  }
};

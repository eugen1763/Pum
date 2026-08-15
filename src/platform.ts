import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type RuntimePlatform = NodeJS.Platform;

type Environment = Record<string, string | undefined>;

function pathApi(platform: RuntimePlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

export function defaultAgentDir(
  platform: RuntimePlatform = process.platform,
  env: Environment = process.env,
  home = homedir(),
): string {
  const paths = pathApi(platform);
  if (env.PUM_DIR) return paths.resolve(env.PUM_DIR);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? env.APPDATA ?? paths.join(home, "AppData", "Local");
    return paths.join(base, "pum");
  }
  if (platform === "darwin") return paths.join(home, "Library", "Application Support", "pum");
  return paths.join(env.XDG_CONFIG_HOME ?? paths.join(home, ".config"), "pum");
}

export function projectStorageKey(
  cwd: string,
  platform: RuntimePlatform = process.platform,
): string {
  if (platform !== "win32") return cwd;
  return win32.resolve(cwd).toLowerCase();
}

export function sessionDirectoryName(
  cwd: string,
  platform: RuntimePlatform = process.platform,
): string {
  if (platform !== "win32") {
    return `--${posix.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  }

  const canonical = win32.resolve(cwd).toLowerCase();
  const readable = canonical
    .replace(/^\\\\/, "unc-")
    .replace(/^[a-z]:\\/i, (prefix) => `${prefix[0]}-`)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `--${readable || "root"}-${digest}--`;
}

export function isPathInside(
  parent: string,
  candidate: string,
  platform: RuntimePlatform = process.platform,
): boolean {
  const paths = pathApi(platform);
  const relative = paths.relative(paths.resolve(parent), paths.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

/**
 * Resolve a path to the spelling the OS considers real.
 *
 * Node's `realpathSync` keeps an 8.3 short name as it found it, while the
 * async `realpath` expands it. Windows accounts like `runneradmin` genuinely
 * have one, so the two disagree and a root registered through one never
 * matches a path resolved through the other. `.native` asks the OS, which
 * settles it in one spelling.
 */
/** Async twin of `canonicalRealpathSync`, and the default resolver below. */
export async function canonicalRealpath(
  path: string,
  platform: RuntimePlatform = process.platform,
): Promise<string> {
  if (platform !== "win32") return realpath(path);
  // Not in the fs/promises types, and not guaranteed present on every runtime,
  // so reach for it defensively rather than assume it.
  const native = (realpath as unknown as { native?: (path: string) => Promise<string> }).native;
  try {
    if (native) return await native(path);
  } catch {
    // Fall through to the portable resolver below.
  }
  return realpath(path);
}

export function canonicalRealpathSync(
  path: string,
  platform: RuntimePlatform = process.platform,
): string {
  if (platform !== "win32") return realpathSync(path);
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}

export function pathIdentity(
  path: string,
  platform: RuntimePlatform = process.platform,
): string {
  const canonical = pathApi(platform).resolve(path);
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function isPathInsideOrSame(
  parent: string,
  candidate: string,
  platform: RuntimePlatform = process.platform,
): boolean {
  return pathIdentity(parent, platform) === pathIdentity(candidate, platform)
    || isPathInside(parent, candidate, platform);
}

export async function canonicalPathIdentity(
  path: string,
  platform: RuntimePlatform = process.platform,
  resolvePath: (path: string) => Promise<string> = canonicalRealpath,
): Promise<string> {
  const paths = pathApi(platform);
  const canonical = paths.resolve(await resolvePath(path));
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export async function canonicalPathIdentityAllowMissing(
  path: string,
  platform: RuntimePlatform = process.platform,
  resolvePath: (path: string) => Promise<string> = canonicalRealpath,
): Promise<string> {
  const paths = pathApi(platform);
  const absolute = paths.resolve(path);
  const missing: string[] = [];
  let existing = absolute;
  while (true) {
    try {
      const canonical = await resolvePath(existing);
      return pathIdentity(paths.resolve(canonical, ...missing.reverse()), platform);
    } catch (error) {
      const parent = paths.dirname(existing);
      if (parent === existing || existing === paths.parse(existing).root) throw error;
      missing.push(paths.basename(existing));
      existing = parent;
    }
  }
}

export async function pathsHaveSameIdentity(
  first: string,
  second: string,
  platform: RuntimePlatform = process.platform,
  resolvePath: (path: string) => Promise<string> = canonicalRealpath,
): Promise<boolean> {
  const [firstIdentity, secondIdentity] = await Promise.all([
    canonicalPathIdentity(first, platform, resolvePath),
    canonicalPathIdentity(second, platform, resolvePath),
  ]);
  return firstIdentity === secondIdentity;
}

export function shutdownSignals(
  platform: RuntimePlatform = process.platform,
): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * Numbers for the signals PUM handles. The table is explicit rather than read
 * from `os.constants`, so a Windows signal still maps on Linux and the value
 * cannot drift between hosts.
 */
const SHUTDOWN_SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
  SIGBREAK: 21,
};

/**
 * The conventional shell exit code for death by a signal: 128 plus the signal
 * number, so 130 for SIGINT and 143 for SIGTERM. A script can then tell an
 * interrupted run from a failing one, which plain 1 hides. An unknown signal
 * falls back to 1.
 */
export function signalExitCode(signal: NodeJS.Signals): number {
  const number = SHUTDOWN_SIGNAL_NUMBERS[signal];
  return number === undefined ? 1 : 128 + number;
}

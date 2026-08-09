import { createHash } from "node:crypto";
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

export function shutdownSignals(
  platform: RuntimePlatform = process.platform,
): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

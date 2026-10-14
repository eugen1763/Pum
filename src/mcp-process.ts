import { lstat, mkdtemp, opendir, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32, join } from "node:path";
import { AGENT_DIR } from "./config";
import { isCredentialSensitivePath } from "./credential-path";
import { createBubblewrapBackend } from "./sandbox/linux";
import { createWindowsSandboxBackend } from "./sandbox/windows";
import type { SandboxBackend, SandboxPolicy, SandboxProcessHandle } from "./sandbox/types";

export interface McpProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  onStdout(data: Uint8Array): void;
  onStderr(data: Uint8Array): void;
  signal?: AbortSignal;
}
export interface McpProcessHandle {
  write(data: string): Promise<void>;
  close(): void;
  kill(): void;
  completed: Promise<unknown>;
}
export interface McpProcessAdapter { spawn(request: McpProcessRequest): Promise<McpProcessHandle> }

export const MCP_MAX_PENDING_WRITE_BYTES = 1024 * 1024;
export const MCP_MAX_PENDING_WRITES = 64;
export const MCP_WRITE_TIMEOUT_MS = 5_000;
export const MCP_CLOSE_GRACE_MS = 1_000;
const failure = () => new Error("MCP process unavailable or blocked by native policy");
/** Only the adapter may identify an unavailable mandatory native boundary. */
export class McpNativeUnavailableError extends Error {
  constructor() { super("MCP native enforcement unavailable (Linux Bubblewrap or Windows MXC BaseContainer)"); }
}

export const MCP_SCAN_MAX_ENTRIES = 50_000;
export const MCP_SCAN_MAX_DEPTH = 32;
export const MCP_SCAN_MAX_MASKS = 2_048;
export const MCP_SCAN_MAX_PATH_BYTES = 256 * 1024;
export const MCP_SCAN_TIMEOUT_MS = 5_000;
export interface McpProcessAdapterOptions { configDir?: string; platform?: NodeJS.Platform; allowWindows?: boolean; windowsBackend?: SandboxBackend }

const within = (root: string, path: string) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
/** Pure comparison after caller validation/canonicalization; no authority grant. */
export function mcpConfigOverlapsSystemSources(configPaths: readonly string[], systemSources: readonly string[]): boolean {
  return configPaths.some((config) => systemSources.some((source) =>
    within(source, config) || within(config, source)));
}
// No broad /etc or home mount. Runtime libraries are readonly; the project is
// explicitly shared live. An outside executable gets its FILE, never its parent.
export const MCP_SYSTEM_MOUNTS: readonly string[] = Object.freeze(["/usr", "/bin", "/sbin", "/lib", "/lib64"].filter(existsSync));

/** Bind the existing config directory and every ancestor for this policy build.
 * Missing, linked, malformed or replaced boundaries are never guessed. */
async function configBoundary(path: string): Promise<{ path: string; identity: string }> {
  if (typeof path !== "string" || !posix.isAbsolute(path) || Buffer.byteLength(path) > 4096
    || path.split("/").some((part) => part === "." || part === "..")
    || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(path)) throw failure();
  const canonical = await exactPath(path, true);
  const identities: string[] = [];
  let prefix = "";
  for (const part of canonical.split("/").filter(Boolean)) {
    prefix += `/${part}`;
    const stat = await lstat(prefix);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
    identities.push(`${prefix}:${stat.dev}:${stat.ino}`);
  }
  if (await exactPath(path, true) !== canonical) throw failure();
  return { path: canonical, identity: identities.join("\n") };
}

async function exactPath(path: string, directory: boolean): Promise<string> {
  if (!posix.isAbsolute(path) || path === "/" || /[\x00-\x1f\x7f]/.test(path)) throw failure();
  const normalized = posix.normalize(path);
  // Project/config boundaries must not be reached through links.
  let prefix = "";
  for (const part of normalized.split("/").filter(Boolean)) {
    prefix += `/${part}`;
    if ((await lstat(prefix)).isSymbolicLink()) throw failure();
  }
  const stat = await lstat(normalized);
  if (directory ? !stat.isDirectory() : !stat.isFile() || !(stat.mode & 0o111)) throw failure();
  return realpath(normalized);
}

/** Bounded check-time defense in depth, NOT a sanitized snapshot. Unknown names,
 * future additions and aliases may expose secrets through server tool results. */
export async function buildMcpProcessPolicy(
  request: Pick<McpProcessRequest, "cwd" | "executable" | "args" | "signal">,
  options: McpProcessAdapterOptions = {},
): Promise<SandboxPolicy> {
  try {
    const start = Date.now();
    const check = () => { if (request.signal?.aborted || Date.now() - start > MCP_SCAN_TIMEOUT_MS) throw failure(); };
    check();
    const cwd = await exactPath(request.cwd, true);
    // Standard /bin -> /usr/bin aliases are resolved before exact-file binding.
    if (!posix.isAbsolute(request.executable) || Buffer.byteLength(request.executable) > 4096
      || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(request.executable)) throw failure();
    const executable = await exactPath(await realpath(request.executable), false);
    const configInput = options.configDir ?? AGENT_DIR;
    const boundary = await configBoundary(configInput);
    const forbidden = [...new Set([posix.normalize(configInput), boundary.path])];
    // /lib and /usr/lib (likewise bin/sbin/lib64) can expose the same source
    // through independent binds. A mask at one destination cannot protect all
    // aliases. Refuse either containment direction, never project alias masks.
    const systemSources: string[] = [];
    for (const root of MCP_SYSTEM_MOUNTS) {
      const source = await exactPath(await realpath(root), true);
      systemSources.push(root, source);
    }
    if (mcpConfigOverlapsSystemSources(forbidden, systemSources)) throw failure();
    const home = await realpath(homedir());
    if (cwd === home || within(cwd, home) || isCredentialSensitivePath(cwd)
      || forbidden.some((path) => within(path, cwd) || within(path, executable))
      || isCredentialSensitivePath(executable)
      || ["/proc", "/sys", "/dev", "/etc", ...MCP_SYSTEM_MOUNTS].some((path) => within(path, cwd))) throw failure();
    if (!Array.isArray(request.args) || request.args.length > 16 || request.args.some((arg) =>
      typeof arg !== "string" || Buffer.byteLength(arg) > 1024 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(arg))) throw failure();
    let entries = 0;
    let maskBytes = 0;
    const deniedPaths: string[] = [];
    const mask = (path: string) => {
      deniedPaths.push(path);
      maskBytes += Buffer.byteLength(path);
      if (deniedPaths.length > MCP_SCAN_MAX_MASKS || maskBytes > MCP_SCAN_MAX_PATH_BYTES) throw failure();
    };
    const scan = async (directory: string, depth: number): Promise<void> => {
      check();
      if (depth > MCP_SCAN_MAX_DEPTH || (await lstat(directory)).isSymbolicLink()
        || await realpath(directory) !== directory) throw failure();
      for await (const entry of await opendir(directory)) {
        check();
        if (++entries > MCP_SCAN_MAX_ENTRIES) throw failure();
        const path = posix.join(directory, entry.name);
        const sensitive = isCredentialSensitivePath(`${path}/`) || isCredentialSensitivePath(path)
          || forbidden.some((root) => within(root, path));
        const stat = await lstat(path);
        if (sensitive) {
          // Mounting over a link could mask its target instead of this name.
          if (stat.isSymbolicLink()) throw failure();
          mask(path);
        } else if (stat.isDirectory()) await scan(path, depth + 1);
        else if (!stat.isFile() && !stat.isSymbolicLink()) throw failure();
        // Never traverse symlinks. Aliases are a disclosed confidentiality limit.
        // Refuse sockets/FIFOs/devices: readonly does not confine their IPC.
      }
    };
    await scan(cwd, 0);
    const currentBoundary = await configBoundary(configInput);
    if (currentBoundary.path !== boundary.path || currentBoundary.identity !== boundary.identity) throw failure();
    check();
    if (within("/pum-mcp-private-tmp", cwd) || within("/pum-mcp-private-tmp", executable)) throw failure();
    if (deniedPaths.some((path) => within(path, executable))) throw failure();
    return {
      version: 1, exactCommand: "MCP approved stdio process", executable, args: [...request.args], cwd,
      readOnlyPaths: [cwd, executable], readWritePaths: [], deniedPaths,
      privateTemp: "/pum-mcp-private-tmp", environment: { PATH: "/usr/bin:/bin", HOME: "/pum-mcp-private-tmp", TMPDIR: "/pum-mcp-private-tmp", LANG: "C.UTF-8" },
      network: "deny", rationale: "Explicitly approved readonly live-project MCP; masks are check-time defense in depth", accesses: [],
    };
  } catch { throw failure(); }
}

async function spawnLinuxMcp(request: McpProcessRequest, options: McpProcessAdapterOptions): Promise<McpProcessHandle> {
  const bubblewrap = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
  if (!bubblewrap) throw new McpNativeUnavailableError();
  const backend = createBubblewrapBackend({ executable: bubblewrap, systemMounts: MCP_SYSTEM_MOUNTS });
  if ((await backend.probe()).state !== "enforced") throw new McpNativeUnavailableError();
  if (request.signal?.aborted) throw failure();
  const policy = await buildMcpProcessPolicy(request, options);
  if (request.signal?.aborted) throw failure();
  return manageMcpProcessHandle(backend.spawn(policy, {
    persistentStdin: true, signal: request.signal,
    onStdout: request.onStdout, onStderr: request.onStderr,
  }), request.signal ?? new AbortController().signal);
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const pathControls = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
/** Drive-qualified absolute only: drive roots, UNC/device, `.`/`..` and separators fail. */
function windowsSafe(value: string): boolean {
  return typeof value === "string" && WINDOWS_DRIVE.test(value) && !pathControls.test(value)
    && !value.split(/[\\/]/).slice(1).some((part) => part === "" || part === "." || part === "..");
}
function windowsSame(a: string, b: string): boolean {
  return win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
}
function windowsWithin(root: string, path: string): boolean {
  const r = win32.normalize(root).toLowerCase();
  const p = win32.normalize(path).toLowerCase();
  const base = r.endsWith("\\") ? r : `${r}\\`;
  return p === r || p.startsWith(base);
}
/** Canonical path without link/junction components; checks compare lowercased spellings. */
async function windowsExactPath(value: string, directory: boolean): Promise<string> {
  if (!windowsSafe(value)) throw failure();
  const normalized = win32.normalize(value);
  const parts = normalized.split(/[\\/]+/).slice(1);
  let prefix = /^[A-Za-z]:/.exec(normalized)![0];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!part) continue;
    prefix = `${prefix}\\${part}`;
    const stat = await lstat(prefix);
    // Only ancestors must be directories; the final component may be the file.
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw failure();
  }
  const final = await lstat(normalized);
  if (final.isSymbolicLink() || (directory ? !final.isDirectory() : !final.isFile())) throw failure();
  const canonical = (await realpath(normalized)).replace(/^\\\\\?\\/u, "");
  if (!windowsSame(canonical, normalized)) throw failure();
  return win32.normalize(canonical);
}
/** Bind the config directory and every ancestor for this policy build; never guessed. */
async function windowsConfigBoundary(path: string): Promise<{ path: string; identity: string }> {
  const canonical = await windowsExactPath(path, true);
  const identities: string[] = [];
  let prefix = /^[A-Za-z]:/.exec(canonical)![0];
  for (const part of canonical.split(/[\\/]+/).slice(1)) {
    if (!part) continue;
    prefix = `${prefix}\\${part}`;
    const stat = await lstat(prefix);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
    identities.push(`${prefix.toLowerCase()}:${stat.dev}:${stat.ino}`);
  }
  if (!windowsSame(await windowsExactPath(path, true), canonical)) throw failure();
  return { path: canonical, identity: identities.join("\n") };
}

/** Windows MCP policy: exact cwd and executable file readonly, config denied, no network.
 * The adapter owns the real private temp; this builder only validates and records it. */
export async function buildWindowsMcpProcessPolicy(
  request: Pick<McpProcessRequest, "cwd" | "executable" | "args" | "signal">,
  options: McpProcessAdapterOptions & { privateTemp?: string } = {},
): Promise<SandboxPolicy> {
  try {
    const start = Date.now();
    const check = () => { if (request.signal?.aborted || Date.now() - start > MCP_SCAN_TIMEOUT_MS) throw failure(); };
    check();
    const cwd = await windowsExactPath(request.cwd, true);
    const executable = await windowsExactPath(request.executable, false);
    const configInput = options.configDir ?? AGENT_DIR;
    const boundary = await windowsConfigBoundary(configInput);
    const forbidden = [...new Set([win32.normalize(configInput), boundary.path])];
    const home = await realpath(homedir());
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const privateTemp = options.privateTemp ?? "";
    if (!windowsSafe(privateTemp) || home === cwd || windowsWithin(cwd, home)
      || isCredentialSensitivePath(cwd) || isCredentialSensitivePath(executable)
      || forbidden.some((path) => windowsWithin(path, cwd) || windowsWithin(path, executable))
      || windowsWithin(systemRoot, cwd) || windowsWithin(systemRoot, configInput) || windowsWithin(configInput, systemRoot)
      || windowsWithin(privateTemp, cwd) || windowsWithin(privateTemp, executable)
      || windowsWithin(cwd, privateTemp) || windowsWithin(executable, privateTemp)) throw failure();
    const tempStat = await lstat(privateTemp);
    if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) throw failure();
    if (!Array.isArray(request.args) || request.args.length > 16 || request.args.some((arg) =>
      typeof arg !== "string" || Buffer.byteLength(arg) > 1024
      || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(arg))) throw failure();
    let entries = 0;
    let maskBytes = 0;
    const deniedPaths: string[] = [];
    const mask = (path: string) => {
      deniedPaths.push(path);
      maskBytes += Buffer.byteLength(path);
      if (deniedPaths.length > MCP_SCAN_MAX_MASKS || maskBytes > MCP_SCAN_MAX_PATH_BYTES) throw failure();
    };
    const scan = async (directory: string, depth: number): Promise<void> => {
      check();
      if (depth > MCP_SCAN_MAX_DEPTH || (await lstat(directory)).isSymbolicLink()
        || !windowsSame(await realpath(directory), directory)) throw failure();
      for await (const entry of await opendir(directory)) {
        check();
        if (++entries > MCP_SCAN_MAX_ENTRIES) throw failure();
        const path = win32.join(directory, entry.name);
        const sensitive = isCredentialSensitivePath(`${path}\\`) || isCredentialSensitivePath(path)
          || forbidden.some((root) => windowsWithin(root, path));
        const stat = await lstat(path);
        if (sensitive) {
          if (stat.isSymbolicLink()) throw failure();
          mask(path);
        } else if (stat.isDirectory()) await scan(path, depth + 1);
        else if (!stat.isFile() && !stat.isSymbolicLink()) throw failure();
      }
    };
    await scan(cwd, 0);
    const currentBoundary = await windowsConfigBoundary(configInput);
    if (currentBoundary.path !== boundary.path || currentBoundary.identity !== boundary.identity) throw failure();
    check();
    if (deniedPaths.some((path) => windowsWithin(path, executable))) throw failure();
    return {
      version: 1, exactCommand: "MCP approved stdio process", executable, args: [...request.args], cwd,
      readOnlyPaths: [cwd, executable], readWritePaths: [], deniedPaths,
      privateTemp,
      environment: {
        PATH: `${win32.join(systemRoot, "System32")};${systemRoot}`,
        SystemRoot: systemRoot, HOME: privateTemp, USERPROFILE: privateTemp,
      },
      network: "deny",
      rationale: "Explicitly approved readonly live-project Windows MCP (MXC BaseContainer); masks are check-time defense in depth",
      accesses: [],
    };
  } catch { throw failure(); }
}

async function spawnWindowsMcp(request: McpProcessRequest, options: McpProcessAdapterOptions): Promise<McpProcessHandle> {
  const backend = options.windowsBackend ?? createWindowsSandboxBackend();
  const capability = await backend.probe();
  if (capability.state !== "enforced") throw new McpNativeUnavailableError();
  if (request.signal?.aborted) throw failure();
  const privateTemp = await mkdtemp(join(tmpdir(), "pum-mcp-private-"));
  let child: SandboxProcessHandle;
  try {
    const policy = await buildWindowsMcpProcessPolicy(request, { ...options, privateTemp });
    if (request.signal?.aborted) throw failure();
    child = backend.spawn(policy, {
      persistentStdin: true, signal: request.signal, onStdout: request.onStdout, onStderr: request.onStderr,
    });
  } catch (error) {
    await rm(privateTemp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const completed = child.completed.finally(() => rm(privateTemp, { recursive: true, force: true }).catch(() => {}));
  return manageMcpProcessHandle({ ...child, completed }, request.signal ?? new AbortController().signal);
}

/** No startup work until spawn. The controller, not this adapter, owns consent.
 * Mandatory platform-native enforcement regardless of Check mode; never a direct fallback.
 * Linux requires Bubblewrap; Windows requires MXC BaseContainer (never AppContainer+DACL). */
export function createMcpProcessAdapter(options: McpProcessAdapterOptions = {}): McpProcessAdapter {
  const platform = options.platform ?? process.platform;
  return {
    async spawn(request) {
      try {
        if (request.signal?.aborted) throw failure();
        if (platform === "linux") return spawnLinuxMcp(request, options);
        if (platform === "win32" && options.allowWindows !== false) return spawnWindowsMcp(request, options);
        throw new McpNativeUnavailableError();
      } catch (error) {
        if (error instanceof McpNativeUnavailableError && !request.signal?.aborted) throw error;
        throw failure();
      }
    },
  };
}

/** Transport-only lifecycle helper. It grants no process creation or filesystem access. */
export function manageMcpProcessHandle(child: SandboxProcessHandle, signal: AbortSignal): McpProcessHandle {
  if (!child.write || !child.closeInput) {
    void child.completed.catch(() => {});
    try { child.kill(); } catch { /* Unsupported backend: no raw process errors. */ }
    throw failure();
  }
  let closing = false;
  let settled = false;
  let killed = false;
  let bytes = 0;
  const pending = new Set<(error: Error) => void>();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const failWrites = () => { for (const reject of [...pending]) reject(failure()); };
  const kill = () => {
    if (settled || killed) return;
    killed = closing = true;
    failWrites();
    try { child.kill(); } catch { /* Never surface backend process errors. */ }
  };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  const completed = child.completed.catch(() => { throw failure(); }).finally(() => {
    settled = closing = true;
    failWrites();
    if (closeTimer) clearTimeout(closeTimer);
    signal.removeEventListener("abort", kill);
  });
  void completed.catch(() => {});
  return {
    completed, kill,
    close() {
      if (closing || settled) return;
      closing = true;
      try { child.closeInput!(); } catch { kill(); return; }
      closeTimer = setTimeout(kill, MCP_CLOSE_GRACE_MS);
    },
    write(data) {
      const size = typeof data === "string" ? Buffer.byteLength(data) : Infinity;
      if (closing || settled || signal.aborted || size > MCP_MAX_PENDING_WRITE_BYTES
        || bytes + size > MCP_MAX_PENDING_WRITE_BYTES || pending.size >= MCP_MAX_PENDING_WRITES) {
        return Promise.reject(failure());
      }
      bytes += size;
      return new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          pending.delete(fail);
          bytes -= size;
          error ? reject(error) : resolve();
        };
        const fail = (error: Error) => finish(error);
        const timer = setTimeout(() => { finish(failure()); kill(); }, MCP_WRITE_TIMEOUT_MS);
        pending.add(fail);
        try { void child.write!(data).then(() => finish(), () => { finish(failure()); kill(); }); }
        catch { finish(failure()); kill(); }
      });
    },
  };
}

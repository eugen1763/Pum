import { lstat, opendir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { AGENT_DIR } from "./config";
import { isCredentialSensitivePath } from "./credential-path";
import { createBubblewrapBackend } from "./sandbox/linux";
import type { SandboxPolicy, SandboxProcessHandle } from "./sandbox/types";

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

export const MCP_SCAN_MAX_ENTRIES = 50_000;
export const MCP_SCAN_MAX_DEPTH = 32;
export const MCP_SCAN_MAX_MASKS = 2_048;
export const MCP_SCAN_MAX_PATH_BYTES = 256 * 1024;
export const MCP_SCAN_TIMEOUT_MS = 5_000;
export interface McpProcessAdapterOptions { configDir?: string }

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

/** No startup work until spawn. The controller, not this adapter, owns consent.
 * Mandatory Linux Bubblewrap regardless of Check mode; never a direct fallback. */
export function createMcpProcessAdapter(options: McpProcessAdapterOptions = {}): McpProcessAdapter {
  return {
    async spawn(request) {
      try {
        if (process.platform !== "linux" || request.signal?.aborted) throw failure();
        const bubblewrap = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
        if (!bubblewrap) throw failure();
        const backend = createBubblewrapBackend({ executable: bubblewrap, systemMounts: MCP_SYSTEM_MOUNTS });
        if ((await backend.probe()).state !== "enforced" || request.signal?.aborted) throw failure();
        const policy = await buildMcpProcessPolicy(request, options);
        if (request.signal?.aborted) throw failure();
        return manageMcpProcessHandle(backend.spawn(policy, {
          persistentStdin: true, signal: request.signal,
          onStdout: request.onStdout, onStderr: request.onStderr,
        }), request.signal ?? new AbortController().signal);
      } catch { throw failure(); }
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

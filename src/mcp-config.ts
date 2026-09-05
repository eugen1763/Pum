import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, parse, posix, resolve } from "node:path";

/** Inert proposal format only. Reading/parsing never grants MCP access. */
export const MCP_MAX_CONFIG_BYTES = 16 * 1024;
export type McpServerConfig = { name: string; executable: string; args: string[] };
export type McpConfig = { version: 1; servers: McpServerConfig[] };
export type McpProposal = { digest: string; config: McpConfig };

const namePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const controls = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function string(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maximum && !controls.test(value);
}
function invalid(): never { throw new Error("Invalid MCP proposal: use the documented bounded version 1 stdio configuration."); }

/** Parsing is not authorization. Unknown transport/auth/environment fields fail closed. */
export function parseMcpConfig(text: string): McpConfig {
  if (Buffer.byteLength(text) > MCP_MAX_CONFIG_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  if (!object(value) || !keys(value, ["version", "servers"]) || value.version !== 1
    || !Array.isArray(value.servers) || value.servers.length < 1 || value.servers.length > 4) invalid();
  const names = new Set<string>();
  const servers = value.servers.map((entry): McpServerConfig => {
    if (!object(entry) || !keys(entry, ["name", "executable", "args"])
      || typeof entry.name !== "string" || !namePattern.test(entry.name) || names.has(entry.name)
      || !string(entry.executable, 4096) || !posix.isAbsolute(entry.executable)
      || entry.executable === "/" || !Array.isArray(entry.args) || entry.args.length > 16
      || !entry.args.every((argument) => string(argument, 1024))) invalid();
    names.add(entry.name);
    return { name: entry.name, executable: entry.executable, args: [...entry.args] as string[] };
  });
  return { version: 1, servers };
}

/**
 * Explicit read of exact-cwd .pum/mcp.json, never a startup discovery hook.
 * Bounded regular file, no linked components, and descriptor/name stability checks.
 * These are check-time guards, not an atomic filesystem snapshot or execution grant.
 */
export function readMcpProposal(cwd: string): McpProposal {
  try {
    const path = join(resolve(cwd), ".pum", "mcp.json");
    const components: { path: string; dev: number; ino: number }[] = [];
    let component = path;
    for (;;) {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink() || (component === path ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
        throw new Error("Invalid path");
      }
      components.push({ path: component, dev: stat.dev, ino: stat.ino });
      if (component === parse(component).root) break;
      component = dirname(component);
    }
    // A concurrently substituted FIFO must not block the TUI before fstat can reject it.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes: Buffer;
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > MCP_MAX_CONFIG_BYTES) throw new Error("Invalid file");
      const buffer = Buffer.alloc(MCP_MAX_CONFIG_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd);
      const named = lstatSync(path);
      if (length > MCP_MAX_CONFIG_BYTES || length !== after.size
        || [after, named].some((stat) => !stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev
          || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) {
        throw new Error("Changed file");
      }
      // Recheck every ancestor, not only the final name: a substituted .pum/cwd
      // symlink can otherwise open a different regular file and pass descriptor checks.
      for (const original of components) {
        const current = lstatSync(original.path);
        if (current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino
          || (original.path === path ? !current.isFile() || current.nlink !== 1 : !current.isDirectory())) {
          throw new Error("Changed path");
        }
      }
      bytes = buffer.subarray(0, length);
    } finally { closeSync(fd); }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { digest: createHash("sha256").update(bytes).digest("hex"), config: parseMcpConfig(text) };
  } catch {
    // Neither filesystem paths/errors nor proposal text may leak into error messages.
    throw new Error("Cannot load .pum/mcp.json: use a stable, singly-linked regular UTF-8 JSON file (at most 16 KiB), no links, and the documented version 1 schema.");
  }
}

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, parse, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_DIR } from "./config";
import { isCredentialSensitivePath } from "./credential-path";
import { isPathInsideOrSame } from "./platform";

export const LSP_MAX_CONFIG_BYTES = 16 * 1024;
export const LSP_MAX_DOCUMENT_BYTES = 128 * 1024;
export type LspConfig = { version: 1; executable: string; args: string[] };
export type LspProposal = { digest: string; identity: string; config: LspConfig };
export type LspDocument = { path: string; relativePath: string; uri: string; text: string; fingerprint: string };
const controls = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const documentControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
function safeString(value: unknown, max: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= max && !controls.test(value);
}
function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function fileStamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function validStat(stat: BigIntStats, file: boolean): boolean {
  return !stat.isSymbolicLink() && (file ? stat.isFile() && stat.nlink === 1n : stat.isDirectory());
}

/** Check-time guards, not an atomic snapshot: never follow links or read an unbounded stream. */
function readStable(path: string, maximum: number): { bytes: Buffer; identity: string; stamp: string } {
  const chain: { path: string; stat: BigIntStats }[] = [];
  for (let component = path;; component = dirname(component)) {
    const stat = lstatSync(component, { bigint: true });
    if (!validStat(stat, component === path)) throw new Error("Invalid path");
    chain.push({ path: component, stat });
    if (component === parse(component).root) break;
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!validStat(before, true) || before.size > BigInt(maximum)
      || fileStamp(before) !== fileStamp(chain[0]!.stat)) throw new Error("Changed file");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (length > maximum || BigInt(length) !== after.size || !validStat(after, true)
      || fileStamp(after) !== fileStamp(before)) throw new Error("Changed file");
    for (const original of chain) {
      const current = lstatSync(original.path, { bigint: true });
      if (!validStat(current, original.path === path) || current.dev !== original.stat.dev
        || current.ino !== original.stat.ino || (original.path === path && fileStamp(current) !== fileStamp(before))) {
        throw new Error("Changed path");
      }
    }
    const identity = hash(JSON.stringify(chain.map(({ path, stat }) => [path, String(stat.dev), String(stat.ino)])));
    return { bytes: buffer.subarray(0, length), identity, stamp: fileStamp(after) };
  } finally { closeSync(fd); }
}

/** Exact-cwd inert proposal; neither parsing nor reading grants process authority. */
export function readLspProposal(cwd: string): LspProposal {
  try {
    if (!safeString(cwd, 4096) || !cwd) throw new Error("Invalid cwd");
    const path = join(resolve(cwd), ".pum", "lsp.json");
    if (!safeString(path, 4096)) throw new Error("Invalid path");
    const { bytes, identity } = readStable(path, LSP_MAX_CONFIG_BYTES);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid config");
    const config = value as Record<string, unknown>;
    if (Object.keys(config).length !== 3 || !Object.keys(config).every((key) => ["version", "executable", "args"].includes(key))
      || config.version !== 1 || !safeString(config.executable, 4096) || !posix.isAbsolute(config.executable)
      || config.executable === "/" || !Array.isArray(config.args) || config.args.length > 16
      || !config.args.every((arg) => safeString(arg, 1024))) throw new Error("Invalid config");
    return { digest: hash(bytes), identity, config: { version: 1, executable: config.executable, args: [...config.args] } };
  } catch {
    throw new Error("Cannot load .pum/lsp.json: require a stable singly-linked UTF-8 regular file, no linked ancestors, at most 16 KiB, and version/executable/args only.");
  }
}

/** One explicitly requested project Python document; additional tool roots do not apply. */
export function readLspDocument(cwd: string, relativePath: string): LspDocument {
  try {
    if (!safeString(cwd, 4096) || !cwd || !safeString(relativePath, 4096) || !relativePath
      || isAbsolute(relativePath) || win32.isAbsolute(relativePath) || relativePath.includes("\\")
      || relativePath.includes(":") || relativePath.split("/").some((part) => !part || part === "." || part === "..")
      || !relativePath.endsWith(".py")) throw new Error("Invalid path");
    const root = resolve(cwd);
    const path = join(root, relativePath);
    if (!safeString(path, 4096) || !isPathInsideOrSame(root, path)
      || isPathInsideOrSame(resolve(AGENT_DIR), path) || isCredentialSensitivePath(path)) throw new Error("Denied path");
    const { bytes, identity, stamp } = readStable(path, LSP_MAX_DOCUMENT_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (documentControls.test(text)) throw new Error("Invalid text");
    return { path, relativePath, uri: pathToFileURL(path).href, text,
      fingerprint: hash(JSON.stringify([hash(bytes), identity, stamp])) };
  } catch {
    throw new Error("Cannot read LSP document: require a stable singly-linked project-relative .py UTF-8 file, no traversal, links, sensitive paths or controls, at most 128 KiB.");
  }
}

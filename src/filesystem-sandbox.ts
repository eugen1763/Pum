import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { constants, realpathSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCheckModeConfig, rejectedToolDetails } from "./check-mode";
import { isCredentialSensitivePath } from "./check-policy";
import { parseApplyPatch } from "./apply-patch";
import {
  canonicalPathIdentityAllowMissing,
  isPathInsideOrSame,
  pathsHaveSameIdentity,
} from "./platform";

export const FILESYSTEM_SANDBOX_TOOL_NAMES = ["read", "write", "edit", "apply_patch"] as const;
type FilesystemSandboxToolName = (typeof FILESYSTEM_SANDBOX_TOOL_NAMES)[number];

export type SandboxPath = {
  absolute: string;
  root: string;
};

/** `read` resolves filename variants and may read PUM's own staged temp files. */
export type SandboxOperation = "read" | "write";

/**
 * Canonical directories PUM itself created this process for staged pasted text
 * and full bash output. They live outside the project, so the sandbox would
 * otherwise refuse the very paths PUM tells the agent to read. Only PUM
 * registers a root, always right after creating it, and only reads are allowed
 * inside one; a model-supplied temp path never matches.
 */
const temporaryReadRoots = new Set<string>();

export function registerSandboxTempReadRoot(path: string): string {
  const canonical = realpathSync(path);
  temporaryReadRoots.add(canonical);
  return canonical;
}

export function unregisterSandboxTempReadRoot(path: string): void {
  temporaryReadRoots.delete(path);
  try {
    temporaryReadRoots.delete(realpathSync(path));
  } catch {
    // An already removed directory keeps only the raw-path deletion above.
  }
}

function normalizeWindowsShellPath(input: string): string {
  if (process.platform !== "win32" || !input.startsWith("/") || input.startsWith("//") || input.includes("\\")) {
    return input;
  }
  const match = input.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return input;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

function normalizeToolPath(input: string): string {
  let normalized = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalizeWindowsShellPath(normalized);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

function windowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\/\//.test(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let candidate = path;
  while (!(await pathExists(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Sandbox cannot resolve path: ${path}`);
    candidate = parent;
  }
  return candidate;
}

const NARROW_NO_BREAK_SPACE = " ";
const RIGHT_SINGLE_QUOTATION_MARK = "’";

/**
 * pi's read tool never opens the literal model-supplied spelling. When that
 * spelling is missing, `resolveReadPathAsync` retries filename variants and
 * opens the first that exists, so the sandbox must check the same candidate.
 * This mirrors the order in
 * `@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js`; keep both in
 * step, and keep the existence test on `access` because pi uses `access` too.
 */
function readPathVariants(resolved: string): string[] {
  const narrowSpace = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
  const decomposed = resolved.normalize("NFD");
  const curly = resolved.replaceAll("'", RIGHT_SINGLE_QUOTATION_MARK);
  return [narrowSpace, decomposed, curly, decomposed.replaceAll("'", RIGHT_SINGLE_QUOTATION_MARK)];
}

async function accessible(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Return the path pi's read tool will actually open for this spelling. */
async function resolveReadCandidate(resolved: string): Promise<string> {
  if (await accessible(resolved)) return resolved;
  for (const variant of readPathVariants(resolved)) {
    if (variant !== resolved && await accessible(variant)) return variant;
  }
  return resolved;
}

/**
 * A hard link is an ordinary file to `lstat`, and `realpath` returns the
 * in-project name, so a second link can alias content outside the project.
 * `st_nlink` cannot say where the other links are, so a mutation of any
 * multiply linked regular file is refused. Residual limitation: this is a
 * check-time test, so a link created afterwards still aliases, and legitimate
 * multiply linked files (some package and build caches) are refused too. Copy
 * such a file before changing it. Reads are left alone because hard links are
 * common inside real project trees.
 */
async function rejectHardLinkAlias(path: string, inputPath: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isFile() && metadata.nlink > 1) {
    throw new Error(`path has more than one hard link, so it can alias content outside the sandbox: ${inputPath}`);
  }
}

async function rejectSymlinkComponents(root: string, path: string): Promise<void> {
  let candidate = path;
  while (true) {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`path contains a symbolic link or junction: ${path}`);
    }
    if (await pathsHaveSameIdentity(candidate, root)) return;
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`path is outside the sandbox: ${path}`);
    candidate = parent;
  }
}

function sandboxPathError(inputPath: string): Error {
  return new Error(`path is outside the sandbox: ${inputPath}`);
}

/**
 * Resolve a tool path against the project and verify its canonical boundary.
 * Missing final path components are allowed so write and Add File can create them.
 * A `read` is validated against the variant pi's read tool will open, and may
 * also reach PUM's own registered temporary read roots.
 */
export async function validateSandboxPath(
  cwd: string,
  inputPath: string,
  allowedPaths: readonly string[] = [],
  operation: SandboxOperation = "write",
): Promise<SandboxPath> {
  if (!inputPath || inputPath.includes("\0")) throw new Error("Sandbox path is invalid");
  const normalizedPath = normalizeToolPath(inputPath);
  if (windowsAbsolute(normalizedPath) && process.platform !== "win32") throw sandboxPathError(inputPath);

  const projectRoot = await realpath(cwd);
  const roots = [...new Set([
    ...await Promise.all([projectRoot, ...allowedPaths].map((path) => realpath(path))),
    ...(operation === "read" ? temporaryReadRoots : []),
  ])];
  const resolved = resolve(projectRoot, normalizedPath);
  const absolute = operation === "read" ? await resolveReadCandidate(resolved) : resolved;
  const existing = await nearestExistingPath(absolute);
  const canonical = await canonicalPathIdentityAllowMissing(absolute);
  const root = roots
    .slice()
    .sort((first, second) => second.length - first.length)
    .find((candidate) => isPathInsideOrSame(candidate, absolute)
      || isPathInsideOrSame(candidate, canonical));

  if (!root) throw sandboxPathError(inputPath);
  await rejectSymlinkComponents(root, existing);
  if (!isPathInsideOrSame(root, canonical)) throw new Error(`path resolves outside the sandbox: ${inputPath}`);
  if (isCredentialSensitivePath(canonical)) {
    throw new Error(`credential-sensitive path is blocked by the sandbox: ${inputPath}`);
  }
  if (operation !== "read") await rejectHardLinkAlias(absolute, inputPath);
  return { absolute, root };
}

/** Validate every path in an atomic Codex patch before the patch tool runs. */
export async function validateSandboxPatch(
  cwd: string,
  patch: string,
): Promise<void> {
  const operations = parseApplyPatch(patch);
  for (const operation of operations) {
    await validateSandboxPath(cwd, operation.path);
    if (operation.type === "update" && operation.moveTo) {
      await validateSandboxPath(cwd, operation.moveTo);
    }
  }
}

function toolPath(toolName: FilesystemSandboxToolName, input: Record<string, unknown>): string | undefined {
  if (toolName === "apply_patch") return undefined;
  return typeof input.path === "string" ? input.path : undefined;
}

/** Enforce the process-local filesystem sandbox before built-in tool execution. */
export type FilesystemSandboxExtensionOptions = {
  readonly?: boolean;
};

export function createFilesystemSandboxExtension(
  options: FilesystemSandboxExtensionOptions = {},
): InlineExtension {
  const readonly = options.readonly === true;
  return {
    name: readonly ? "pum-readonly-filesystem-sandbox" : "pum-filesystem-sandbox",
    factory(pi) {
      const rejected = new Map<string, string>();
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n## Filesystem sandbox\n\n`
          + "- The read, write, and edit tools are limited to the project and configured allowed roots.\n"
          + "- The apply_patch tool is limited to the project and validates every patch path.\n"
          + (readonly ? "- This readonly child cannot use write, edit, or apply_patch.\n" : "")
          + "- The read tool may also read the temporary files PUM stages for you, such as pasted text and full bash output.\n"
          + "- Do not access credential-sensitive paths or paths through symbolic links or junctions.\n"
          + "- Do not attempt to bypass the filesystem sandbox with alternate path spellings.",
      }));

      pi.on("tool_call", async (event, ctx) => {
        if (!(FILESYSTEM_SANDBOX_TOOL_NAMES as readonly string[]).includes(event.toolName)) return;
        const toolName = event.toolName as FilesystemSandboxToolName;
        try {
          if (readonly && toolName !== "read") {
            throw new Error(`readonly child cannot use ${toolName}`);
          }
          const allowedPaths = getCheckModeConfig().additionalPaths;
          if (toolName === "apply_patch") {
            const patch = (event.input as Record<string, unknown>).patch;
            if (typeof patch !== "string") throw new Error("apply_patch requires a patch string");
            await validateSandboxPatch(ctx.cwd, patch);
          } else {
            const path = toolPath(toolName, event.input);
            if (!path) throw new Error(`${toolName} requires a path`);
            await validateSandboxPath(ctx.cwd, path, allowedPaths, toolName === "read" ? "read" : "write");
          }
        } catch (error) {
          const reason = `Filesystem sandbox blocked ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
          rejected.set(event.toolCallId, reason);
          return {
            block: true,
            reason,
          };
        }
      });

      pi.on("tool_result", (event) => {
        const reason = rejected.get(event.toolCallId);
        if (!reason) return;
        return { details: rejectedToolDetails(event.details, reason) };
      });

      pi.on("message_end", (event) => {
        const message = event.message as any;
        if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") return;
        const reason = rejected.get(message.toolCallId);
        if (!reason) return;
        rejected.delete(message.toolCallId);
        return { message: { ...message, details: rejectedToolDetails(message.details, reason) } };
      });
    },
  };
}

export const filesystemSandboxExtension = createFilesystemSandboxExtension();

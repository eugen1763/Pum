import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCheckModeConfig } from "./check-mode";
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
 */
export async function validateSandboxPath(
  cwd: string,
  inputPath: string,
  allowedPaths: readonly string[] = [],
): Promise<SandboxPath> {
  if (!inputPath || inputPath.includes("\0")) throw new Error("Sandbox path is invalid");
  const normalizedPath = normalizeToolPath(inputPath);
  if (windowsAbsolute(normalizedPath) && process.platform !== "win32") throw sandboxPathError(inputPath);

  const projectRoot = await realpath(cwd);
  const roots = [...new Set(await Promise.all(
    [projectRoot, ...allowedPaths].map((path) => realpath(path)),
  ))];
  const absolute = resolve(projectRoot, normalizedPath);
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
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n## Filesystem sandbox\n\n`
          + "- The read, write, and edit tools are limited to the project and configured allowed roots.\n"
          + "- The apply_patch tool is limited to the project and validates every patch path.\n"
          + (readonly ? "- This readonly child cannot use write, edit, or apply_patch.\n" : "")
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
            await validateSandboxPath(ctx.cwd, path, allowedPaths);
          }
        } catch (error) {
          return {
            block: true,
            reason: `Filesystem sandbox blocked ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      });
    },
  };
}

export const filesystemSandboxExtension = createFilesystemSandboxExtension();

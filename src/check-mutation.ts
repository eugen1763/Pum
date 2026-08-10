import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { previewApplyPatch } from "./apply-patch";
import type { CheckedToolName } from "./check-approvals";
import {
  canonicalPathIdentityAllowMissing,
  isPathInsideOrSame,
  pathIdentity,
  pathsHaveSameIdentity,
} from "./platform";

export type MutationSensitivity = {
  executable: boolean;
  config: boolean;
  credential: boolean;
};

export type MutationPreview = {
  toolName: "edit" | "apply_patch";
  unifiedDiff: string;
  changedPaths: string[];
  additions: number;
  removals: number;
  sensitivity: MutationSensitivity;
  destructive: boolean;
  deletedPaths: number;
  projectContained: true;
  contentChars: number;
  contentSha256: string;
  suspiciousFindings: string[];
};

const CONFIG_NAMES = new Set([
  "package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "tsconfig.json", "jsconfig.json", "dockerfile", "compose.yaml", "compose.yml", "makefile",
  "cargo.toml", "cargo.lock", "pyproject.toml", "requirements.txt", "go.mod", "go.sum",
]);
const CREDENTIAL_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "auth.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts",
]);

export function pathSensitivity(path: string, mode?: number): MutationSensitivity {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  const credential = CREDENTIAL_NAMES.has(name)
    || normalized.includes("/.ssh/")
    || normalized.includes("/.aws/")
    || normalized.includes("/.config/gcloud/")
    || /(?:^|\/)\.env(?:\.|$)/.test(normalized)
    || /(?:secret|token|credential|private[-_.]?key)/.test(name);
  const config = CONFIG_NAMES.has(name)
    || /(?:^|\/)(?:\.github\/workflows|\.gitlab|\.circleci|\.husky|scripts|config)(?:\/|$)/.test(normalized)
    || /\.(?:json|ya?ml|toml|ini|conf|config|properties)$/.test(name);
  const executable = Boolean(mode && (mode & 0o111))
    || /(?:^|\/)bin\//.test(normalized)
    || /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|exe|com)$/.test(name);
  return { executable, config, credential };
}

function mergeSensitivity(values: MutationSensitivity[]): MutationSensitivity {
  return values.reduce((result, value) => ({
    executable: result.executable || value.executable,
    config: result.config || value.config,
    credential: result.credential || value.credential,
  }), { executable: false, config: false, credential: false });
}

function windowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\/\//.test(path);
}

async function validateEditPath(
  cwd: string,
  inputPath: string,
  allowedPaths: readonly string[],
): Promise<{ root: string; absolute: string; display: string; mode: number }> {
  if (!inputPath || inputPath.includes("\0")) throw new Error("Edit path is invalid");
  if (windowsAbsolute(inputPath) && process.platform !== "win32") {
    throw new Error(`Edit path is outside the project: ${inputPath}`);
  }
  const projectRoot = await realpath(cwd);
  const roots = await Promise.all([projectRoot, ...allowedPaths].map((path) => realpath(path)));
  const absolute = resolve(projectRoot, inputPath);
  const sortedRoots = roots.sort((first, second) => second.length - first.length);
  let root = sortedRoots.find((candidate) => isPathInsideOrSame(candidate, absolute));
  if (!root) {
    let targetIdentity: string;
    try {
      targetIdentity = await canonicalPathIdentityAllowMissing(absolute);
    } catch {
      throw new Error(`Edit path is outside the allowed Check mode paths: ${inputPath}`);
    }
    root = sortedRoots.find((candidate) => isPathInsideOrSame(pathIdentity(candidate), targetIdentity));
  }
  if (!root) throw new Error(`Edit path is outside the allowed Check mode paths: ${inputPath}`);
  const canonical = await realpath(absolute);

  let component = absolute;
  while (true) {
    const metadata = await lstat(component);
    if (metadata.isSymbolicLink()) throw new Error(`Edit path contains an escaping link or junction: ${inputPath}`);
    if (await pathsHaveSameIdentity(component, root)) break;
    const parent = dirname(component);
    if (parent === component) throw new Error(`Edit path is outside the allowed Check mode paths: ${inputPath}`);
    component = parent;
  }
  if (!isPathInsideOrSame(root, canonical)) throw new Error(`Edit path resolves outside the project: ${inputPath}`);
  const metadata = await lstat(absolute);
  if (!metadata.isFile()) throw new Error(`Edit path is not a file: ${inputPath}`);
  const display = isPathInsideOrSame(projectRoot, canonical)
    ? relative(projectRoot, canonical).split(sep).join("/")
    : absolute;
  return { root, absolute, display, mode: metadata.mode };
}

function occurrences(content: string, needle: string): number[] {
  if (!needle) return [];
  const matches: number[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    matches.push(index);
    offset = index + Math.max(1, needle.length);
  }
  return matches;
}

function lineCounts(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) removals++;
  }
  return { additions, removals };
}

function mutationSuspiciousFindings(patch: string): string[] {
  const added = patch.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  const findings: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,240}\s-(?:enc|encodedcommand)\b/i, "encoded PowerShell execution"],
    [/\b(?:eval|exec)\b[^\n]{0,240}\b(?:base64|frombase64string|\\x[0-9a-f]{2})\b/i, "decoded or encoded dynamic execution"],
    [/\b(?:base64\s+(?:--decode|-d)|openssl\s+base64\s+-d)\b[^\n]{0,240}\|\s*(?:ba|da|z|k)?sh\b/i, "encoded payload piped to a shell"],
    [/\b(?:curl|wget|fetch)\b[^\n]{0,240}\|\s*(?:ba|da|z|k)?sh\b/i, "remote payload piped to a shell"],
  ];
  for (const [pattern, message] of checks) {
    if (pattern.test(added)) findings.push(message);
  }
  return findings;
}

function completeContentMetadata(patch: string): Pick<MutationPreview, "contentChars" | "contentSha256" | "suspiciousFindings"> {
  return {
    contentChars: patch.length,
    contentSha256: createHash("sha256").update(patch).digest("hex"),
    suspiciousFindings: mutationSuspiciousFindings(patch),
  };
}

async function previewEdit(cwd: string, input: unknown, allowedPaths: readonly string[]): Promise<MutationPreview> {
  if (!input || typeof input !== "object") throw new Error("Edit input is invalid");
  const value = input as { path?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown };
  if (typeof value.path !== "string") throw new Error("Edit path is invalid");
  let edits = value.edits;
  if (typeof edits === "string") {
    try { edits = JSON.parse(edits); } catch { throw new Error("Edit replacements are invalid JSON"); }
  }
  const replacements = Array.isArray(edits) ? [...edits] : [];
  if (typeof value.oldText === "string" && typeof value.newText === "string") {
    replacements.push({ oldText: value.oldText, newText: value.newText });
  }
  if (replacements.length === 0 || !replacements.every((edit) =>
    edit && typeof edit === "object"
    && typeof (edit as any).oldText === "string"
    && typeof (edit as any).newText === "string",
  )) throw new Error("Edit replacements are invalid");

  const validated = await validateEditPath(cwd, value.path, allowedPaths);
  const buffer = await readFile(validated.absolute);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Edit file is not valid UTF-8: ${validated.display}`);
  }
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const base = bom ? content.slice(1) : content;
  const located = replacements.map((edit: any, index) => {
    if (!edit.oldText) throw new Error(`Edit replacement ${index + 1} has empty oldText`);
    const matches = occurrences(base, edit.oldText);
    if (matches.length === 0) throw new Error(`Edit context is stale or missing for ${validated.display}`);
    if (matches.length > 1) throw new Error(`Edit context is ambiguous for ${validated.display}`);
    return { start: matches[0]!, end: matches[0]! + edit.oldText.length, newText: edit.newText };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < located.length; index++) {
    if (located[index]!.start < located[index - 1]!.end) {
      throw new Error(`Edit replacements overlap in ${validated.display}`);
    }
  }
  let next = base;
  for (const edit of [...located].reverse()) next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
  const patch = generateUnifiedPatch(validated.display, base, next);
  return {
    toolName: "edit",
    unifiedDiff: patch,
    changedPaths: [validated.display],
    ...lineCounts(patch),
    sensitivity: pathSensitivity(validated.display, validated.mode),
    destructive: false,
    deletedPaths: 0,
    projectContained: true,
    ...completeContentMetadata(patch),
  };
}

export async function previewMutation(
  toolName: CheckedToolName,
  cwd: string,
  input: unknown,
  allowedPaths: readonly string[] = [],
): Promise<MutationPreview | undefined> {
  if (toolName === "edit") return previewEdit(cwd, input, allowedPaths);
  if (toolName !== "apply_patch") return undefined;
  if (!input || typeof input !== "object" || typeof (input as { patch?: unknown }).patch !== "string") {
    throw new Error("Apply patch input is invalid");
  }
  const preview = await previewApplyPatch(cwd, (input as { patch: string }).patch);
  return {
    toolName: "apply_patch",
    unifiedDiff: preview.patch,
    changedPaths: preview.files,
    additions: preview.additions,
    removals: preview.removals,
    sensitivity: mergeSensitivity(preview.files.map((path) => pathSensitivity(path))),
    destructive: preview.operations.some((operation) => operation.type === "delete"),
    deletedPaths: preview.operations.filter((operation) => operation.type === "delete").length,
    projectContained: true,
    ...completeContentMetadata(preview.patch),
  };
}

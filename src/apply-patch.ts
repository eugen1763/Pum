import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export type ApplyPatchInput = { patch: string };

type PatchLine = { text: string; number: number };
type PatchHunk = {
  header?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
  line: number;
};
type AddOperation = { type: "add"; path: string; lines: string[] };
type DeleteOperation = { type: "delete"; path: string };
type UpdateOperation = { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };
export type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;

export type ApplyPatchDetails = {
  patch: string;
  files: string[];
  operations: Array<{ type: PatchOperation["type"]; path: string; moveTo?: string }>;
};

export type ApplyPatchPreview = ApplyPatchDetails & {
  additions: number;
  removals: number;
  projectContained: true;
};

type FileSnapshot = {
  exists: boolean;
  buffer?: Buffer;
  mode?: number;
};

type FileOutput = {
  path: string;
  buffer: Buffer;
  mode?: number;
};

type PreparedChange = {
  operation: PatchOperation;
  sourcePath: string;
  destinationPath?: string;
  oldText: string;
  newText: string;
};

export type ApplyPatchFileSystem = {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
  mkdir: typeof mkdir;
  rmdir: typeof rmdir;
  lstat: typeof lstat;
  realpath: typeof realpath;
  chmod: typeof chmod;
};

const defaultFileSystem: ApplyPatchFileSystem = {
  readFile,
  writeFile,
  rename,
  rm,
  mkdir,
  rmdir,
  lstat,
  realpath,
  chmod,
};

function patchError(message: string, line?: number): Error {
  return new Error(line === undefined ? `Invalid patch: ${message}` : `Invalid patch at line ${line}: ${message}`);
}

function normalizedPatchLines(patch: string): PatchLine[] {
  if (patch.includes("\0")) throw patchError("NUL bytes are not allowed");
  const normalized = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  return normalized.split("\n").map((text, index) => ({ text, number: index + 1 }));
}

function fileMarker(line: string): boolean {
  return line.startsWith("*** Add File: ")
    || line.startsWith("*** Update File: ")
    || line.startsWith("*** Delete File: ")
    || line === "*** End Patch";
}

function markerPath(line: PatchLine, marker: string): string {
  const path = line.text.slice(marker.length).trim();
  if (!path) throw patchError("a file header requires a path", line.number);
  return normalizePatchPath(path, line.number);
}

/** Parse the documented OpenAI Codex patch envelope before any filesystem access. */
export function parseApplyPatch(patch: string): PatchOperation[] {
  if (typeof patch !== "string") throw patchError("patch must be a string");
  const lines = normalizedPatchLines(patch);
  if (lines[0]?.text.trim() !== "*** Begin Patch") {
    throw patchError("the first line must be '*** Begin Patch'", lines[0]?.number);
  }
  if (lines.at(-1)?.text.trim() !== "*** End Patch") {
    throw patchError("the last line must be '*** End Patch'", lines.at(-1)?.number);
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    if (line.text.startsWith("*** Add File: ")) {
      const path = markerPath(line, "*** Add File: ");
      const content: string[] = [];
      index++;
      while (index < lines.length - 1 && !fileMarker(lines[index]!.text)) {
        const contentLine = lines[index]!;
        if (!contentLine.text.startsWith("+")) {
          throw patchError("every Add File content line must start with '+'", contentLine.number);
        }
        content.push(contentLine.text.slice(1));
        index++;
      }
      if (content.length === 0) throw patchError("Add File requires at least one content line", line.number);
      operations.push({ type: "add", path, lines: content });
      continue;
    }

    if (line.text.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: markerPath(line, "*** Delete File: ") });
      index++;
      continue;
    }

    if (line.text.startsWith("*** Update File: ")) {
      const path = markerPath(line, "*** Update File: ");
      let moveTo: string | undefined;
      const hunks: PatchHunk[] = [];
      index++;
      if (lines[index]?.text.startsWith("*** Move to: ")) {
        moveTo = markerPath(lines[index]!, "*** Move to: ");
        index++;
      }

      while (index < lines.length - 1 && !fileMarker(lines[index]!.text)) {
        const header = lines[index]!;
        if (header.text !== "@@" && !header.text.startsWith("@@ ")) {
          throw patchError("an Update File hunk must start with '@@'", header.number);
        }
        const hunk: PatchHunk = {
          header: header.text === "@@" ? undefined : header.text.slice(3),
          oldLines: [],
          newLines: [],
          endOfFile: false,
          line: header.number,
        };
        let changed = false;
        index++;
        while (index < lines.length - 1) {
          const hunkLine = lines[index]!;
          if (fileMarker(hunkLine.text) || hunkLine.text === "@@" || hunkLine.text.startsWith("@@ ")) break;
          if (hunkLine.text === "*** End of File") {
            hunk.endOfFile = true;
            index++;
            break;
          }
          const prefix = hunkLine.text[0];
          const text = hunkLine.text.slice(1);
          if (prefix === " ") {
            hunk.oldLines.push(text);
            hunk.newLines.push(text);
          } else if (prefix === "-") {
            hunk.oldLines.push(text);
            changed = true;
          } else if (prefix === "+") {
            hunk.newLines.push(text);
            changed = true;
          } else {
            throw patchError("hunk lines must start with ' ', '+', or '-'", hunkLine.number);
          }
          index++;
        }
        if (!changed) throw patchError("a hunk must add or remove at least one line", hunk.line);
        hunks.push(hunk);
      }
      if (!moveTo && hunks.length === 0) throw patchError("Update File requires a hunk or Move to", line.number);
      operations.push({ type: "update", path, moveTo, hunks });
      continue;
    }

    throw patchError("expected Add File, Update File, or Delete File", line.number);
  }

  if (operations.length === 0) throw patchError("the patch contains no file operations");
  return operations;
}

/** Convert Windows separators safely, but reject every absolute or parent path. */
export function normalizePatchPath(input: string, line?: number): string {
  const path = input.replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.startsWith("//")) {
    throw patchError(`absolute paths are not allowed: ${input}`, line);
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "..")) throw patchError(`parent traversal is not allowed: ${input}`, line);
  const clean = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (!clean) throw patchError(`invalid project path: ${input}`, line);
  return clean;
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function pathExists(path: string, fs: ApplyPatchFileSystem): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validateProjectPath(root: string, path: string, fs: ApplyPatchFileSystem): Promise<string> {
  if (!insideRoot(root, path)) throw new Error(`Patch path is outside the project: ${path}`);
  let candidate = path;
  while (!(await pathExists(candidate, fs))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Cannot resolve patch path: ${path}`);
    candidate = parent;
  }
  const relativeCandidate = relative(root, candidate);
  let component = root;
  for (const part of relativeCandidate.split(sep).filter(Boolean)) {
    component = resolve(component, part);
    const metadata = await fs.lstat(component);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Patch paths cannot contain symbolic links: ${path}`);
    }
  }
  const resolved = await fs.realpath(candidate);
  const canonicalPath = resolve(resolved, relative(candidate, path));
  if (!insideRoot(root, canonicalPath)) throw new Error(`Patch path resolves outside the project: ${path}`);
  if (candidate === path) {
    const metadata = await fs.lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Patch paths cannot be symbolic links: ${path}`);
    if (metadata.isDirectory()) throw new Error(`Patch paths must be files: ${path}`);
  }
  return canonicalPath;
}

function decodeText(buffer: Buffer, path: string): { text: string; bom: string } {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Patch file is not valid UTF-8: ${path}`);
  }
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  return { text: bom ? decoded.slice(1) : decoded, bom };
}

function lineFormat(text: string): { lines: string[]; ending: "\n" | "\r\n"; finalNewline: boolean } {
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  if (lines.length === 1 && lines[0] === "") lines.pop();
  return { lines, ending, finalNewline };
}

function occurrences(lines: string[], pattern: string[], start: number, endOfFile: boolean): number[] {
  if (pattern.length === 0) return [];
  const matches: number[] = [];
  for (let index = start; index + pattern.length <= lines.length; index++) {
    if (endOfFile && index + pattern.length !== lines.length) continue;
    if (pattern.every((line, offset) => lines[index + offset] === line)) matches.push(index);
  }
  return matches;
}

function uniqueMatch(lines: string[], pattern: string[], start: number, path: string, label: string, eof: boolean): number {
  const matches = occurrences(lines, pattern, start, eof);
  if (matches.length === 0) throw new Error(`Failed to find ${label} in ${path}:\n${pattern.join("\n")}`);
  if (matches.length > 1) throw new Error(`Ambiguous ${label} in ${path}: matched ${matches.length} locations`);
  return matches[0]!;
}

function applyHunks(text: string, bom: string, path: string, hunks: PatchHunk[]): string {
  const format = lineFormat(text);
  const replacements: Array<{ start: number; length: number; lines: string[] }> = [];
  let searchStart = 0;

  for (const hunk of hunks) {
    let anchor: number | undefined;
    if (hunk.header !== undefined) {
      anchor = uniqueMatch(format.lines, [hunk.header], searchStart, path, `hunk context '${hunk.header}'`, false);
      searchStart = anchor + 1;
    }

    if (hunk.oldLines.length === 0) {
      const start = hunk.endOfFile ? format.lines.length : anchor === undefined ? format.lines.length : anchor + 1;
      replacements.push({ start, length: 0, lines: hunk.newLines });
      searchStart = start;
      continue;
    }

    const start = uniqueMatch(format.lines, hunk.oldLines, searchStart, path, "expected hunk lines", hunk.endOfFile);
    replacements.push({ start, length: hunk.oldLines.length, lines: hunk.newLines });
    searchStart = start + hunk.oldLines.length;
  }

  const result = [...format.lines];
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result.splice(replacement.start, replacement.length, ...replacement.lines);
  }
  let normalized = result.join("\n");
  if (format.finalNewline) normalized += "\n";
  return bom + normalized.replaceAll("\n", format.ending);
}

async function snapshot(path: string, fs: ApplyPatchFileSystem): Promise<FileSnapshot> {
  try {
    const metadata = await fs.lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Patch paths cannot be symbolic links: ${path}`);
    if (!metadata.isFile()) throw new Error(`Patch paths must be files: ${path}`);
    return { exists: true, buffer: await fs.readFile(path), mode: metadata.mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

function operationPaths(root: string, operation: PatchOperation): { source: string; destination?: string } {
  const source = resolve(root, ...operation.path.split("/"));
  const destination = operation.type === "update" && operation.moveTo
    ? resolve(root, ...operation.moveTo.split("/"))
    : undefined;
  return { source, destination };
}

async function withMutationQueues<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const unique = [...new Set(paths)].sort();
  const acquire = (index: number): Promise<T> => {
    const path = unique[index];
    return path === undefined
      ? operation()
      : withFileMutationQueue(path, () => acquire(index + 1));
  };
  return acquire(0);
}

async function createMissingDirectories(
  path: string,
  root: string,
  fs: ApplyPatchFileSystem,
  created: string[],
): Promise<void> {
  const missing: string[] = [];
  let candidate = path;
  while (candidate !== root && !(await pathExists(candidate, fs))) {
    missing.push(candidate);
    candidate = dirname(candidate);
  }
  for (const directory of missing.reverse()) {
    await fs.mkdir(directory);
    created.push(directory);
  }
}

async function cleanupDirectories(directories: string[], fs: ApplyPatchFileSystem): Promise<void> {
  for (const directory of [...directories].reverse()) {
    await fs.rmdir(directory).catch(() => {});
  }
}

async function commitAtomically(
  root: string,
  outputs: FileOutput[],
  touchedPaths: string[],
  fs: ApplyPatchFileSystem,
): Promise<void> {
  const token = `${process.pid}-${randomUUID()}`;
  const stages = new Map<string, string>();
  const backups = new Map<string, string>();
  const placed = new Set<string>();
  const createdDirectories: string[] = [];

  try {
    for (const output of outputs) {
      await createMissingDirectories(dirname(output.path), root, fs, createdDirectories);
      const stage = resolve(dirname(output.path), `.pum-apply-patch-${token}-${stages.size}.tmp`);
      await fs.writeFile(stage, output.buffer, { flag: "wx" });
      stages.set(output.path, stage);
      if (output.mode !== undefined) await fs.chmod(stage, output.mode);
    }

    for (const path of [...new Set(touchedPaths)].sort()) {
      if (!(await pathExists(path, fs))) continue;
      const backup = resolve(dirname(path), `.pum-apply-patch-${token}-${backups.size}.bak`);
      await fs.rename(path, backup);
      backups.set(path, backup);
    }

    for (const output of outputs.sort((a, b) => a.path.localeCompare(b.path))) {
      const stage = stages.get(output.path)!;
      await fs.rename(stage, output.path);
      stages.delete(output.path);
      placed.add(output.path);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const path of [...placed].reverse()) {
      await fs.rm(path, { force: true }).catch((rollbackError) => rollbackErrors.push(String(rollbackError)));
    }
    for (const [path, backup] of [...backups].reverse()) {
      await fs.rename(backup, path).catch((rollbackError) => rollbackErrors.push(String(rollbackError)));
    }
    for (const stage of stages.values()) {
      await fs.rm(stage, { force: true }).catch(() => {});
    }
    await cleanupDirectories(createdDirectories, fs);
    const suffix = rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`Could not apply patch atomically: ${String(error)}.${suffix}`);
  }

  for (const backup of backups.values()) await fs.rm(backup, { force: true }).catch(() => {});
  await cleanupDirectories(createdDirectories, fs);
}

async function prepareChanges(
  root: string,
  operations: PatchOperation[],
  fs: ApplyPatchFileSystem,
): Promise<{ changes: PreparedChange[]; outputs: FileOutput[]; touched: string[] }> {
  const snapshots = new Map<string, FileSnapshot>();
  const pathOwners = new Map<string, string>();
  const changes: PreparedChange[] = [];
  const outputs: FileOutput[] = [];
  const touched: string[] = [];

  const claim = (path: string, description: string) => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const previous = pathOwners.get(key);
    if (previous) throw new Error(`Conflicting patch paths: ${previous} and ${description}`);
    pathOwners.set(key, description);
  };

  for (const operation of operations) {
    const { source, destination } = operationPaths(root, operation);
    const canonicalSource = await validateProjectPath(root, source, fs);
    const canonicalDestination = destination
      ? await validateProjectPath(root, destination, fs)
      : undefined;
    if (destination && destination !== source && canonicalDestination === canonicalSource) {
      throw new Error(`Move destination resolves to its source: ${operation.path}`);
    }
    claim(canonicalSource, operation.path);
    if (canonicalDestination && canonicalDestination !== canonicalSource && operation.type === "update") {
      claim(canonicalDestination, operation.moveTo!);
    }
    snapshots.set(source, await snapshot(source, fs));
    if (destination && destination !== source) snapshots.set(destination, await snapshot(destination, fs));
  }

  for (const operation of operations) {
    const { source, destination } = operationPaths(root, operation);
    const sourceSnapshot = snapshots.get(source)!;
    if (operation.type === "add") {
      const oldText = sourceSnapshot.exists ? decodeText(sourceSnapshot.buffer!, operation.path).text : "";
      const newText = `${operation.lines.join("\n")}\n`;
      outputs.push({ path: source, buffer: Buffer.from(newText), mode: sourceSnapshot.mode });
      touched.push(source);
      changes.push({ operation, sourcePath: source, oldText, newText });
      continue;
    }
    if (!sourceSnapshot.exists) throw new Error(`Patch source does not exist: ${operation.path}`);
    const decoded = decodeText(sourceSnapshot.buffer!, operation.path);
    if (operation.type === "delete") {
      touched.push(source);
      changes.push({ operation, sourcePath: source, oldText: decoded.text, newText: "" });
      continue;
    }

    const newText = applyHunks(decoded.text, decoded.bom, operation.path, operation.hunks);
    const target = destination ?? source;
    const targetSnapshot = snapshots.get(target) ?? sourceSnapshot;
    outputs.push({ path: target, buffer: Buffer.from(newText), mode: sourceSnapshot.mode ?? targetSnapshot.mode });
    touched.push(source);
    if (target !== source) touched.push(target);
    changes.push({ operation, sourcePath: source, destinationPath: destination, oldText: decoded.bom + decoded.text, newText });
  }

  return { changes, outputs, touched };
}

function detailsPatch(changes: PreparedChange[]): string {
  return changes.map((change) => {
    const displayPath = change.operation.type === "update" && change.operation.moveTo
      ? change.operation.moveTo
      : change.operation.path;
    const oldText = change.oldText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const newText = change.newText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return generateUnifiedPatch(displayPath, oldText, newText);
  }).join("");
}

function patchCounts(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) removals++;
  }
  return { additions, removals };
}

/** Prepare and validate the complete patch without changing the filesystem. */
export async function previewApplyPatch(
  cwd: string,
  patch: string,
  options: { fs?: ApplyPatchFileSystem } = {},
): Promise<ApplyPatchPreview> {
  const operations = parseApplyPatch(patch);
  const fs = options.fs ?? defaultFileSystem;
  const root = await fs.realpath(cwd);
  const prepared = await prepareChanges(root, operations, fs);
  const unified = detailsPatch(prepared.changes);
  const files = operations.map((operation) => operation.type === "update" && operation.moveTo
    ? operation.moveTo
    : operation.path);
  return {
    patch: unified,
    files,
    operations: operations.map((operation) => ({
      type: operation.type,
      path: operation.path,
      ...(operation.type === "update" && operation.moveTo ? { moveTo: operation.moveTo } : {}),
    })),
    ...patchCounts(unified),
    projectContained: true,
  };
}

export async function applyPatch(
  cwd: string,
  patch: string,
  options: { fs?: ApplyPatchFileSystem; signal?: AbortSignal } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ApplyPatchDetails }> {
  const operations = parseApplyPatch(patch);
  const fs = options.fs ?? defaultFileSystem;
  const root = await fs.realpath(cwd);
  const paths = operations.flatMap((operation) => {
    const resolved = operationPaths(root, operation);
    return resolved.destination ? [resolved.source, resolved.destination] : [resolved.source];
  });

  const queuePaths = await Promise.all(paths.map((path) => validateProjectPath(root, path, fs)));
  return withMutationQueues(queuePaths, async () => {
    if (options.signal?.aborted) throw new Error("Operation aborted");
    const prepared = await prepareChanges(root, operations, fs);
    if (options.signal?.aborted) throw new Error("Operation aborted");
    await commitAtomically(root, prepared.outputs, prepared.touched, fs);

    const files = operations.map((operation) => operation.type === "update" && operation.moveTo
      ? operation.moveTo
      : operation.path);
    const details: ApplyPatchDetails = {
      patch: detailsPatch(prepared.changes),
      files,
      operations: operations.map((operation) => ({
        type: operation.type,
        path: operation.path,
        ...(operation.type === "update" && operation.moveTo ? { moveTo: operation.moveTo } : {}),
      })),
    };
    return {
      content: [{
        type: "text",
        text: `Applied patch to ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}`,
      }],
      details,
    };
  });
}

export const applyPatchExtension: InlineExtension = {
  name: "pum-apply-patch",
  factory(pi) {
    pi.registerTool({
      name: APPLY_PATCH_TOOL_NAME,
      label: "Apply Patch",
      description: "Apply an OpenAI Codex patch atomically inside the project. Supports Add File, Update File, Delete File, Move to, multiple files, and multiple hunks.",
      promptSnippet: "Apply a multi-file OpenAI Codex patch atomically",
      promptGuidelines: [
        "Use apply_patch for one atomic patch that changes one or more files.",
        "Start with *** Begin Patch and finish with *** End Patch.",
        "Use only project-relative paths in Add File, Update File, Delete File, and Move to headers.",
      ],
      parameters: Type.Object({
        patch: Type.String({ description: "Complete OpenAI Codex patch text, including the Begin Patch and End Patch markers" }),
      }),
      execute: async (_id, params, signal, _update, ctx) => applyPatch(ctx.cwd, params.patch, { signal }),
    });
  },
};

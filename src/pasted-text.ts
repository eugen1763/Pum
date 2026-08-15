import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSandboxTempReadRoot, unregisterSandboxTempReadRoot } from "./filesystem-sandbox";

/** Pasted text at or below this size stays inline in the draft. */
export const MAX_PASTED_TEXT_BYTES = 16 * 1024;

export type PendingPastedText = {
  id: number;
  marker: string;
  /** Absolute temp-file path, `read`-able by the agent during the turn. */
  path: string;
  /** UTF-8 byte size of the staged text. */
  bytes: number;
  start: number;
  end: number;
};

let pastedTextDir: string | null = null;
let fileSequence = 0;

function ensurePastedTextDir(): string {
  if (pastedTextDir === null) {
    const created = mkdtempSync(join(tmpdir(), "pum-pasted-text-"));
    // The agent is told to read these files, and the filesystem sandbox allows
    // only the project and configured roots. Register this exact directory,
    // which PUM just created, as a read-only sandbox root.
    registerSandboxTempReadRoot(created);
    pastedTextDir = created;
  }
  return pastedTextDir;
}

/** Write pasted text to a private temp file under the system temp dir. */
export function stagePastedText(text: string): { path: string; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  const path = join(ensurePastedTextDir(), `pasted-${++fileSequence}.txt`);
  writeFileSync(path, text, "utf8");
  return { path, bytes };
}

/**
 * The model-facing text that replaces a `[Pasted text #n]` marker on send.
 * The absolute temp path always sits alone on its own line so the agent can
 * pass it straight to the `read` tool.
 */
export function pastedTextReadBlock(item: PendingPastedText): string {
  const kib = Math.max(1, Math.round(item.bytes / 1024));
  return [
    `${item.marker}: the pasted text (${kib} KiB) is too large to keep inline.`,
    "Read this temp file with the read tool:",
    item.path,
  ].join("\n");
}

export function removePendingPastedText(item: PendingPastedText): void {
  try {
    unlinkSync(item.path);
  } catch {
    // The file can already be gone during shutdown or failed-send cleanup.
  }
}

export function cleanupPendingPastedTexts(): void {
  if (!pastedTextDir) return;
  unregisterSandboxTempReadRoot(pastedTextDir);
  try {
    rmSync(pastedTextDir, { recursive: true, force: true });
  } catch {
    // Temporary pasted-text cleanup must not break shutdown.
  }
  pastedTextDir = null;
}

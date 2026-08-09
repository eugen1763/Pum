import type { ImageContent } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
] as const;

export type PendingImage = {
  id: number;
  marker: string;
  path: string;
  mimeType: string;
  start: number;
  end: number;
};

let imageDir: string | null = null;
let fileSequence = 0;

function ensureImageDir(): string {
  imageDir ??= mkdtempSync(join(tmpdir(), "pum-images-"));
  return imageDir;
}

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        child.kill();
        reject(new Error("Clipboard image is larger than 25 MB"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} failed`));
    });
  });
}

async function readWaylandClipboard(): Promise<{ data: Buffer; mimeType: string; ext: string }> {
  const offered = (await run("wl-paste", ["--list-types"]))
    .toString("utf8")
    .split(/\r?\n/)
    .map((type) => type.trim().toLowerCase());
  const imageType = IMAGE_TYPES.find(([mimeType]) => offered.includes(mimeType));
  if (!imageType) throw new Error("Clipboard does not contain an image");
  const [mimeType, ext] = imageType;
  const data = await run("wl-paste", ["--no-newline", "--type", mimeType]);
  if (data.length === 0) throw new Error("Clipboard image is empty");
  return { data, mimeType, ext };
}

async function readX11Clipboard(): Promise<{ data: Buffer; mimeType: string; ext: string }> {
  const offered = (await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]))
    .toString("utf8")
    .split(/\r?\n/)
    .map((type) => type.trim().toLowerCase());
  const imageType = IMAGE_TYPES.find(([mimeType]) => offered.includes(mimeType));
  if (!imageType) throw new Error("Clipboard does not contain an image");
  const [mimeType, ext] = imageType;
  const data = await run("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
  if (data.length === 0) throw new Error("Clipboard image is empty");
  return { data, mimeType, ext };
}

export async function captureClipboardImage(): Promise<{ path: string; mimeType: string }> {
  let image: { data: Buffer; mimeType: string; ext: string };
  if (process.env.WAYLAND_DISPLAY) image = await readWaylandClipboard();
  else if (process.env.DISPLAY) image = await readX11Clipboard();
  else throw new Error("No supported graphical clipboard is available");

  const path = join(ensureImageDir(), `image-${++fileSequence}.${image.ext}`);
  writeFileSync(path, image.data);
  return { path, mimeType: image.mimeType };
}

export function imageContent(image: PendingImage): ImageContent {
  return {
    type: "image",
    data: readFileSync(image.path).toString("base64"),
    mimeType: image.mimeType,
  };
}

export function removePendingImage(image: PendingImage): void {
  try {
    unlinkSync(image.path);
  } catch {
    // The file can already be gone during shutdown or failed-send cleanup.
  }
}

export function cleanupPendingImages(): void {
  if (!imageDir) return;
  try {
    rmSync(imageDir, { recursive: true, force: true });
  } catch {
    // Temporary image cleanup must not break shutdown.
  }
  imageDir = null;
}

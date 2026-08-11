import { spawn } from "node:child_process";

const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024;
const WINDOWS_CLIPBOARD_TEXT_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::Out.Write((Get-Clipboard -Raw))",
].join("; ");

type Environment = Record<string, string | undefined>;
type NativeClipboard = { getText(): Promise<string> };
type CommandRunner = (command: string, args: string[]) => Promise<string>;

export type ClipboardTextOptions = {
  platform?: NodeJS.Platform;
  env?: Environment;
  nativeClipboard?: NativeClipboard | null;
  runner?: CommandRunner;
};

function isRemoteSession(env: Environment): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

async function loadNativeClipboard(): Promise<NativeClipboard | null> {
  try {
    return await import("@mariozechner/clipboard");
  } catch {
    return null;
  }
}

function runClipboardCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Clipboard read timed out"));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CLIPBOARD_TEXT_BYTES) {
        child.kill();
        finish(new Error("Clipboard text is too large"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(new Error("Clipboard command failed")));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("Clipboard command failed")));
  });
}

function checkedText(text: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_TEXT_BYTES) {
    throw new Error("Clipboard text is too large");
  }
  return text;
}

/** Read local graphical clipboard text without a shell or visible clipboard output. */
export async function readClipboardText(options: ClipboardTextOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (isRemoteSession(env)) throw new Error("Clipboard text paste is unavailable in a remote session");

  const clipboard = options.nativeClipboard === undefined
    ? await loadNativeClipboard()
    : options.nativeClipboard;
  if (clipboard) {
    try {
      return checkedText(await clipboard.getText());
    } catch {
      // Use a direct platform command when native clipboard access fails.
    }
  }

  const runner = options.runner ?? runClipboardCommand;
  if (platform === "win32") {
    return checkedText(await runner("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      WINDOWS_CLIPBOARD_TEXT_SCRIPT,
    ]));
  }
  if (platform === "darwin") return checkedText(await runner("pbpaste", []));
  if (platform === "linux" && env.WAYLAND_DISPLAY) {
    return checkedText(await runner("wl-paste", ["--no-newline", "--type", "text"]));
  }
  if (platform === "linux" && env.DISPLAY) {
    return checkedText(await runner("xclip", ["-selection", "clipboard", "-o"]));
  }
  throw new Error("No supported graphical clipboard is available");
}

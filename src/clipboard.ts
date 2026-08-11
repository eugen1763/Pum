import { CliRenderEvents, type CliRenderer, type Selection } from "@opentui/core";
import { spawn } from "node:child_process";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

type Environment = Record<string, string | undefined>;
type NativeClipboard = { setText(text: string): Promise<void> };
type CommandRunner = (command: string, args: string[], input: string) => Promise<void>;
type Osc52Writer = (text: string) => boolean;

export type ClipboardRoute = "native" | "command" | "osc52";

export type ClipboardCopyOptions = {
  platform?: NodeJS.Platform;
  env?: Environment;
  nativeClipboard?: NativeClipboard | null;
  runner?: CommandRunner;
  osc52?: Osc52Writer;
};

export type SelectionClipboardBinding = {
  dispose(): void;
  flush(): Promise<void>;
};

function isRemoteSession(env: Environment): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function osc52PayloadFits(text: string): boolean {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3) * 4 <= MAX_OSC52_ENCODED_LENGTH;
}

async function loadNativeClipboard(): Promise<NativeClipboard | null> {
  try {
    return await import("@mariozechner/clipboard");
  } catch {
    return null;
  }
}

function runClipboardCommand(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, 5000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function tryCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  text: string,
): Promise<boolean> {
  try {
    await runner(command, args, text);
    return true;
  } catch {
    return false;
  }
}

/** Copy completed OpenTUI selections without assuming local graphical access. */
export async function copySelectionText(
  text: string,
  options: ClipboardCopyOptions = {},
): Promise<ClipboardRoute> {
  return copyTextCore(text, options, "Cannot copy an empty selection");
}

/** Copy arbitrary text (a news answer, for example) through the same routes. */
export async function copyTextToClipboard(
  text: string,
  options: ClipboardCopyOptions = {},
): Promise<ClipboardRoute> {
  return copyTextCore(text, options, "Cannot copy empty text");
}

async function copyTextCore(
  text: string,
  options: ClipboardCopyOptions,
  emptyMessage: string,
): Promise<ClipboardRoute> {
  if (!text) throw new Error(emptyMessage);

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const osc52 = options.osc52 ?? (() => false);

  if (isRemoteSession(env)) {
    if (osc52PayloadFits(text) && osc52(text)) return "osc52";
    throw new Error("The remote terminal did not accept the OSC 52 clipboard copy");
  }

  if (platform === "win32" || platform === "darwin") {
    const clipboard = options.nativeClipboard === undefined
      ? await loadNativeClipboard()
      : options.nativeClipboard;
    try {
      if (clipboard) {
        await clipboard.setText(text);
        return "native";
      }
    } catch {
      // Use the platform command before the terminal fallback.
    }
  }

  const runner = options.runner ?? runClipboardCommand;
  if (platform === "win32" && await tryCommand(runner, "clip.exe", [], text)) return "command";
  if (platform === "darwin" && await tryCommand(runner, "pbcopy", [], text)) return "command";
  if (platform === "linux" && env.WAYLAND_DISPLAY
    && await tryCommand(runner, "wl-copy", [], text)) return "command";
  if (platform === "linux" && env.DISPLAY) {
    if (await tryCommand(runner, "xclip", ["-selection", "clipboard"], text)) return "command";
    if (await tryCommand(runner, "xsel", ["--clipboard", "--input"], text)) return "command";
  }

  if (osc52PayloadFits(text) && osc52(text)) return "osc52";
  throw new Error("No supported clipboard route accepted the selected text");
}

export function installSelectionClipboard(
  renderer: CliRenderer,
  options: Omit<ClipboardCopyOptions, "osc52"> & {
    onError?: (error: unknown) => void;
  } = {},
): SelectionClipboardBinding {
  let pending = Promise.resolve();
  const onSelection = (selection: Selection) => {
    const text = selection.getSelectedText();
    if (!text) return;
    pending = pending
      .then(() => copySelectionText(text, {
        ...options,
        osc52: (value) => renderer.copyToClipboardOSC52(value),
      }))
      .then(() => undefined)
      .catch((error) => options.onError?.(error));
  };

  renderer.on(CliRenderEvents.SELECTION, onSelection);
  return {
    dispose() {
      renderer.off(CliRenderEvents.SELECTION, onSelection);
    },
    flush() {
      return pending;
    },
  };
}

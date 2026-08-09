import { spawn } from "node:child_process";

export type BrowserLaunchCommand = {
  executable: string;
  args: string[];
};

export type BrowserProcessSpawner = (
  executable: string,
  args: readonly string[],
) => Promise<void>;

export function credentialFreeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function browserLaunchCommand(
  platform: NodeJS.Platform,
  url: string,
): BrowserLaunchCommand | null {
  if (platform === "win32") {
    return {
      executable: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "darwin") return { executable: "open", args: [url] };
  if (platform === "linux") return { executable: "xdg-open", args: [url] };
  return null;
}

const spawnBrowserProcess: BrowserProcessSpawner = (executable, args) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("spawn", resolve);
    child.once("error", reject);
    child.unref();
  });

export async function launchBrowserUrl(
  value: string,
  options: {
    platform?: NodeJS.Platform;
    spawn?: BrowserProcessSpawner;
  } = {},
): Promise<boolean> {
  const url = credentialFreeHttpUrl(value);
  if (!url) return false;
  const command = browserLaunchCommand(options.platform ?? process.platform, url);
  if (!command) return false;
  try {
    await (options.spawn ?? spawnBrowserProcess)(command.executable, command.args);
    return true;
  } catch {
    return false;
  }
}

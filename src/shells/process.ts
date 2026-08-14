import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeTriggerEnvironment } from "../triggers/process";
import type {
  ShellClock,
  ShellFileOperations,
  ShellOutputWriter,
  ShellProcessAdapter,
  ShellProcessHandle,
  ShellProcessSpawnRequest,
} from "./types";

/** Build the same small, injection-resistant environment used by external triggers. */
export function sanitizeShellEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return sanitizeTriggerEnvironment(source, additions);
}

export class NodeShellProcessAdapter implements ShellProcessAdapter {
  spawn(request: ShellProcessSpawnRequest): ShellProcessHandle {
    if (!request.executable || request.executable.includes("\0")) throw new Error("Shell executable is invalid");
    for (const arg of request.args) if (arg.includes("\0")) throw new Error("Shell argument contains NUL");

    const isWindows = process.platform === "win32";
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => request.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => request.onStderr(chunk));
    const completed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    return {
      completed,
      kill(signal = "SIGTERM") {
        const pid = child.pid;
        if (pid === undefined) return;
        if (isWindows) {
          try {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
              .on("error", () => { try { child.kill(); } catch { /* The process already exited. */ } });
          } catch {
            try { child.kill(); } catch { /* The process already exited. */ }
          }
          return;
        }
        try {
          process.kill(-pid, signal as NodeJS.Signals);
        } catch {
          try { child.kill(signal as NodeJS.Signals); } catch { /* The process already exited. */ }
        }
      },
    };
  }
}

export class NodeShellFileOperations implements ShellFileOperations {
  constructor(private readonly root = tmpdir()) {}

  async readOutput(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  async createPrivateOutput(shellId: string): Promise<ShellOutputWriter> {
    await mkdir(this.root, { recursive: true });
    const directory = await mkdtemp(join(this.root, "pum-shell-"));
    await chmod(directory, 0o700).catch(() => {});
    const path = join(directory, `${shellId.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
    const file = await open(path, "wx", 0o600);
    let closed = false;
    return {
      path,
      async write(chunk) {
        if (closed) throw new Error("Shell output is closed");
        await file.write(chunk);
      },
      async close() {
        if (closed) return;
        closed = true;
        await file.close();
      },
      async remove() {
        if (!closed) {
          closed = true;
          await file.close().catch(() => {});
        }
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
}

export const systemShellClock: ShellClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

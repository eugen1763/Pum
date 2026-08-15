import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProcessSpawnRequest,
  TriggerClock,
  TriggerFileOperations,
  TriggerOutputWriter,
  TriggerProcessAdapter,
  TriggerProcessHandle,
} from "./types";

const SAFE_ENVIRONMENT_KEY_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE",
] as const;
const SAFE_ENVIRONMENT_KEYS = new Map(
  SAFE_ENVIRONMENT_KEY_NAMES.map((key) => [key.toUpperCase(), key]),
);

const UNSAFE_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS", "BUN_OPTIONS", "DENO_FLAGS", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONPATH", "RUBYOPT", "PERL5OPT",
  "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "SSH_ASKPASS", "GIT_ASKPASS",
].map((key) => key.toUpperCase()));

const VALID_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Build a small environment and reject variables that can inject runtime behavior. */
export function sanitizeTriggerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [sourceKey, value] of Object.entries(source)) {
    const canonicalKey = SAFE_ENVIRONMENT_KEYS.get(sourceKey.toUpperCase());
    if (canonicalKey && typeof value === "string" && !value.includes("\0")) result[canonicalKey] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    const upperKey = key.toUpperCase();
    if (!VALID_ENVIRONMENT_KEY.test(key) || UNSAFE_ENVIRONMENT_KEYS.has(upperKey)) {
      throw new Error(`Unsafe trigger environment variable: ${key}`);
    }
    if (value.includes("\0")) throw new Error(`Trigger environment variable contains NUL: ${key}`);
    result[SAFE_ENVIRONMENT_KEYS.get(upperKey) ?? key] = value;
  }
  return result;
}

export class NodeTriggerProcessAdapter implements TriggerProcessAdapter {
  spawn(request: ProcessSpawnRequest): TriggerProcessHandle {
    if (!request.executable || request.executable.includes("\0")) {
      throw new Error("Trigger executable is invalid");
    }
    for (const arg of request.args) {
      if (arg.includes("\0")) throw new Error("Trigger argument contains NUL");
    }
    const isWindows = process.platform === "win32";
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      windowsHide: true,
      // A detached POSIX child leads its own process group, so a signal to the
      // negative pid reaches the whole tree. Windows has no process groups here
      // and uses taskkill /T instead.
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
          // No real signals or process groups on Windows: taskkill terminates
          // the whole tree; fall back to the direct child if it is unavailable.
          try {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
              .on("error", () => { try { child.kill(); } catch { /* already gone */ } });
          } catch {
            try { child.kill(); } catch { /* already gone */ }
          }
          return;
        }
        // Signal the whole process group; fall back to the direct child if the
        // group is already gone.
        try {
          process.kill(-pid, signal as NodeJS.Signals);
        } catch {
          try { child.kill(signal as NodeJS.Signals); } catch { /* already gone */ }
        }
      },
    };
  }
}

export class NodeTriggerFileOperations implements TriggerFileOperations {
  constructor(private readonly root = tmpdir()) {}

  async createPrivateOutput(triggerId: string): Promise<TriggerOutputWriter> {
    await mkdir(this.root, { recursive: true });
    const directory = await mkdtemp(join(this.root, "pum-trigger-"));
    await chmod(directory, 0o700).catch(() => {
      // Windows and some temporary filesystems do not expose POSIX modes.
    });
    const path = join(directory, `${triggerId.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
    const file = await open(path, "wx", 0o600);
    let closed = false;
    return {
      path,
      async write(chunk) {
        if (closed) throw new Error("Trigger output is closed");
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

export const systemTriggerClock: TriggerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

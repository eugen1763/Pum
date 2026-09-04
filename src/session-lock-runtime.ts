import { createAgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { sessionDir } from "./config";
import { listProjectSessions } from "./session-resume-alias";
import { SessionLockOwner, releaseSessionLockOnDispose } from "./session-lock";

/** Reserve before SessionManager.open: opening old JSONL can migrate it. */
export async function lockedProjectSession(cwd: string, resume: boolean, owner: SessionLockOwner) {
  const recent = resume ? (await listProjectSessions(cwd))[0] : undefined;
  if (!recent) return { sessionManager: SessionManager.create(cwd, sessionDir(cwd)), release: () => {} };
  const release = owner.acquire(recent.path);
  try {
    return { sessionManager: SessionManager.open(recent.path, dirname(recent.path), cwd), release };
  } catch (error) { release(); throw error; }
}

export async function createLockedAgentSessionRuntime(
  factory: Parameters<typeof createAgentSessionRuntime>[0],
  options: Parameters<typeof createAgentSessionRuntime>[1],
  owner: SessionLockOwner,
) {
  const runtime = await createAgentSessionRuntime(async (context) => {
    const release = owner.acquire(context.sessionManager.getSessionFile());
    try {
      const result = await factory(context);
      releaseSessionLockOnDispose(result.session, release);
      return result;
    } catch (error) { release(); throw error; }
  }, options);
  let replacement: Promise<unknown> | undefined;
  let closing = false;
  const replace = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) throw new Error("The session is closing.");
    if (replacement) throw new Error("A session switch is already in progress.");
    const pending = Promise.resolve().then(operation);
    replacement = pending;
    try { return await pending; }
    finally { replacement = undefined; }
  };
  const switchSession = runtime.switchSession.bind(runtime);
  runtime.switchSession = (path, options) => replace(async () => {
    // Reserve before pi opens the target or tears down the current session.
    // A reservation also bridges same-file relocation and its runtime rebuild.
    const release = owner.acquire(path);
    try { return await switchSession(path, options); }
    finally { release(); }
  });
  const newSession = runtime.newSession.bind(runtime);
  runtime.newSession = (options) => replace(() => newSession(options));
  const dispose = runtime.dispose.bind(runtime);
  let disposing: Promise<void> | undefined;
  runtime.dispose = () => {
    closing = true;
    return disposing ??= (async () => {
      await replacement?.catch(() => {});
      try {
        await runtime.session.abort();
        await dispose();
      } finally { runtime.session.dispose(); }
    })();
  };
  return runtime;
}

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { writeHeadlessRequestDiagnostics } from "./request-diagnostics-access";
import { SessionLockOwner } from "./session-lock";
import { createLockedAgentSessionRuntime, lockedProjectSession } from "./session-lock-runtime";
import { installModelCatalogFallbacks } from "./model-catalog";
import { AGENT_DIR, AUTH_PATH, MODELS_PATH } from "./config";
import { createMemoryExtension, MEMORY_EDIT_TOOL_NAME, MEMORY_READ_TOOL_NAME } from "./memory";
import { ContextWindowController, CONTEXT_TOOL_NAMES } from "./context-window";
import { checkPathsForProject, loadSettings } from "./settings";
import { identityExtension } from "./identity";
import { setWritingStyle, writingStyleExtension } from "./writing-style";
import { checkModePromptExtension, setSandboxModeSource } from "./check-mode-prompt";
import { explanationStrengthExtension, setExplanationStrength } from "./explanation-strength";
import { createCheckModeExtension, setCheckModeConfig } from "./check-mode";
import { setBashOutputSettingsIfPresent } from "./bash-output";
import {
  bindSearchSession,
  installWebSearch,
  observeSearchCalls,
  persistSearchCall,
  webSearch,
  withSearchRoute,
  type SearchCall,
} from "./web-search";
import { SandboxController } from "./sandbox";
import { toolArgText } from "./tool-line";
import { shutdownSignals, signalExitCode } from "./platform";
import { SessionStatsManager } from "./session-stats";
import { prepareHeadlessStatsOutput, type HeadlessStatsOutput } from "./headless-stats";

/**
 * Tools exposed to a headless run. The interactive-only tools stay out:
 * questionnaire has no popup, enable_tools would reveal groups whose managers
 * are not constructed here, and subagent, trigger, and message-cache tools
 * need the running TUI for routing and notifications.
 */
export const HEADLESS_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  MEMORY_READ_TOOL_NAME,
  MEMORY_EDIT_TOOL_NAME,
  ...CONTEXT_TOOL_NAMES,
];

/**
 * Handle one hosted web-search call from a headless run.
 *
 * A hosted search is not a pi tool call, so it reaches neither the event
 * stream nor the session file on its own. Report the start on stderr next to
 * the tool lines, and persist every phase as a custom session entry so a later
 * `pum -r` replays the search without adding it to LLM context.
 */
export function headlessSearchObserver(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  write: (line: string) => void,
): (call: SearchCall) => void {
  return (call) => {
    if (call.phase === "start") write(`· web_search ${call.query}\n`);
    else if (!call.ok) write(`· web_search failed\n`);
    persistSearchCall(sessionManager, call);
  };
}

export interface HeadlessOptions {
  prompt: string;
  resume: boolean;
  statsFile?: string;
  overrideStatsFile: boolean;
  pumVersion: string;
}

/**
 * Non-interactive one-shot mode for `pum -p "<prompt>"`.
 *
 * Boots the same session stack as the TUI minus every UI surface, sends one
 * prompt, streams assistant text to stdout and tool progress to stderr, and
 * exits after the agent settles. The session persists to the normal session
 * directory, so `pum -r` can resume it interactively.
 *
 * Check mode still applies. Ask-mode approvals fail closed: the approval
 * coordinator denies every request when no popup is attached.
 */
export async function runPrompt(options: HeadlessOptions): Promise<number> {
  let statsOutput: HeadlessStatsOutput | undefined;
  if (options.statsFile) {
    try {
      statsOutput = prepareHeadlessStatsOutput(options.statsFile, options.overrideStatsFile);
    } catch (error) {
      // prepareHeadlessStatsOutput already names the reservation case, including
      // the zero-byte file an interrupted run leaves behind.
      const message = error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST"
        ? error.message
        : `cannot prepare stats file ${options.statsFile}: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`pum: ${message}\n`);
      return 2;
    }
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const statsManager = new SessionStatsManager();
  let statsWritten = false;
  const writeStats = (exitCode: number): number => {
    if (!statsOutput || statsWritten) return exitCode;
    statsWritten = true;
    const finishedAtMs = Date.now();
    try {
      statsOutput.write({
        schemaVersion: 1,
        pumVersion: options.pumVersion,
        run: {
          prompt: options.prompt,
          cwd: process.cwd(),
          resume: options.resume,
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
          exitCode,
        },
        stats: statsManager.snapshot(),
      });
      return exitCode;
    } catch (error) {
      process.stderr.write(`pum: cannot write stats file ${statsOutput.path}: ${error instanceof Error ? error.message : String(error)}\n`);
      return exitCode === 0 ? 1 : exitCode;
    }
  };

  let exitCode = 1;
  try {
    exitCode = await runPromptSession(options, statsManager, writeStats);
  } catch (error) {
    process.stderr.write(`pum: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return writeStats(exitCode);
}

async function runPromptSession(
  options: HeadlessOptions,
  statsManager: SessionStatsManager,
  writeStats: (exitCode: number) => number,
): Promise<number> {
  mkdirSync(AGENT_DIR, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
  });
  installModelCatalogFallbacks(modelRuntime);
  if ((await modelRuntime.getAvailable()).length === 0) {
    process.stderr.write("pum: no provider is available. Run 'pum login' first.\n");
    return 1;
  }

  const settings = loadSettings();
  const sandboxController = new SandboxController({
    mode: settings.sandboxMode ?? "auto",
    agentDir: AGENT_DIR,
  });
  setSandboxModeSource(() => sandboxController.mode);
  const sandboxWarning = await sandboxController.startupWarning(settings.checkMode);
  if (sandboxWarning) process.stderr.write(`pum: ${sandboxWarning}\n`);
  setWritingStyle(settings.writingStyle);
  setExplanationStrength(settings.explanationStrength);
  setBashOutputSettingsIfPresent(settings.bashOutput);
  setCheckModeConfig({
    profile: settings.checkMode,
    model: settings.checkModel,
    additionalPaths: checkPathsForProject(settings, process.cwd()),
  });
  const checkModeExtension = createCheckModeExtension(modelRuntime, {
    identity: { kind: "main" },
    observeRequest: (observation) => statsManager.observeCheck({
      agentId: null,
      model: observation.model,
      usage: observation.usage,
    }),
  });

  webSearch.enabled = settings.webSearch;
  installWebSearch(modelRuntime);

  const cwd = process.cwd();
  const sessionLockOwner = new SessionLockOwner();
  const startup = await lockedProjectSession(cwd, options.resume === true, sessionLockOwner);
  const sessionRuntime = await createLockedAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }) => {
      const contextWindow = new ContextWindowController();
      const services = await createAgentSessionServices({
        cwd,
        agentDir: AGENT_DIR,
        modelRuntime,
        resourceLoaderOptions: {
          extensionFactories: [
            identityExtension,
            writingStyleExtension,
            explanationStrengthExtension,
            checkModePromptExtension,
            checkModeExtension,
            sandboxController.extension(),
            contextWindow.extension(),
            createMemoryExtension({ agentDir: AGENT_DIR, audience: "main" }),
          ],
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: HEADLESS_TOOL_NAMES,
      });
      try {
        bindSearchSession(result.session, "main");
        contextWindow.bind(result.session);
      } catch (error) {
        // The runtime factory cannot dispose a session it has not received yet.
        try { result.session.dispose(); } catch { /* Preserve the binding error. */ }
        throw error;
      }
      return { ...result, services, diagnostics: services.diagnostics };
    },
    {
      cwd,
      agentDir: AGENT_DIR,
      sessionManager: startup.sessionManager,
    },
    sessionLockOwner,
  ).finally(startup.release);
  try {
  if (sessionRuntime.modelFallbackMessage) {
    process.stderr.write(`pum: ${sessionRuntime.modelFallbackMessage}\n`);
  }

  const session = sessionRuntime.session;
  process.stderr.write("pum: File checkpoints are unavailable in headless mode. Checkpoint memory does not survive exit; previously exported recovery files remain. Bash is not checkpointed.\n");
  statsManager.bindMainSession(session);
  let exitCode = 0;
  let wroteText = false;
  // Stream assistant text to stdout and one safe tool label to stderr. The tool
  // label uses toolArg, which selects one non-sensitive argument per tool, so
  // file content and inline command secrets never reach the log.
  session.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
          wroteText = true;
        }
        break;
      case "message_end":
        if (event.message.role === "assistant" && wroteText) {
          process.stdout.write("\n");
          wroteText = false;
        }
        break;
      case "tool_execution_start":
        process.stderr.write(`· ${event.toolName} ${toolArgText(event.toolName, event.args, cwd)}\n`);
        break;
      case "tool_execution_end":
        if (event.isError) process.stderr.write(`· ${event.toolName} failed\n`);
        break;
    }
  });

  // Dispose exactly once. Disposal aborts the agent and terminates tracked bash
  // process trees, so it must complete on the normal path and on a signal.
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    // Disposal clears the process-local diagnostics. Print their safe report
    // once before teardown, including on signal/failed-turn paths.
    writeHeadlessRequestDiagnostics(session.sessionId, (text) => process.stderr.write(text));
    try {
      await sessionRuntime.dispose();
    } catch (error) {
      process.stderr.write(`pum: shutdown error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  // Hosted searches are bolted on outside pi, so route them to this session and
  // record them the way the TUI does. Without this a headless run's searches
  // are invisible to a later `pum -r`.
  const unsubscribeSearch = observeSearchCalls(
    session.sessionId,
    headlessSearchObserver(session.sessionManager, (line) => process.stderr.write(line)),
  );

  const onSignal = (signal: NodeJS.Signals) => {
    void dispose().finally(() => process.exit(writeStats(signalExitCode(signal))));
  };
  const signals = shutdownSignals();
  for (const signal of signals) process.on(signal, onSignal);

  try {
    // prompt() resolves on settlement, including when an extension or slash
    // command handles the input and returns early, so no separate wait is
    // needed and the process cannot hang on a missing agent_settled event.
    await withSearchRoute(session.sessionId, () => session.prompt(options.prompt));
    // A turn that ended in a provider or abort error prints no text; report it
    // and exit non-zero so a script does not read failure as success.
    const messages = session.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      process.stderr.write(`pum: ${(last as any).errorMessage ?? `request ${last.stopReason}`}\n`);
      exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pum: ${message}\n`);
    exitCode = 1;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    unsubscribeSearch();
    await dispose();
  }
  return exitCode;
  } finally {
    await sessionRuntime.dispose();
  }
}

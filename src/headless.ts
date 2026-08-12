import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { AGENT_DIR, AUTH_PATH, MODELS_PATH, sessionDir } from "./config";
import { checkPathsForProject, loadSettings } from "./settings";
import { identityExtension } from "./identity";
import { setWritingStyle, writingStyleExtension } from "./writing-style";
import { checkModePromptExtension, setSandboxModeSource } from "./check-mode-prompt";
import { explanationStrengthExtension, setExplanationStrength } from "./explanation-strength";
import { createCheckModeExtension, setCheckModeConfig } from "./check-mode";
import { applyPatchExtension } from "./apply-patch";
import { installWebSearch, webSearch } from "./web-search";
import { SandboxController } from "./sandbox";
import { toolArg } from "./tool-line";
import { shutdownSignals } from "./platform";
import { SessionStatsManager } from "./session-stats";

/**
 * Tools exposed to a headless run. The interactive-only tools stay out:
 * questionnaire has no popup, enable_tools would reveal groups whose managers
 * are not constructed here, and subagent, trigger, and message-cache tools
 * need the running TUI for routing and notifications.
 */
const HEADLESS_TOOL_NAMES = ["read", "write", "edit", "apply_patch", "bash"];

export interface HeadlessOptions {
  prompt: string;
  resume: boolean;
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
  mkdirSync(AGENT_DIR, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
  });
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
  setCheckModeConfig({
    profile: settings.checkMode,
    model: settings.checkModel,
    additionalPaths: checkPathsForProject(settings, process.cwd()),
  });
  const statsManager = new SessionStatsManager();
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
  const sessionRuntime = await createAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }) => {
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
            applyPatchExtension,
          ],
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: HEADLESS_TOOL_NAMES,
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    {
      cwd,
      agentDir: AGENT_DIR,
      sessionManager: options.resume
        ? SessionManager.continueRecent(cwd, sessionDir(cwd))
        : SessionManager.create(cwd, sessionDir(cwd)),
    },
  );
  if (sessionRuntime.modelFallbackMessage) {
    process.stderr.write(`pum: ${sessionRuntime.modelFallbackMessage}\n`);
  }

  const session = sessionRuntime.session;
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
        process.stderr.write(`· ${event.toolName} ${toolArg(event.toolName, event.args, cwd)}\n`);
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
    try {
      await sessionRuntime.dispose();
    } catch (error) {
      process.stderr.write(`pum: shutdown error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const onSignal = () => { void dispose().finally(() => process.exit(130)); };
  const signals = shutdownSignals();
  for (const signal of signals) process.on(signal, onSignal);

  try {
    // prompt() resolves on settlement, including when an extension or slash
    // command handles the input and returns early, so no separate wait is
    // needed and the process cannot hang on a missing agent_settled event.
    await session.prompt(options.prompt);
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
    await dispose();
  }
  return exitCode;
}

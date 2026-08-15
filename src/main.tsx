import { createCliRenderer, destroyTreeSitterClient } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { App } from "./app";
import { AGENT_DIR, AUTH_PATH, MODELS_PATH, sessionDir } from "./config";
import { checkPathsForProject, loadSettings } from "./settings";
import { setBashOutputSettingsIfPresent } from "./bash-output";
import { installWebSearch, webSearch } from "./web-search";
import { identityExtension } from "./identity";
import { setWritingStyle, writingStyleExtension } from "./writing-style";
import { checkModePromptExtension, setSandboxModeSource } from "./check-mode-prompt";
import {
  explanationStrengthExtension,
  setExplanationStrength,
} from "./explanation-strength";
import {
  createCheckModeExtension,
  createExternalTriggerSafetyChecker,
  createManagedShellSafetyChecker,
  setCheckModeConfig,
} from "./check-mode";
import { SubagentManager } from "./subagents/manager";
import { cleanupPendingImages } from "./image-paste";
import { cleanupPendingPastedTexts } from "./pasted-text";
import { cleanupBashOutputCaptures } from "./bash-output";
import { shutdownSignals, signalExitCode } from "./platform";
import { createShutdown } from "./shutdown";
import { settleSyntaxHighlighting } from "./syntax";
import { applyPatchExtension } from "./apply-patch";
import { QuestionnaireManager } from "./questionnaire";
import { ToolGroupsController, mainAllowedToolNames } from "./tool-groups";
import { SpawnPreviewManager } from "./subagents/spawn-preview";
import { SessionHistoryIndex } from "./session-history-metadata";
import { MessageCacheController } from "./message-cache";
import { TriggerManager } from "./triggers/manager";
import {
  NodeTriggerFileOperations,
  NodeTriggerProcessAdapter,
  systemTriggerClock,
} from "./triggers/process";
import type { StartupOptions } from "./cli";
import { TodoToolsController } from "./todo-tools";
import { installSelectionClipboard } from "./clipboard";
import { TerminalTitleController } from "./terminal-title";
import { SandboxController } from "./sandbox";
import {
  createFilesystemSandboxExtension,
  filesystemSandboxExtension,
} from "./filesystem-sandbox";
import {
  outerSandboxAdditionalRoots,
  outerSandboxContext,
} from "./outer-sandbox-launch";
import { SessionStatsManager } from "./session-stats";
import { ShellManager } from "./shells/manager";
import {
  NodeShellFileOperations,
  NodeShellProcessAdapter,
  systemShellClock,
} from "./shells/process";
import {
  ManagedShellLifecycleController,
  lifecycleEventFromSnapshot,
} from "./shells/lifecycle";

/**
 * Process-local launch context. These are facts about how this process was
 * started, never user settings, so nothing here reaches pum.json.
 */
export type LaunchContext = {
  /** Source repository of a `pum worktree` launch, authorized as a writable root. */
  worktreeSourceRoot?: string;
};

export async function start(
  options: StartupOptions,
  context: LaunchContext = {},
): Promise<void> {
  mkdirSync(AGENT_DIR, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
  });
  const loginRequired = options.login || (await modelRuntime.getAvailable()).length === 0;

  const settings = loadSettings();
  const outerSandbox = outerSandboxContext();
  // The source repository joins the outer-sandbox roots rather than the saved
  // check paths: it is true of this process only, and `/check-path` must not
  // learn about it.
  const forcedCheckPaths = [
    ...(outerSandbox ? outerSandboxAdditionalRoots(outerSandbox, process.cwd()) : []),
    ...(context.worktreeSourceRoot ? [context.worktreeSourceRoot] : []),
  ];
  const sandboxController = new SandboxController({
    mode: outerSandbox ? "off" : settings.sandboxMode ?? "auto",
    agentDir: AGENT_DIR,
  });
  setSandboxModeSource(() => sandboxController.mode);
  const sandboxWarning = await sandboxController.startupWarning(settings.checkMode);
  const sandboxExtension = sandboxController.extension();
  setWritingStyle(settings.writingStyle);
  setExplanationStrength(settings.explanationStrength);
  setBashOutputSettingsIfPresent(settings.bashOutput);
  const questionnaireManager = new QuestionnaireManager();
  const spawnPreviewManager = new SpawnPreviewManager();
  const mainToolGroups = new ToolGroupsController("main");
  const mainTodoTools = new TodoToolsController("main");
  const sessionHistoryIndex = new SessionHistoryIndex();
  const messageCacheController = new MessageCacheController(process.cwd());
  const statsManager = new SessionStatsManager();
  setCheckModeConfig({
    profile: settings.checkMode,
    model: settings.checkModel,
    additionalPaths: [...new Set([
      ...checkPathsForProject(settings, process.cwd()),
      ...forcedCheckPaths,
    ])],
  });
  const mainCheckModeExtension = createCheckModeExtension(modelRuntime, {
    identity: { kind: "main" },
    observeRequest: (observation) => statsManager.observeCheck({
      agentId: observation.requester?.kind === "subagent" ? observation.requester.agentId : null,
      model: observation.model,
      usage: observation.usage,
    }),
  });
  const externalTriggerSafety = createExternalTriggerSafetyChecker(modelRuntime, (observation) => {
    statsManager.observeCheck({
      agentId: observation.requester?.kind === "subagent" ? observation.requester.agentId : null,
      model: observation.model,
      usage: observation.usage,
    });
  });
  const managedShellSafety = createManagedShellSafetyChecker(modelRuntime, (observation) => {
    statsManager.observeCheck({
      agentId: observation.requester?.kind === "subagent" ? observation.requester.agentId : null,
      model: observation.model,
      usage: observation.usage,
    });
  });
  let subagentManager!: SubagentManager;
  const shellLifecycle = new ManagedShellLifecycleController(
    {
      append: (_owner, _customType, data) =>
        subagentManager.persistManagedShellEvent(data as any),
    },
    {
      deliver: (message) => subagentManager.deliverManagedShellCompletion(message.details),
    },
  );
  const startedShells = new Set<string>();
  const shellManager = new ShellManager({
    process: new NodeShellProcessAdapter(),
    files: new NodeShellFileOperations(),
    clock: systemShellClock,
    // A managed shell starts a real process from model input, so it carries the
    // same deterministic policy and verifier as an external trigger. The checker
    // rejects when either blocks, and ShellManager.create propagates that
    // rejection instead of starting the process.
    safety: { check: (request) => managedShellSafety(request.proposal, request.requester) },
    async onCompleted(snapshot) {
      const output = await shellManager.getOutput(snapshot.id, { lineLimit: 200 }).catch(() => undefined);
      const event = lifecycleEventFromSnapshot(snapshot, output?.tail);
      await shellLifecycle.recordExit(event, snapshot.state === "terminated");
    },
  });
  shellManager.subscribe((event) => {
    if (event.type !== "changed"
      || !["starting", "running"].includes(event.snapshot.state)
      || startedShells.has(event.snapshot.id)) return;
    startedShells.add(event.snapshot.id);
    void shellLifecycle.record(lifecycleEventFromSnapshot(event.snapshot));
  });
  const triggerManager = new TriggerManager({
    process: new NodeTriggerProcessAdapter(),
    clock: systemTriggerClock,
    files: new NodeTriggerFileOperations(),
    safety: {
      async check(request) {
        try {
          await externalTriggerSafety(request.proposal, request.requester);
          return { safe: true };
        } catch (error) {
          return { safe: false, reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    targets: {
      async resolve(target) {
        const resolved = await subagentManager.resolveRetainedTriggerTarget(target.agentId ?? "main");
        if (!resolved.available
          || resolved.sessionId !== target.sessionId
          || resolved.agentId !== target.agentId) return undefined;
        return {
          target: {
            sessionId: resolved.sessionId,
            agentId: resolved.agentId,
            label: resolved.label,
          },
          value: resolved,
        };
      },
    },
    delivery: {
      async deliver(request) {
        const deliveryId = randomUUID();
        await subagentManager.deliverTriggerEvent({
          ...request.event,
          id: deliveryId,
          text: request.message,
        });
        return { deliveryId };
      },
    },
  });
  subagentManager = new SubagentManager({
    modelRuntime,
    agentDir: AGENT_DIR,
    maxActiveSubagents: settings.maxActiveSubagents,
    questionnaireManager,
    spawnPreviewManager,
    messageCacheController,
    statsManager,
    triggerManager,
    shellManager,
    childExtensionFactories: [
      identityExtension,
      writingStyleExtension,
      explanationStrengthExtension,
      checkModePromptExtension,
    ],
    childExtensionFactoriesForAgent: [
      (agentId) => createCheckModeExtension(modelRuntime, {
        identity: { kind: "subagent", agentId },
        observeRequest: (observation) => statsManager.observeCheck({
          agentId,
          model: observation.model,
          usage: observation.usage,
        }),
      }),
      (_agentId, isReadonly) => sandboxController.extension({ readonly: isReadonly }),
      (_agentId, isReadonly) => createFilesystemSandboxExtension({ readonly: isReadonly }),
    ],
    sandboxModeSource: () => sandboxController.mode,
  });
  const subagentExtension = subagentManager.mainExtension();
  // Hosted web search rides on the provider, so it must be wrapped before the
  // session picks a model.
  webSearch.enabled = settings.webSearch;
  const searchProviders = installWebSearch(modelRuntime);

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
            filesystemSandboxExtension,
            mainCheckModeExtension,
            sandboxExtension,
            applyPatchExtension,
            questionnaireManager.extension({ id: "main", name: "main" }),
            mainToolGroups.extension(),
            mainTodoTools.extension(),
            subagentExtension,
          ],
        },
      });
      // Each session tracks its own enabled tool groups, persisted next to
      // the session file. Restore before enable_tools registers and runs, then
      // narrow the outgoing tool list to core plus enabled groups.
      mainToolGroups.load(sessionManager.getSessionFile());
      // Bind the list to this session before any tool can run, so a resumed
      // session reads its own plan and /clear starts an empty one.
      mainTodoTools.load(sessionManager.getSessionFile());
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: mainAllowedToolNames(),
      });
      result.session.setActiveToolsByName(mainToolGroups.activeTools());
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

  statsManager.bindMainSession(sessionRuntime.session);
  if (sessionRuntime.modelFallbackMessage) console.error(sessionRuntime.modelFallbackMessage);

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const terminalTitle = new TerminalTitleController((title) => renderer.setTerminalTitle(title));
  const selectionClipboard = installSelectionClipboard(renderer);
  const root = createRoot(renderer);
  // Reported on the restored terminal by the exit action below, so the message
  // is not swallowed by the alternate screen.
  let fatalError: unknown;
  let shuttingDown = false;
  const shutdown = createShutdown({
    unmount: async () => {
      await settleSyntaxHighlighting(renderer.root);
      root.unmount();
    },
    cleanup: () => {
      terminalTitle.clear();
      selectionClipboard.dispose();
      cleanupPendingImages();
      cleanupPendingPastedTexts();
      cleanupBashOutputCaptures();
    },
    shutdownShells: () => shellManager.shutdown(),
    shutdownTriggers: () => triggerManager.shutdown(),
    dispose: async () => {
      statsManager.dispose();
      await sessionRuntime.dispose();
    },
    destroy: async () => {
      renderer.destroy();
      await destroyTreeSitterClient();
    },
    exit: (code) => {
      if (fatalError !== undefined) {
        const detail = fatalError instanceof Error
          ? fatalError.stack ?? fatalError.message
          : String(fatalError);
        console.error(`pum: fatal error\n${detail}`);
      }
      process.exit(code);
    },
  });
  // Signal death is not a failure, so it exits with the conventional
  // 128 + signal number (130 for SIGINT, 143 for SIGTERM) the way headless
  // mode does. Only the fatal-error path below keeps 1.
  for (const signal of shutdownSignals()) {
    process.on(signal, () => {
      shuttingDown = true;
      void shutdown(signalExitCode(signal));
    });
  }
  // OpenTUI installs its own uncaughtException and unhandledRejection handlers,
  // but they only log to its internal console: they never exit and never restore
  // the terminal. Without this, an escaped error leaves the alternate screen and
  // raw mode engaged while shells, triggers and subagents keep running.
  const failFast = (error: unknown): void => {
    if (shuttingDown) {
      // The shutdown chain itself failed. Its guard makes a second call a no-op,
      // so exit directly instead of hanging with a wedged terminal.
      console.error(`pum: shutdown failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exit(1);
    }
    shuttingDown = true;
    fatalError = error;
    void shutdown(1);
  };
  process.on("uncaughtException", failFast);
  process.on("unhandledRejection", failFast);

  root.render(
    <App
      session={sessionRuntime.session}
      onNewSession={async () => {
        const result = await sessionRuntime.newSession();
        if (!result.cancelled) statsManager.bindMainSession(sessionRuntime.session);
        return result.cancelled ? null : sessionRuntime.session;
      }}
      loadSessions={async () => sessionHistoryIndex.load(
        await SessionManager.list(cwd, sessionDir(cwd)),
      )}
      onSwitchSession={async (path) => {
        const result = await sessionRuntime.switchSession(path);
        if (!result.cancelled) statsManager.bindMainSession(sessionRuntime.session);
        return result.cancelled ? null : sessionRuntime.session;
      }}
      modelRuntime={modelRuntime}
      settings={settings}
      searchProviders={searchProviders}
      subagentManager={subagentManager}
      statsManager={statsManager}
      questionnaireManager={questionnaireManager}
      spawnPreviewManager={spawnPreviewManager}
      messageCacheController={messageCacheController}
      terminalTitle={terminalTitle}
      startupWarnings={[
        ...(sandboxWarning ? [sandboxWarning] : []),
        ...(outerSandbox ? [
          `Outer claudebox sandbox active (project ${outerSandbox.mode === "write" ? "read-write" : "read-only"}). Check mode follows the saved setting. The nested Bash sandbox is disabled.`,
        ] : []),
      ]}
      onSandboxModeChange={(mode) => {
        sandboxController.setMode(outerSandbox ? "off" : mode);
        subagentManager.refreshSandboxMode();
      }}
      forcedSandboxMode={outerSandbox ? "off" : undefined}
      forcedCheckPaths={forcedCheckPaths}
      sandboxWarningSource={sandboxController}
      loginRequired={loginRequired}
      triggerManager={triggerManager}
      shellManager={shellManager}
      onExit={() => shutdown(0)}
    />,
  );
}

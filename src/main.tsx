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
import { installWebSearch, webSearch } from "./web-search";
import { setWritingStyle, writingStyleExtension } from "./writing-style";
import { checkModePromptExtension, setSandboxModeSource } from "./check-mode-prompt";
import {
  explanationStrengthExtension,
  setExplanationStrength,
} from "./explanation-strength";
import {
  createCheckModeExtension,
  createExternalTriggerSafetyChecker,
  setCheckModeConfig,
} from "./check-mode";
import { CheckApprovalCoordinator, CheckApprovalStore } from "./check-approvals";
import { SubagentManager } from "./subagents/manager";
import { cleanupPendingImages } from "./image-paste";
import { shutdownSignals } from "./platform";
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
import { installSelectionClipboard } from "./clipboard";
import { TerminalTitleController } from "./terminal-title";
import { SandboxController } from "./sandbox";
import {
  createFilesystemSandboxExtension,
  filesystemSandboxExtension,
} from "./filesystem-sandbox";

export async function start(options: StartupOptions): Promise<void> {
  mkdirSync(AGENT_DIR, { recursive: true });

  const modelRuntime = await ModelRuntime.create({
    authPath: AUTH_PATH,
    modelsPath: MODELS_PATH,
  });
  const loginRequired = options.login || (await modelRuntime.getAvailable()).length === 0;

  const settings = loadSettings();
  const sandboxController = new SandboxController({
    mode: settings.sandboxMode ?? "auto",
    agentDir: AGENT_DIR,
  });
  setSandboxModeSource(() => sandboxController.mode);
  const sandboxWarning = await sandboxController.startupWarning(settings.checkMode);
  const sandboxExtension = sandboxController.extension();
  setWritingStyle(settings.writingStyle);
  setExplanationStrength(settings.explanationStrength);
  const questionnaireManager = new QuestionnaireManager();
  const spawnPreviewManager = new SpawnPreviewManager();
  const mainToolGroups = new ToolGroupsController("main");
  const sessionHistoryIndex = new SessionHistoryIndex();
  const messageCacheController = new MessageCacheController(process.cwd());
  setCheckModeConfig({
    profile: settings.checkMode,
    model: settings.checkModel,
    additionalPaths: checkPathsForProject(settings, process.cwd()),
  });
  const checkApprovalCoordinator = new CheckApprovalCoordinator();
  const checkApprovalStore = new CheckApprovalStore();
  const mainCheckModeExtension = createCheckModeExtension(modelRuntime, undefined, {
    coordinator: checkApprovalCoordinator,
    approvals: checkApprovalStore,
    identity: { kind: "main" },
  });
  const externalTriggerSafety = createExternalTriggerSafetyChecker(modelRuntime, {
    coordinator: checkApprovalCoordinator,
    approvals: checkApprovalStore,
  });
  let subagentManager!: SubagentManager;
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
    triggerManager,
    childExtensionFactories: [
      writingStyleExtension,
      explanationStrengthExtension,
      checkModePromptExtension,
    ],
    childExtensionFactoriesForAgent: [
      (agentId) => createCheckModeExtension(modelRuntime, undefined, {
        coordinator: checkApprovalCoordinator,
        approvals: checkApprovalStore,
        identity: { kind: "subagent", agentId },
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
            writingStyleExtension,
            explanationStrengthExtension,
            checkModePromptExtension,
            filesystemSandboxExtension,
            mainCheckModeExtension,
            sandboxExtension,
            applyPatchExtension,
            questionnaireManager.extension({ id: "main", name: "main" }),
            mainToolGroups.extension(),
            subagentExtension,
          ],
        },
      });
      // Each session tracks its own enabled tool groups, persisted next to
      // the session file. Restore before enable_tools registers and runs, then
      // narrow the outgoing tool list to core plus enabled groups.
      mainToolGroups.load(sessionManager.getSessionFile());
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

  if (sessionRuntime.modelFallbackMessage) console.error(sessionRuntime.modelFallbackMessage);

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const terminalTitle = new TerminalTitleController((title) => renderer.setTerminalTitle(title));
  const selectionClipboard = installSelectionClipboard(renderer);
  const root = createRoot(renderer);
  const shutdown = createShutdown({
    unmount: async () => {
      await settleSyntaxHighlighting(renderer.root);
      root.unmount();
    },
    cleanup: () => {
      terminalTitle.clear();
      selectionClipboard.dispose();
      cleanupPendingImages();
    },
    shutdownTriggers: () => triggerManager.shutdown(),
    dispose: () => sessionRuntime.dispose(),
    destroy: async () => {
      renderer.destroy();
      await destroyTreeSitterClient();
    },
    exit: (code) => process.exit(code),
  });
  for (const signal of shutdownSignals()) {
    process.on(signal, () => void shutdown(1));
  }

  root.render(
    <App
      session={sessionRuntime.session}
      onNewSession={async () => {
        const result = await sessionRuntime.newSession();
        return result.cancelled ? null : sessionRuntime.session;
      }}
      loadSessions={async () => sessionHistoryIndex.load(
        await SessionManager.list(cwd, sessionDir(cwd)),
      )}
      onSwitchSession={async (path) => {
        const result = await sessionRuntime.switchSession(path);
        return result.cancelled ? null : sessionRuntime.session;
      }}
      modelRuntime={modelRuntime}
      settings={settings}
      searchProviders={searchProviders}
      subagentManager={subagentManager}
      questionnaireManager={questionnaireManager}
      spawnPreviewManager={spawnPreviewManager}
      messageCacheController={messageCacheController}
      terminalTitle={terminalTitle}
      startupWarnings={sandboxWarning ? [sandboxWarning] : []}
      onSandboxModeChange={(mode) => {
        sandboxController.setMode(mode);
        subagentManager.refreshSandboxMode();
      }}
      sandboxWarningSource={sandboxController}
      loginRequired={loginRequired}
      checkApprovalCoordinator={checkApprovalCoordinator}
      checkApprovalStore={checkApprovalStore}
      triggerManager={triggerManager}
      onExit={() => shutdown(0)}
    />,
  );
}

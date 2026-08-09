#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { App } from "./app";
import { AGENT_DIR, AUTH_PATH, MODELS_PATH, sessionDir } from "./config";
import { loadSettings } from "./settings";
import { installWebSearch, webSearch } from "./web-search";
import { setWritingStyle, writingStyleExtension } from "./writing-style";
import {
  explanationStrengthExtension,
  setExplanationStrength,
} from "./explanation-strength";
import { createCheckModeExtension, setCheckModeConfig } from "./check-mode";
import { CheckApprovalCoordinator, CheckApprovalStore } from "./check-approvals";
import { SubagentManager } from "./subagents/manager";
import { cleanupPendingImages } from "./image-paste";
import { shutdownSignals } from "./platform";
import { createShutdown } from "./shutdown";
import { applyPatchExtension } from "./apply-patch";
import { QuestionnaireManager } from "./questionnaire";
import { SessionHistoryIndex } from "./session-history-metadata";
import { MESSAGE_CACHE_TOOLS, MessageCacheController } from "./message-cache";

mkdirSync(AGENT_DIR, { recursive: true });

const modelRuntime = await ModelRuntime.create({
  authPath: AUTH_PATH,
  modelsPath: MODELS_PATH,
});
const loginRequired = process.argv[2] === "login" || (await modelRuntime.getAvailable()).length === 0;

const settings = loadSettings();
setWritingStyle(settings.writingStyle);
setExplanationStrength(settings.explanationStrength);
const questionnaireManager = new QuestionnaireManager();
const sessionHistoryIndex = new SessionHistoryIndex();
const messageCacheController = new MessageCacheController(process.cwd());
setCheckModeConfig({ profile: settings.checkMode, model: settings.checkModel });
const checkApprovalCoordinator = new CheckApprovalCoordinator();
const checkApprovalStore = new CheckApprovalStore();
const checkModeExtension = createCheckModeExtension(modelRuntime, undefined, {
  coordinator: checkApprovalCoordinator,
  approvals: checkApprovalStore,
});
const subagentManager = new SubagentManager({
  modelRuntime,
  agentDir: AGENT_DIR,
  maxActiveSubagents: settings.maxActiveSubagents,
  questionnaireManager,
  messageCacheController,
  childExtensionFactories: [
    writingStyleExtension,
    explanationStrengthExtension,
    checkModeExtension,
  ],
});
const subagentExtension = subagentManager.mainExtension();
// Hosted web search rides on the provider, so it must be wrapped before the
// session picks a model.
webSearch.enabled = settings.webSearch;
const searchProviders = installWebSearch(modelRuntime);

// `pum -r` picks up the most recent session for this directory.
const resume = process.argv.includes("-r") || process.argv.includes("--resume");

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
          checkModeExtension,
          applyPatchExtension,
          questionnaireManager.extension({ id: "main", name: "main" }),
          subagentExtension,
        ],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: [
          "read", "write", "edit", "apply_patch", "bash", "questionnaire",
          "spawn_subagent", "message_agent", "list_subagents", "stop_subagent", "worktree",
          ...MESSAGE_CACHE_TOOLS,
        ],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  },
  {
    cwd,
    agentDir: AGENT_DIR,
    sessionManager: resume
      ? SessionManager.continueRecent(cwd, sessionDir(cwd))
      : SessionManager.create(cwd, sessionDir(cwd)),
  },
);

if (sessionRuntime.modelFallbackMessage) console.error(sessionRuntime.modelFallbackMessage);

const renderer = await createCliRenderer({ exitOnCtrlC: false });
const root = createRoot(renderer);
const shutdown = createShutdown({
  unmount: () => root.unmount(),
  cleanup: cleanupPendingImages,
  dispose: () => sessionRuntime.dispose(),
  destroy: () => renderer.destroy(),
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
    messageCacheController={messageCacheController}
    loginRequired={loginRequired}
    checkApprovalCoordinator={checkApprovalCoordinator}
    checkApprovalStore={checkApprovalStore}
    onExit={() => shutdown(0)}
  />,
);

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
import { spawnSync } from "node:child_process";
import { App } from "./app";
import { AGENT_DIR, AUTH_PATH, MODELS_PATH, sessionDir } from "./config";
import { loadSettings } from "./settings";
import { installWebSearch, webSearch } from "./web-search";
import { setWritingStyle, writingStyleExtension } from "./writing-style";
import { createCheckModeExtension, setCheckModeConfig } from "./check-mode";
import { SubagentManager } from "./subagents/manager";

mkdirSync(AGENT_DIR, { recursive: true });

// `pum login` hands off to pi's own interactive login, pointed at PUM's dir.
if (process.argv[2] === "login") {
  const { status } = spawnSync("bun", ["x", "pi"], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
  });
  console.log(`\nRun /login inside pi, then quit. Credentials land in ${AUTH_PATH}`);
  process.exit(status ?? 0);
}

const modelRuntime = await ModelRuntime.create({
  authPath: AUTH_PATH,
  modelsPath: MODELS_PATH,
});

const settings = loadSettings();
setWritingStyle(settings.writingStyle);
setCheckModeConfig({ enabled: settings.checkMode, model: settings.checkModel });
const checkModeExtension = createCheckModeExtension(modelRuntime);
const subagentManager = new SubagentManager({
  modelRuntime,
  agentDir: AGENT_DIR,
  childExtensionFactories: [writingStyleExtension, checkModeExtension],
});
const subagentExtension = subagentManager.mainExtension();
// Hosted web search rides on the provider, so it must be wrapped before the
// session picks a model.
webSearch.enabled = settings.webSearch;
const searchProviders = installWebSearch(modelRuntime);

if ((await modelRuntime.getAvailable()).length === 0) {
  console.error(`No credentials in ${AUTH_PATH}. Run: pum login`);
  process.exit(1);
}

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
        extensionFactories: [writingStyleExtension, checkModeExtension, subagentExtension],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: [
          "read", "write", "edit", "bash",
          "spawn_subagent", "message_agent", "list_subagents", "stop_subagent", "worktree",
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
createRoot(renderer).render(
  <App
    session={sessionRuntime.session}
    onNewSession={async () => {
      await sessionRuntime.newSession();
      return sessionRuntime.session;
    }}
    loadSessions={() => SessionManager.list(cwd, sessionDir(cwd))}
    onSwitchSession={async (path) => {
      await sessionRuntime.switchSession(path);
      return sessionRuntime.session;
    }}
    modelRuntime={modelRuntime}
    settings={settings}
    searchProviders={searchProviders}
    subagentManager={subagentManager}
  />,
);

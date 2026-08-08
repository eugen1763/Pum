#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { App } from "./app";
import { AGENT_DIR, AUTH_PATH, MODELS_PATH, sessionDir } from "./config";
import { loadSettings } from "./settings";
import { installWebSearch, webSearch } from "./web-search";

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

const { session, modelFallbackMessage } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: AGENT_DIR,
  modelRuntime,
  tools: ["read", "write", "edit", "bash"],
  sessionManager: resume
    ? SessionManager.continueRecent(process.cwd(), sessionDir(process.cwd()))
    : SessionManager.create(process.cwd(), sessionDir(process.cwd())),
});

if (modelFallbackMessage) console.error(modelFallbackMessage);

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App
    session={session}
    modelRuntime={modelRuntime}
    settings={settings}
    searchProviders={searchProviders}
  />,
);

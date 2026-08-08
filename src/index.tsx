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
import { AGENT_DIR, AUTH_PATH, MODELS_PATH } from "./config";
import { loadSettings } from "./settings";

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

if ((await modelRuntime.getAvailable()).length === 0) {
  console.error(`No credentials in ${AUTH_PATH}. Run: pum login`);
  process.exit(1);
}

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: AGENT_DIR,
  modelRuntime,
  tools: ["read", "write", "edit", "bash"],
  sessionManager: SessionManager.create(process.cwd()),
});

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App session={session} modelRuntime={modelRuntime} settings={loadSettings()} />,
);

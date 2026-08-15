import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goalFileFor } from "./goal";

/**
 * The one place the goal label is checked against a real terminal.
 *
 * OpenTUI's test renderer measures a frame buffer. tmux shows what a terminal
 * actually draws, which is where a rule that quietly wraps to two rows or a
 * label that overruns the right edge would show up.
 */

const tmux = Bun.which("tmux");
const SESSION = "pum-goal-rule-smoke";
const COLUMNS = 100;
const ROWS = 28;

let directory: string | undefined;

afterEach(async () => {
  if (tmux) await Bun.spawn([tmux, "kill-session", "-t", `=${SESSION}`]).exited.catch(() => {});
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function run(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output;
}

const HARNESS = `
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "${join(import.meta.dir, "app")}";

const sessionFile = process.argv[2];
const session = {
  sessionId: "main-session",
  sessionFile,
  agent: { state: {
    model: { id: "model", provider: "mock", input: ["text"], contextWindow: 32000 },
    thinkingLevel: "off",
  } },
  sessionManager: { buildContextEntries: () => [], getEntries: () => [] },
  subscribe: () => () => {},
  setThinkingLevel() {}, setModel: async () => {}, abort: async () => {},
  compact: async () => ({ tokensBefore: 0 }), prompt: async () => {}, steer: async () => {},
  followUp: async () => {}, clearQueue: () => ({ steering: [], followUp: [] }),
  getSteeringMessages: () => [], getFollowUpMessages: () => [],
};
const subagentManager = {
  getAgents: () => [], subscribe: () => () => {}, bindMainSession: async () => {},
  abortAgent: async () => {}, persistToolEvent() {},
};
const settings = {
  showThinking: false, theme: "tokyonight", animations: false,
  workingRuleAnimation: "off", webSearch: false, writingStyle: "none",
  explanationStrength: "simple", checkMode: "off", checkModel: "mock/check",
  maxActiveSubagents: 10, goalRetryLimit: 10,
};

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App session={session} modelRuntime={{ getAvailableSnapshot: () => [] }}
    onNewSession={async () => session} loadSessions={async () => []}
    onSwitchSession={async () => session} settings={settings}
    searchProviders={[]} subagentManager={subagentManager} />,
);
`;

describe.skipIf(!tmux)("goal rule in a real terminal", () => {
  test("the input-top rule stays one row and the prompt sits under it", async () => {
    // Inside the project, so the harness resolves the project's node_modules.
    directory = mkdtempSync(join(process.cwd(), ".pum-goal-tmux-"));
    const sessionFile = join(directory, "main-session.jsonl");
    const harness = join(directory, "harness.tsx");
    writeFileSync(harness, HARNESS);
    writeFileSync(goalFileFor(sessionFile), JSON.stringify({
      id: "goal-1",
      generation: 1,
      text: "fix the flaky tests in the parser suite",
      state: "active",
      createdAt: 1,
      updatedAt: 1,
      workGeneration: 0,
      lastJudgedWorkGeneration: 0,
      judgeCount: 0,
      incompleteCount: 0,
      retryLimit: 10,
    }));

    // Never pipe the app's stdout: a pipe is not a tty and OpenTUI stops drawing.
    await run([
      tmux!, "new-session", "-d", "-s", SESSION, "-x", String(COLUMNS), "-y", String(ROWS),
      `cd ${process.cwd()} && bun run ${harness} ${sessionFile} 2>${join(directory, "err.log")}`,
    ]);
    // A launch failure looks exactly like an empty capture, so prove it is alive.
    const alive = await run([tmux!, "has-session", "-t", `=${SESSION}`]);
    expect(alive).not.toContain("can't find session");

    let rows: string[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      await Bun.sleep(250);
      rows = (await run([tmux!, "capture-pane", "-t", `${SESSION}:0.0`, "-p"])).split("\n");
      if (rows.some((row) => row.includes("GOAL · active"))) break;
    }

    const labelled = rows.filter((row) => row.includes("GOAL · active"));
    expect(labelled).toHaveLength(1);

    const ruleRow = rows.findIndex((row) => row.includes("GOAL · active"));
    // One row: rule glyphs on the left, the label flush against the right edge.
    expect(rows[ruleRow]).toContain("─");
    expect(rows[ruleRow]!.trimEnd()).toMatch(/^─+GOAL · active · fix the flaky tests/);
    expect(Bun.stringWidth(rows[ruleRow]!.trimEnd())).toBeLessThanOrEqual(COLUMNS);
    // The label keeps its two right-padding columns inside the terminal.
    expect(rows[ruleRow]!.length).toBeLessThanOrEqual(COLUMNS);
    // Nothing wrapped: the row below is the prompt, not more of the rule.
    expect(rows[ruleRow + 1]).toContain("❯");
    expect(rows[ruleRow + 1]).not.toContain("─");
  }, 20_000);
});

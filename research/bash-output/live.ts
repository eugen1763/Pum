/**
 * Live benchmark: the REAL pi bash tool (baseline) vs the same tool wrapped by
 * PUM's withBashOutput. Measures the exact bytes that would land in the model
 * context (the tool-result content) for real commands.
 */

import { createBashTool } from "@earendil-works/pi-coding-agent";
import { executeBashWithOutput } from "../../src/bash-output";

const fakeCtx = {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "live-bench", getSessionFile: () => null },
  model: undefined,
  thinkingLevel: undefined,
};

const commands: Array<{ name: string; command: string; patterns?: string[]; full?: boolean }> = [
  { name: "3000-line loop", command: `for i in $(seq 1 3000); do echo "chunk $i some repeated text ######"; done` },
  {
    name: "failing loop (exit 1)",
    command: `for i in $(seq 1 400); do echo "item $i"; done; echo "FAIL: build error at 12"; exit 1`,
  },
  { name: "git log oneline", command: `git log --oneline -300 2>/dev/null || echo "no git"` },
  {
    name: "node_modules listing",
    command: `ls -R node_modules/@opentui 2>/dev/null | head -2500`,
  },
  {
    name: "pattern extraction test",
    command: `for i in $(seq 1 2500); do echo "row $i value=std"; done; echo "KEY=SECRET_TOKEN_xyz"; for i in $(seq 1 2500); do echo "row $i value=std"; done`,
    patterns: ["SECRET_TOKEN"],
  },
  {
    name: "unique mid-stream target (no collapse)",
    command: `modules="alpha beta gamma delta epsilon zeta eta theta iota kappa"; { for i in $(seq 1 240); do for m in $modules; do echo "[$((i*10+1))] built $m stage ok"; done; done; echo "[2401] built CACHE_IMPL_V2 stage ok"; for i in $(seq 241 480); do for m in $modules; do echo "[$((i*10+1))] built $m stage ok"; done; done; }`,
  },
  {
    name: "real bun test subset",
    command: `bun test tests/animation.test.ts --preload '' 2>&1 | head -2000 || true`,
  },
];

async function resultMetrics(run: () => Promise<any>) {
  try {
    const result = await run();
    const text = result?.content?.[0]?.text ?? "";
    return { bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, error: false, details: result?.details, contentText: text };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, error: true, details: undefined, contentText: text };
  }
}

function runBaseline(tool: ReturnType<typeof createBashTool>, command: string, extra: Record<string, unknown>) {
  return resultMetrics(() => (tool.execute as any)("id", { command, ...extra }, undefined, undefined, fakeCtx));
}

function runPum(command: string, extra: Record<string, unknown>) {
  return resultMetrics(() => executeBashWithOutput(
    process.cwd(),
    {},
    "id",
    { command, ...extra },
    undefined,
    undefined,
    fakeCtx,
  ));
}

async function main() {
  const base = createBashTool(process.cwd());

  console.log("# command | baseline bytes | pum bytes | reduction | notes");
  console.log("|---|---|---|---|---|");
  for (const c of commands) {
    const b = await runBaseline(base, c.command, {});
    const w = await runPum(c.command, {});
    const reduction = b.bytes / Math.max(1, w.bytes);
    const notes = [
      w.error ? "wrapped error path" : "",
      c.patterns ? `patterns raced` : "",
    ].filter(Boolean).join(", ") || (w.bytes < 4000 ? "summarized" : "kept full");
    console.log(`| ${c.name} | ${b.bytes} | ${w.bytes} | ${reduction.toFixed(1)}x | ${notes} |`);
  }

  // Pattern extraction check explicitly.
  const patCmd = commands[4]!;
  const bare = await runPum(patCmd.command, {});
  const withP = await runPum(patCmd.command, { patterns: ["SECRET_TOKEN"] });
  console.log("\nPATTERN TEST: bytes without patterns:", bare.bytes, "with patterns:", withP.bytes);

  const midTarget = commands[5]!.command;
  const midBare = await runPum(midTarget, {});
  const midP = await runPum(midTarget, { patterns: ["CACHE_IMPL_V2"] });
  const targetBare = midBare.contentText.includes("CACHE_IMPL_V2");
  const targetP = midP.contentText.includes("CACHE_IMPL_V2");
  console.log("MID TARGET TEST: bytes", midBare.bytes, "->", midP.bytes, "| target present without patterns:", targetBare, "| with patterns:", targetP);
}

main();

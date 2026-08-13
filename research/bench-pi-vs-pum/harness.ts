/**
 * PUM vs pi benchmark harness over Aider's polyglot exercise set.
 *
 * This is NOT Aider's own harness. Aider's benchmark.py drives Aider's loop.
 * We extract the Exercism exercises and drive `pi -ne` and `pum -p` directly
 * so we can compare the two agents on identical prompts.
 *
 * The user runs this from a terminal (not through a checked agent) because it
 * clones the exercise repo, installs per-exercise test dependencies, and runs
 * the fetched tests.
 *
 * Usage (from the repo root):
 *   bun run research/bench-pi-vs-pum/harness.ts --track all --limit 5
 *   bun run research/bench-pi-vs-pum/harness.ts --dry
 *   bun run research/bench-pi-vs-pum/harness.ts --track js --problem affine-cipher
 *
 * Metrics per run: pass/fail, wall-clock seconds, and best-effort token usage
 * read from each agent's session files.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "../..");
const PI_CLI = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

// ---------------------------------------------------------------------------
// Track configuration
// ---------------------------------------------------------------------------

type TestCommand = (dir: string) => string[];

type Track = {
  id: string;
  dir: string;
  label: string;
  tool: string[];
  promptFiles: string[];
  test: TestCommand;
  /** Enable skipped tests before scoring. */
  enableTests: (text: string) => string;
  testFiles: string[];
};

function hasTool(tool: string): boolean {
  try {
    // r.error is set only when the binary cannot be found on PATH.
    const r = spawnSync(tool, ["--version"], { stdio: "ignore", windowsHide: true });
    return r.error === undefined;
  } catch {
    return false;
  }
}

let cachedNodeExe: string | null = null;

/** Absolute path to the real node.exe, resolved once via node itself. */
function nodeExe(): string {
  if (cachedNodeExe) return cachedNodeExe;
  let result = "node";
  try {
    const r = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true });
    const p = (r.stdout || "").trim();
    if (p && existsSync(p)) result = p;
  } catch {}
  cachedNodeExe = result;
  return result;
}

let cachedNpmCli: string | null = null;

/** Absolute path to npm's npm-cli.js, resolved from the node install. */
function npmCliPath(): string {
  if (cachedNpmCli) return cachedNpmCli;
  let result = "node_modules/npm/bin/npm-cli.js";
  const nodeDir = dirname(nodeExe());
  const candidate = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(candidate)) result = candidate;
  cachedNpmCli = result;
  return result;
}

const TRACKS: Track[] = [
  {
    id: "js",
    dir: "javascript",
    label: "JavaScript",
    tool: ["node", "npm", "npx"],
    promptFiles: [".docs/instructions.md", ".docs/instructions.append.md"],
    // Run jest via the real node.exe so scoring does not depend on PATH or
    // .cmd shims. If deps are missing, install them via npm-cli.js first.
    test: (dir) =>
      existsSync(join(dir, "node_modules", "jest"))
        ? [nodeExe(), "node_modules/jest/bin/jest.js", "--ci"]
        : [
            nodeExe(), npmCliPath(), "install", "--no-audit", "--no-fund", "--silent",
            "&&", nodeExe(), "node_modules/jest/bin/jest.js", "--ci",
          ],
    enableTests: (t) =>
      t.replace(/\bxtest\(/g, "test(").replace(/\bxit\(/g, "it(").replace(/\bxdescribe\(/g, "describe("),
    testFiles: ["*.spec.js"],
  },
  {
    id: "go",
    dir: "go",
    label: "Go",
    tool: ["go"],
    promptFiles: [".docs/instructions.md", ".docs/instructions.append.md"],
    test: (dir) => ["go", "test", "./..."],
    enableTests: (t) => t,
    testFiles: ["*_test.go"],
  },
  {
    id: "python",
    dir: "python",
    label: "Python",
    tool: ["uv"],
    promptFiles: [".docs/instructions.md", ".docs/instructions.append.md"],
    test: (dir) => ["uv", "run", "--with", "pytest", "python", "-m", "pytest", "-q"],
    enableTests: (t) => t,
    testFiles: ["*_test.py", "test_*.py"],
  },
  {
    id: "cpp",
    dir: "cpp",
    label: "C++",
    tool: ["g++"],
    promptFiles: [".docs/instructions.md", ".docs/instructions.append.md"],
    // Exercism cpp uses CMake + Catch2. Best effort; gated on cmake/g++.
    test: (dir) => ["cmake", "-S", ".", "-B", "build", "&&", "cmake", "--build", "build", "&&", "ctest", "--test-dir", "build", "--output-on-failure"],
    enableTests: (t) => t,
    testFiles: ["test/**/*.cpp", "*.test.cpp"],
  },
  {
    id: "java",
    dir: "java",
    label: "Java",
    tool: ["java", "javac"],
    promptFiles: [".docs/instructions.md", ".docs/instructions.append.md"],
    test: (dir) => (existsSync(join(dir, "gradlew")) ? ["./gradlew", "test"] : ["mvn", "test"]),
    enableTests: (t) => t.replace(/@Disabled\b/g, ""),
    testFiles: ["src/test/**/*.java"],
  },
  {
    id: "rust",
    dir: "rust",
    label: "Rust",
    tool: ["cargo"],
    promptFiles: [".docs/instructions.md", ".docs/instructions.append.md"],
    test: (dir) => ["cargo", "test"],
    enableTests: (t) => t.replace(/^\s*#\[ignore\]\s*$/gm, ""),
    testFiles: ["tests/*.rs"],
  },
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function args(): {
  tracks: string[];
  limit: number;
  problem?: string;
  agents: string[];
  work?: string;
  timeout: number;
  dry: boolean;
  tokens: boolean;
  piCmd: string;
  pumCmd: string;
} {
  const a = process.argv.slice(2);
  const out = {
    tracks: ["all"],
    limit: 10,
    problem: undefined as string | undefined,
    agents: ["pi", "pum"],
    work: undefined as string | undefined,
    timeout: 300,
    dry: false,
    tokens: true,
    piCmd: process.env.PI_CMD ?? `node ${PI_CLI}`,
    pumCmd: process.env.PUM_CMD ?? `bun run ${ROOT}/src/index.tsx`,
  };
  const readVal = (i: number) => a[i + 1];
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    switch (k) {
      case "--track":
        out.tracks = readVal(i).split(",");
        i++;
        break;
      case "--limit":
        out.limit = parseInt(readVal(i), 10);
        i++;
        break;
      case "--problem":
        out.problem = readVal(i);
        i++;
        break;
      case "--agents":
        out.agents = readVal(i).split(",");
        i++;
        break;
      case "--work":
        out.work = readVal(i);
        i++;
        break;
      case "--timeout":
        out.timeout = parseInt(readVal(i), 10);
        i++;
        break;
      case "--pi-cmd":
        out.piCmd = readVal(i);
        i++;
        break;
      case "--pum-cmd":
        out.pumCmd = readVal(i);
        i++;
        break;
      case "--dry":
        out.dry = true;
        break;
      case "--no-tokens":
        out.tokens = false;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bun run research/bench-pi-vs-pum/harness.ts [options]
  --track <t1,t2|all>   tracks to run (js,go,python,cpp,java,rust,all)
  --limit <n>           max exercises per track (default 10)
  --problem <name>      run one exercise by name
  --agents <pi,pum>     which agents to run (default both)
  --work <dir>          scratch dir for the cloned repo and runs
  --timeout <sec>       per-agent timeout (default 300)
  --pi-cmd <cmd>        override the pi command
  --pum-cmd <cmd>       override the pum command
  --dry                 validate plumbing without invoking the model
  --no-tokens           disable token capture`);
        process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  timedOut: boolean;
};

function run(argv: string[], cwd: string, timeoutSec: number, env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolvePromise({ code: null, stdout, stderr, wallMs: Date.now() - started, timedOut: true });
    }, timeoutSec * 1000);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: stderr + String(err), wallMs: Date.now() - started, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, wallMs: Date.now() - started, timedOut: false });
    });
  });
}

async function runSteps(argv: string[], cwd: string, timeoutSec: number): Promise<RunResult> {
  // Split on "&&" and run each step as a plain argv process (no shell). Every
  // step uses a real executable (node.exe, go, uv, java) with filename args,
  // never a .cmd/.bat shim, so this resolves reliably on Windows.
  const steps: string[][] = [];
  let cur: string[] = [];
  for (const v of argv) {
    if (v === "&&") {
      steps.push(cur);
      cur = [];
    } else {
      cur.push(v);
    }
  }
  if (cur.length) steps.push(cur);
  let last: RunResult = { code: null, stdout: "", stderr: "", wallMs: 0, timedOut: false };
  for (const step of steps) {
    last = await run(step, cwd, timeoutSec);
    if (last.code !== 0 || last.timedOut) break;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Data + exercise enumeration
// ---------------------------------------------------------------------------

const DEFAULT_WORK = join(ROOT, "research/bench-pi-vs-pum/.work");
const DATA_DIR = "polyglot-benchmark";
const REPO = "https://github.com/Aider-AI/polyglot-benchmark.git";

function ensureData(work: string): string {
  const dataDir = join(work, DATA_DIR);
  if (!existsSync(join(dataDir, ".git"))) {
    return dataDir; // clone happens in --dry-safe command sequence below
  }
  return dataDir;
}

function promptFor(track: Track, exerciseDir: string): string {
  const parts: string[] = [];
  for (const f of track.promptFiles) {
    const p = join(exerciseDir, f);
    if (existsSync(p)) parts.push(readFileSync(p, "utf8").trim());
  }
  return parts.filter(Boolean).join("\n\n");
}

function exerciseNames(track: Track, dataDir: string): string[] {
  const root = join(dataDir, track.dir, "exercises", "practice");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function copyDir(src: string, dst: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else if (entry.isFile()) {
      const content = readFileSync(s);
      writeFileSync(d, content);
    }
  }
}

function enableTestsInDir(track: Track, runDir: string): void {
  const all = walkFiles(runDir);
  for (const f of all) {
    const match = track.testFiles.some((g) => globMatch(g, basename(f)) || globMatch(g, rel(f, runDir)));
    if (!match) continue;
    const text = readFileSync(f, "utf8");
    const en = track.enableTests(text);
    if (en !== text) writeFileSync(f, en);
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "build") continue;
      out.push(...walkFiles(p));
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
function rel(p: string, dir: string): string {
  return p.slice(dir.length + 1).replace(/\\/g, "/");
}
function globMatch(glob: string, name: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(name);
}

// ---------------------------------------------------------------------------
// Token capture (best effort)
// ---------------------------------------------------------------------------

/** PUM's Windows session subdirectory name (mirrors src/platform.ts). */
function pumSessionDirName(cwd: string): string {
  const canonical = win32.resolve(cwd).toLowerCase();
  const readable = canonical
    .replace(/^\\\\/, "unc-")
    .replace(/^[a-z]:\\/i, (m) => `${m[0]}-`)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `--${readable || "root"}-${digest}--`;
}

/** Where a specific run's session files live for one agent. */
function agentSessionDir(agent: string, runDir: string): string | null {
  if (agent === "pum") {
    let agentDir: string;
    if (process.env.PUM_DIR) {
      agentDir = win32.resolve(process.env.PUM_DIR);
    } else {
      const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local");
      agentDir = join(base, "pum");
    }
    return join(agentDir, "sessions", pumSessionDirName(runDir));
  }
  if (agent === "pi") {
    const agentDir = process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi", "agent");
    const sub = `--${runDir.replace(/[/\\:]/g, "-")}--`;
    return join(agentDir, "sessions", sub);
  }
  return null;
}

/**
 * Sum token usage from this run's session files modified within `withinMs`.
 * pi and PUM store each run in its own subdirectory under the agent's sessions
 * dir; we target that exact subdirectory and only recent .jsonl files within it.
 */
function collectTokens(agent: string, runDir: string, withinMs: number): number | null {
  const dir = agentSessionDir(agent, runDir);
  if (!dir || !existsSync(dir)) return null;
  let total = 0;
  let found = false;
  const now = Date.now();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > withinMs) continue;
    } catch {
      continue;
    }
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const usage = obj?.usage ?? obj?.message?.usage ?? obj?.tool_result?.usage;
        if (!usage) continue;
        found = true;
        const input = usage.input ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
        const output = usage.output ?? usage.output_tokens ?? usage.completion_tokens ?? 0;
        const cacheRead = usage.cacheRead ?? usage.cache_read ?? 0;
        const cacheWrite = usage.cacheWrite ?? usage.cache_write ?? 0;
        const reasoning = usage.reasoning ?? 0;
        total += Number((usage.totalTokens ?? (input + output + cacheRead + cacheWrite + reasoning)) || 0);
      } catch {}
    }
  }
  return found ? total : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type RunOutcome = {
  track: string;
  exercise: string;
  agent: string;
  pass?: boolean;
  seconds?: number;
  tokens?: number | null;
  exitCode?: number | null;
  skipped?: boolean;
  reason?: string;
};

async function main() {
  const o = args();
  const work = o.work ?? DEFAULT_WORK;
  mkdirSync(work, { recursive: true });

  // 1. Clone data if needed.
  const dataDir = join(work, DATA_DIR);
  if (!existsSync(join(dataDir, ".git"))) {
    if (o.dry) {
      console.log(`[dry] would clone ${REPO} -> ${dataDir}`);
    } else {
      console.log(`Cloning ${REPO} ...`);
      const c = await run(["git", "clone", "--depth", "1", REPO, dataDir], work, 600);
      if (c.code !== 0) {
        console.error("Failed to clone exercise repo:\n" + c.stderr);
        process.exit(1);
      }
    }
  }

  const selectedTracks = o.tracks[0] === "all" ? TRACKS : TRACKS.filter((t) => o.tracks.includes(t.id));

  // 2. Verify agent commands + toolchains.
  const piSpawnable = o.agents.includes("pi");
  const pumSpawnable = o.agents.includes("pum");
  const agentChecks: string[] = [];
  if (!piSpawnable && !pumSpawnable) {
    console.error("No agents selected. Use --agents pi,pum");
    process.exit(1);
  }
  if (o.dry) {
    console.log("\n=== DRY RUN: plumbing check ===");
    for (const t of selectedTracks) {
      const missing = t.tool.filter((x) => !hasTool(x));
      const names = t.tool.length ? exerciseNames(t, dataDir) : [];
      console.log(`[${t.id}] ${t.label}: tools ${missing.length ? "MISSING " + missing.join(",") : "ok"} | exercises ${names.length}`);
    }
    console.log("\nAgent commands:");
    if (piSpawnable) console.log(`  pi  : ${o.piCmd} -ne -p <prompt>`);
    if (pumSpawnable) console.log(`  pum : ${o.pumCmd} -p <prompt>`);
    console.log("\nDry mode completes without invoking the model. Exiting.");
    return;
  }

  const outcomes: RunOutcome[] = [];

  for (const track of selectedTracks) {
    const missing = track.tool.filter((x) => !hasTool(x));
    const all = exerciseNames(track, dataDir);
    if (all.length === 0) {
      console.log(`[${track.id}] no exercises found; skipping`);
      continue;
    }
    if (missing.length) {
      console.log(`[${track.id}] skipping (missing toolchain: ${missing.join(", ")}); ${all.length} exercises available`);
      for (const name of all.slice(0, o.limit)) {
        for (const agent of o.agents) {
          outcomes.push({ track: track.id, exercise: name, agent, skipped: true, reason: `missing toolchain: ${missing.join(", ")}` });
        }
      }
      continue;
    }

    const chosen = o.problem ? all.filter((n) => n === o.problem) : all.slice(0, o.limit);
    if (o.problem && chosen.length === 0) {
      console.error(`[${track.id}] exercise not found: ${o.problem}`);
      continue;
    }
    console.log(`\n[${track.id}] ${track.label}: running ${chosen.length} exercises`);

    for (const name of chosen) {
      const srcDir = join(dataDir, track.dir, "exercises", "practice", name);
      const prompt = promptFor(track, srcDir) || "(no instructions file)";
      const task = `${track.id}/${name}`;
      console.log(`\n--- ${task} ---`);

      for (const agent of o.agents) {
        const runDir = join(work, "runs", track.id, name, agent);
        // Fresh copy per agent so edits never leak between agents.
        rmSync(runDir, { recursive: true, force: true });
        mkdirSync(runDir, { recursive: true });
        copyDir(srcDir, runDir);
        enableTestsInDir(track, runDir);

        const header = `You are working in a coding exercise directory. Read the existing source
file(s), implement the required function(s), and make ALL the tests pass.
Edit the existing files directly. Run the test command yourself to verify
before you finish. Respond concisely.

Instructions:
${prompt}`;

        const cmd = agent === "pi" ? o.piCmd : o.pumCmd;
        const argv = cmd.split(" ").map((x) => x.trim()).filter(Boolean);
        const argsForPrompt = agent === "pi" ? [...argv, "-ne", "-p", header] : [...argv, "-p", header];

        const started = Date.now();
        const res = await run(argsForPrompt, runDir, o.timeout);
        const seconds = (Date.now() - started) / 1000;

        let tokens: number | null = null;
        if (o.tokens && !res.timedOut) {
          tokens = collectTokens(agent, runDir, Math.max(30_000, o.timeout * 1000 + 10_000));
        }

        // Score: run the exercise tests after the agent finishes.
        const testRes = await runSteps(track.test(runDir), runDir, Math.min(o.timeout, 300));
        const pass = testRes.timedOut ? false : testRes.code === 0;
        let reason = "";
        if (testRes.timedOut) reason = "test timed out";
        else if (testRes.code === null) reason = `test spawn error: ${(testRes.stderr || "").trim().split("\n").pop() ?? ""}`;
        else if (testRes.code !== 0) {
          const tail = (testRes.stdout + "\n" + testRes.stderr).trim().split("\n").slice(-3).join(" | ");
          reason = `tests failed (exit ${testRes.code}): ${tail}`;
        }

        outcomes.push({
          track: track.id,
          exercise: name,
          agent,
          pass,
          seconds: Math.round(seconds * 100) / 100,
          tokens,
          exitCode: res.code,
          reason: reason || undefined,
        });
        console.log(`  [${agent}] ${pass ? "PASS" : "FAIL"} in ${seconds.toFixed(1)}s tokens=${tokens ?? "n/a"} exit=${res.code}${reason ? " | " + reason : ""}`);
      }
    }
  }

  // 3. Report.
  const report = join(work, "results.json");
  writeFileSync(report, JSON.stringify(outcomes, null, 2));
  console.log(`\n\n=== SUMMARY ===`);
  console.log(`| agent | track/exercise | pass | seconds | tokens |`);
  console.log(`|---|---|---|---|---|`);
  for (const r of outcomes) {
    if (r.skipped) {
      console.log(`| ${r.agent} | ${r.track}/${r.exercise} | skipped | - | - |`);
      continue;
    }
    console.log(`| ${r.agent} | ${r.track}/${r.exercise} | ${r.pass ? "PASS" : "FAIL"} | ${r.seconds} | ${r.tokens ?? "n/a"} |`);
  }
  console.log(`\nFull results: ${report}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

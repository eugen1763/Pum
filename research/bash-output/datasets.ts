/**
 * Realistic bash-output datasets plus the information anchor each one must keep.
 *
 * Each dataset simulates a real command's stdout/stderr shape so a policy can
 * be judged on "did the agent still see what it needed", not just on bytes.
 */

export type Dataset = {
  id: string;
  label: string;
  /** The real-world command this output mimics. */
  simulates: string;
  /** Anchor substring that MUST survive any useful policy. */
  anchor: string;
  /** A second anchor (optional) that must survive too. */
  anchor2?: string;
  /** Process exit code the tool reported for this run. */
  exitCode: number;
  /** True when the informative content sits in the FIRST lines. */
  headImportant?: boolean;
  /** True when the informative content sits in the LAST lines. */
  tailImportant?: boolean;
  /** True when informative content sits in the middle (surrounded by noise). */
  middleImportant?: boolean;
  /** True when output is dominated by near-identical lines (compressible). */
  repetitive?: boolean;
  text: string;
};

const LINE = "some repeated filler content to simulate real command chatter ####";

/** A full passing `bun test` run: many pass lines, summary at the end. */
function passTestRun(): string {
  const parts: string[] = [];
  for (let i = 0; i < 1200; i++) {
    parts.push(`bun test v1.3.14 (da8a37bf)\n`);
  }
  for (let i = 0; i < 1200; i++) {
    parts.push(`  ✓ math/ops${i % 50} › does arithmetic binding ${i}\n`);
  }
  parts.push(
    "  1200 pass\n" +
      "  0 fail\n" +
      "  0 skip\n" +
      " 1224 pass (2.3s)\n" +
      "Test Files: 42 passed | 0 failed\n" +
      "     Tests: 1200 passed | 0 failed\n",
  );
  return parts.join("");
}

/** A failing `bun test`: dots, then FAIL blocks + summary at the END. */
function failTestRunEnd(): string {
  const parts: string[] = [];
  for (let i = 0; i < 900; i++) parts.push(`...`); // progress dots
  parts.push("\n");
  for (let i = 0; i < 900; i++) parts.push(`    ${LINE}\n`);
  parts.push(
    "FAIL src/parse/lexer.test.ts > lexer > handles string literal escapes\n" +
      "error: Expected \" but found } at column 12\n" +
      "  src/parse/lexer.ts:42:9\n" +
      "      41 |   const s = input[i];\n" +
      `       ^\n` +
      "FAIL src/parse/parser.test.ts > parser > handles nested arrays\n" +
      "error: Unexpected token ] at column 8\n" +
      "  src/parse/parser.ts:87:7\n" +
      `       ^\n` +
      "  900 pass\n" +
      "  2 fail\n" +
      "  0 skip\n" +
      "Test Files: 3 failed | 39 passed\n" +
      "     Tests: 902 passed | 2 failed\n" +
      "\n[MUTATION_ANCHOR] failures live at the very end\n",
  );
  return parts.join("");
}

/** A failing run where the FAIL block is in the MIDDLE, followed by more noise. */
function failTestRunMiddle(): string {
  const parts: string[] = [];
  for (let i = 0; i < 700; i++) parts.push(`    ${LINE}\n`);
  for (let i = 0; i < 500; i++) parts.push(`...`);
  parts.push("\n");
  parts.push(
    "RUN  src/cache.test.ts > cache > evicts least recently used\n" +
      "FAIL [ANCHOR_MID] src/cache.test.ts > cache > evicts least recently used\n" +
      "error: expected 1 to equal 0\n" +
      "  src/cache.ts:55:13\n" +
      `       ^\n`,
  );
  for (let i = 0; i < 1500; i++) parts.push(`    ${LINE}\n`);
  parts.push(
    "  1998 pass\n" +
      "  1 fail\n" +
      "Test Files: 1 failed | 41 passed\n" +
      "     Tests: 1998 passed | 1 failed\n",
  );
  return parts.join("");
}

/** `find . -type f` style recursive listing: thousands of file paths. */
function recursiveListing(): string {
  const parts: string[] = [];
  for (let i = 0; i < 60; i++) parts.push(`./packages/${String(i).padStart(2, "0")}/\n`);
  parts.push(`./src/index.ts\n./src/main.tsx\n./src/app.tsx\n./src/theme.ts\n`);
  parts.push(`./node_modules/.bin/\n`);
  for (let i = 0; i < 4000; i++) {
    parts.push(`./node_modules/pkg-${i}/dist/file-${i % 40}.js\n`);
  }
  parts.push(`./README.md\n`);
  return parts.join("");
}

/** `git log --oneline -N`: many commits. Head holds the newest. */
function gitLog(): string {
  const parts: string[] = [];
  for (let i = 0; i < 2200; i++) {
    const hash = `a${String(9999999 - i)}`;
    parts.push(`${hash} fix: handle edge case in cache layer ${i}\n`);
  }
  return parts.join("");
}

/** Build tool that prints near-identical compile lines then a final status. */
function compileProgress(): string {
  const parts: string[] = [];
  for (let i = 0; i < 3000; i++) {
    parts.push(`Compiling package ${i} of 3000 [${"=".repeat((i % 40) + 1)}>\n`);
  }
  parts.push(` done compiled in 4.2s [BUILD_ANCHOR]\n`);
  return parts.join("");
}

/** npm-style progress dots, then a summary. */
function npmInstall(): string {
  const parts: string[] = [];
  for (let i = 0; i < 400; i++) {
    parts.push(`add ${i} ######################################################################################\n`);
  }
  for (let i = 0; i < 3000; i++) parts.push(`.`);
  parts.push(`\nnpm warn deprecated foo@1.0.0\nadded 400 packages in 12s [NPM_ANCHOR]\n`);
  return parts.join("");
}

/** One enormous single line (minified JSON), tests the byte bound. */
function singleHugeLine(): string {
  const chunk = '{"name":"pkg","version":"1.0.0","files":["a","b","c"],"scripts":{"x":"y"}},';
  let line = "[";
  for (let i = 0; i < 30000; i++) line += chunk;
  line += "]";
  return `\n${line}\n[[SINGLE_ANCHOR_TRAILING]]\n`;
}

/** ANSI-colored TTY output: every line wrapped in codes, summary at the end. */
function ansiColored(): string {
  const parts: string[] = [];
  for (let i = 0; i < 1800; i++) {
    parts.push(`\u001b[32m$ \u001b[0mtest ${i} \u001b[1mok\u001b[0m ${LINE}\n`);
  }
  parts.push(`\u001b[31m\u001b[1m[ANSI_SUMMARY_ANCHOR]\u001b[0m\u001b[0m\n`);
  return parts.join("");
}

/** Thousands of identical lines. */
function repeats(): string {
  const x = `${"x".repeat(120)} ${LINE}\n`;
  return x.repeat(6000);
}

/** Tiny dot-matrix progress that collapses. */
function dotMatrix(): string {
  let dots = "";
  for (let i = 0; i < 8000; i++) dots += ".";
  return `${dots}\nOK (8123 tests) [DOTS_ANCHOR]\n`;
}

/** A tool with a low-value banner, a mid warning block, trailing noise. */
function bannerMiddleWarn(): string {
  const banner = `Tool X version 9.2.1\nCopyright 2024\nRunning in managed mode\n[type /help for options]\n`;
  const mid = `\nWARNING [WARN_ANCHOR] deprecated flag --legacy will be removed\n        at C:\app\main.js:1200\n`;
  const noise = (`processing chunk ... ${LINE}\n`).repeat(1800);
  const end = `done. 0 errors. [END_ANCHOR]\n`;
  return banner + mid + noise + end;
}

/** A command that fails fast with a single long line of output. */
function failHugeLine(): string {
  const huge = `{"error":"crash","payload":"${"z".repeat(200000)}"}`;
  return `command ran\n${huge}\n[[FAIL_HUGE_ANCHOR]]\n`;
}

/** 5200 UNIQUE lines with one target line buried at index 2517. */
function uniqueList(): string {
  const parts: string[] = [];
  for (let i = 0; i < 5200; i++) {
    if (i === 2517) {
      parts.push(`src/cache/telemetry/TARGET_FILE_scan_trigger.ts\n`);
    } else {
      parts.push(`packages/mod-${i % 80}/src/gen_${i}_${(i * 7) % 1000}.ts\n`);
    }
  }
  return parts.join("");
}

/** 3000 identical-format noise lines with one target at index 1500. */
function patternTarget(): string {
  const parts: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const line =
      i === 1500 ? `stream: MASTER_ANCHOR_7f3 event=42 value=cached_kind` : `stream: evt-${i} kind=normal`;
    parts.push(`${line}\n`);
  }
  return parts.join("");
}

/** Progress dots interleaved with a warning every ~300 lines. */
function interleavedWarnings(): string {
  const parts: string[] = [];
  for (let i = 0; i < 2400; i++) {
    parts.push(`.`);
    if (i % 300 === 150) {
      parts.push(`warning: deprecated API used (see [WARN_ANCHOR]) in module ${i}\n`);
    }
  }
  parts.push(`\n2400 ticks complete [TAIL]\n`);
  return parts.join("");
}

/** Verbose debug log + a trailing JSON test summary. */
function jsonSummary(): string {
  const parts: string[] = [];
  for (let i = 0; i < 1600; i++) {
    parts.push(`[debug] module ${i} loaded in ${i % 50}ms handler=${i % 12}\n`);
  }
  parts.push(`{"glob":{"tests":2000,"failures":0,"duration":1234,"files":["a","b"]}}\n`);
  return parts.join("");
}

/** 3000 near-identical version lines then a total. */
function versionList(): string {
  const parts: string[] = [];
  for (let i = 0; i < 3000; i++) {
    parts.push(`pkg-abc-1.0.${i % 9} installed in region ${i % 7}\n`);
  }
  parts.push(`TOTAL: 3000 packages [VER_ANCHOR]\n`);
  return parts.join("");
}

const datasets: Dataset[] = [
  {
    id: "testPass",
    label: "bun test (pass, 2400 lines)",
    simulates: "bun test",
    anchor: "Test Files: 42 passed | 0 failed",
    exitCode: 0,
    tailImportant: true,
    repetitive: true,
    text: passTestRun(),
  },
  {
    id: "testFailEnd",
    label: "bun test (fail in tail)",
    simulates: "bun test",
    anchor: "2 fail",
    anchor2: "[MUTATION_ANCHOR]",
    exitCode: 1,
    tailImportant: true,
    text: failTestRunEnd(),
  },
  {
    id: "testFailMid",
    label: "bun test (fail in middle)",
    simulates: "bun test",
    anchor: "[ANCHOR_MID]",
    anchor2: "1 fail",
    exitCode: 1,
    middleImportant: true,
    tailImportant: true,
    text: failTestRunMiddle(),
  },
  {
    id: "lsRecursive",
    label: "find . -type f (many paths)",
    simulates: "find . -type f",
    anchor: "./src/main.tsx",
    anchor2: "./README.md",
    exitCode: 0,
    headImportant: true,
    tailImportant: true,
    text: recursiveListing(),
  },
  {
    id: "gitLog",
    label: "git log -N (commits)",
    simulates: "git log --oneline",
    anchor: "a9999999 fix: handle edge case in cache layer 0",
    exitCode: 0,
    headImportant: true,
    text: gitLog(),
  },
  {
    id: "compileProgress",
    label: "build progress 3000 lines",
    simulates: "bun build",
    anchor: "[BUILD_ANCHOR]",
    exitCode: 0,
    tailImportant: true,
    repetitive: true,
    text: compileProgress(),
  },
  {
    id: "npmInstall",
    label: "npm install (dots + summary)",
    simulates: "npm install",
    anchor: "[NPM_ANCHOR]",
    exitCode: 0,
    tailImportant: true,
    repetitive: true,
    text: npmInstall(),
  },
  {
    id: "singleHugeLine",
    label: "one 200KB line",
    simulates: "cat bundle.json",
    anchor: "[[SINGLE_ANCHOR_TRAILING]]",
    exitCode: 0,
    tailImportant: true,
    text: singleHugeLine(),
  },
  {
    id: "ansiColored",
    label: "ANSI-colored test output",
    simulates: "bun test --no-pretty? (TTY)",
    anchor: "[ANSI_SUMMARY_ANCHOR]",
    exitCode: 0,
    tailImportant: true,
    text: ansiColored(),
  },
  {
    id: "repeats",
    label: "6000 identical lines",
    simulates: "looping script",
    anchor: LINE,
    exitCode: 0,
    repetitive: true,
    text: repeats(),
  },
  {
    id: "dotMatrix",
    label: "8000 progress dots + OK",
    simulates: "test runner dots",
    anchor: "[DOTS_ANCHOR]",
    exitCode: 0,
    tailImportant: true,
    repetitive: true,
    text: dotMatrix(),
  },
  {
    id: "bannerMidWarn",
    label: "banner + mid warning + noise",
    simulates: "verbose CLI tool",
    anchor: "[WARN_ANCHOR]",
    anchor2: "[END_ANCHOR]",
    exitCode: 0,
    middleImportant: true,
    tailImportant: true,
    text: bannerMiddleWarn(),
  },
  {
    id: "failHugeLine",
    label: "one huge error line",
    simulates: "crashing CLI",
    anchor: "[[FAIL_HUGE_ANCHOR]]",
    exitCode: 1,
    tailImportant: true,
    text: failHugeLine(),
  },
  {
    id: "uniqueList",
    label: "5200 unique paths, one target midline",
    simulates: "find . -type f (big monorepo)",
    anchor: "TARGET_FILE_scan_trigger.ts",
    exitCode: 0,
    headImportant: true,
    middleImportant: true,
    tailImportant: true,
    text: uniqueList(),
  },
  {
    id: "patternTarget",
    label: "target line buried at index 1500",
    simulates: "grep-less tool dump",
    anchor: "MASTER_ANCHOR_7f3",
    exitCode: 0,
    middleImportant: true,
    text: patternTarget(),
  },
  {
    id: "interleavedWarnings",
    label: "progress dots interleaved with warnings",
    simulates: "test runner with deprecation warnings",
    anchor: "[WARN_ANCHOR]",
    exitCode: 0,
    middleImportant: true,
    tailImportant: true,
    text: interleavedWarnings(),
  },
  {
    id: "jsonSummary",
    label: "verbose log + trailing JSON summary",
    simulates: "bun test --reporter=json-ish",
    anchor: '"tests":2000,"failures":0',
    exitCode: 0,
    tailImportant: true,
    text: jsonSummary(),
  },
  {
    id: "versionList",
    label: "3000 near-identical numbered lines",
    simulates: "installer listing versions",
    anchor: "[VER_ANCHOR]",
    exitCode: 0,
    tailImportant: true,
    repetitive: true,
    text: versionList(),
  },
];

export function getDatasets(): Dataset[] {
  return datasets.map((d) => ({ ...d, text: d.text }));
}

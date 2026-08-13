/**
 * Matrix runner v2: every policy x every dataset.
 * Emits a compact table to stdout and full results to results.json.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatasets } from "./datasets";
import { applyPolicy, type OutputPolicy, PI_BASELINE } from "./policies";

const LIMITS: Array<{ maxLines: number; maxBytes: number; label: string }> = [
  { maxLines: 2000, maxBytes: 50 * 1024, label: "L2000/50K" },
  { maxLines: 500, maxBytes: 16 * 1024, label: "L500/16K" },
  { maxLines: 200, maxBytes: 8 * 1024, label: "L200/8K" },
  { maxLines: 100, maxBytes: 4 * 1024, label: "L100/4K" },
  { maxLines: 50, maxBytes: 2 * 1024, label: "L50/2K" },
];

type BasePolicy = Omit<OutputPolicy, "name">;

const CLEAN_BASE: BasePolicy = {
  strategy: "headTail",
  maxLines: 80,
  maxBytes: 3 * 1024,
  headLines: 30,
  tailLines: 40,
  sampleCount: 20,
  filter: "none",
  compressRepeats: false,
  collapseSimilar: false,
  keepImportant: false,
  patterns: [],
  tailOnError: false,
  alwaysMarker: true,
};

function makePolicies(): OutputPolicy[] {
  const out: OutputPolicy[] = [];

  // Baseline (exact pi defaults).
  out.push({ ...PI_BASELINE });

  // Pure strategies at a tight budget, no filters.
  const tight: BasePolicy = {
    ...CLEAN_BASE,
    strategy: "tail", // replaced below
    maxBytes: 4 * 1024,
    headLines: 30,
    tailLines: 30,
    maxLines: 60,
  };
  for (const strategy of ["tail", "head", "headTail", "summary"] as const) {
    out.push({ ...tight, strategy, name: `strat-${strategy}-4k` });
  }

  // Strategy families at the recommended budget with all filters.
  for (const strategy of ["headTail", "sample", "tail"] as const) {
    out.push({
      ...CLEAN_BASE,
      strategy,
      filter: "ansiNoise",
      compressRepeats: true,
      collapseSimilar: true,
      keepImportant: true,
      tailOnError: true,
      name: `clean-${strategy}-3k`,
    });
  }

  // Ablation: each piece alone on top of clean-headTail.
  const base = { ...CLEAN_BASE, filter: "ansiNoise" as const, name: "" };
  out.push({ ...base, name: "ht-3k-ansiNoise" });
  out.push({ ...base, compressRepeats: true, name: "ht-3k-ansiNoise-compress" });
  out.push({ ...base, compressRepeats: true, collapseSimilar: true, name: "ht-3k-ansiNoise-compress-similar" });
  out.push({ ...base, compressRepeats: true, collapseSimilar: true, keepImportant: true, name: "ht-3k-full" });
  out.push({ ...base, compressRepeats: true, collapseSimilar: true, keepImportant: true, tailOnError: true, name: "ht-3k-full-tailOnErr" });

  // Pattern-driven extraction: model passes regexes to keep target lines.
  out.push({
    ...CLEAN_BASE,
    filter: "ansiNoise",
    compressRepeats: true,
    collapseSimilar: true,
    keepImportant: true,
    tailOnError: true,
    patterns: [/MASTER_ANCHOR_7f3/, /TARGET_FILE_scan_trigger\.ts/],
    name: "ht-3k-patterns",
  });
  // head-tail WITHOUT patterns (shows the extraction gap).
  out.push({
    ...CLEAN_BASE,
    filter: "ansiNoise",
    compressRepeats: true,
    collapseSimilar: true,
    keepImportant: true,
    tailOnError: true,
    name: "ht-3k-full-tailOnErr2",
  });

  // Large-budget head+tail for comparison.
  out.push({ ...CLEAN_BASE, maxBytes: 8 * 1024, maxLines: 200, headLines: 80, tailLines: 80, filter: "ansiNoise", compressRepeats: true, collapseSimilar: true, keepImportant: true, name: "ht-8k" });
  out.push({ ...CLEAN_BASE, maxBytes: 16 * 1024, maxLines: 400, headLines: 200, tailLines: 200, filter: "ansiNoise", compressRepeats: true, collapseSimilar: true, keepImportant: true, name: "ht-16k" });

  // Byte-only differences on the clean headTail shape.
  for (const bytes of [1024, 2048, 4096]) {
    out.push({
      ...CLEAN_BASE,
      strategy: "headTail",
      maxBytes: bytes,
      filter: "ansiNoise",
      compressRepeats: true,
      collapseSimilar: true,
      keepImportant: true,
      tailOnError: true,
      name: `ht-${Math.round(bytes / 1024)}k`,
    });
  }

  return out;
}

type Row = {
  policy: string;
  dataset: string;
  anchor: boolean;
  anchor2: boolean;
  inputBytes: number;
  contextBytes: number;
  shownLines: number;
  totalLines: number;
  elided: number;
  sampled: number;
  reduced: number;
  truncated: boolean;
};

export async function runBench(): Promise<Row[]> {
  const policies = makePolicies();
  const datasets = getDatasets();
  const rows: Row[] = [];

  for (const policy of policies) {
    for (const ds of datasets) {
      const res = applyPolicy(ds.text, policy, {
        exitCode: ds.exitCode,
        path: "tmp/pum-bash-xxxx.log",
      });
      const anchorOk = res.content.includes(ds.anchor);
      const anchor2Ok = ds.anchor2 ? res.content.includes(ds.anchor2) : true;
      rows.push({
        policy: policy.name,
        dataset: ds.id,
        anchor: anchorOk,
        anchor2: anchor2Ok,
        inputBytes: Buffer.byteLength(ds.text, "utf8"),
        contextBytes: res.contextBytes,
        shownLines: res.shownLines,
        totalLines: res.totalLines,
        elided: res.elided,
        sampled: res.sampled,
        reduced: ds.text.length / Math.max(1, res.contextBytes),
        truncated: res.truncated,
      });
    }
  }
  return rows;
}

function summary(rows: Row[]): string {
  const policyNames = [...new Set(rows.map((r) => r.policy))];
  const out: string[] = [];
  const totals: Array<{ name: string; bytes: number; pass: number; avgRed: number }> = [];
  for (const p of policyNames) {
    const pr = rows.filter((r) => r.policy === p);
    totals.push({
      name: p,
      bytes: pr.reduce((s, r) => s + r.contextBytes, 0),
      pass: pr.filter((r) => r.anchor && r.anchor2).length,
      avgRed: pr.reduce((s, r) => s + r.reduced, 0) / pr.length,
    });
  }
  totals.sort((a, b) => a.bytes - b.bytes);
  for (const t of totals) {
    out.push(`| ${t.name} | ${t.bytes} | ${t.pass}/${rows.length / policyNames.length} | ${t.avgRed.toFixed(1)}x |`);
  }
  return out.join("\n");
}

export function writeResults(rows: Row[], outDir: string): void {
  const policies = [...new Set(rows.map((r) => r.policy))];
  const agg = policies.map((name) => {
    const pr = rows.filter((r) => r.policy === name);
    return {
      policy: name,
      totalContextBytes: pr.reduce((s, r) => s + r.contextBytes, 0),
      anchorPassAll: pr.filter((r) => r.anchor && r.anchor2).length,
      anchorPassAny: pr.filter((r) => r.anchor).length,
      avgReduction: pr.reduce((s, r) => s + r.reduced, 0) / pr.length,
      perDataset: Object.fromEntries(pr.map((r) => [r.dataset, r])),
    };
  });
  agg.sort((a, b) => a.totalContextBytes - b.totalContextBytes);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(agg, null, 2));
}

async function main(): Promise<void> {
  const rows = await runBench();
  console.log("# policy | totalBytes | anchorsKept | avgReduction");
  console.log("|---|---|---|---|");
  console.log(summary(rows));
  writeResults(rows, import.meta.dir);
  const misses = rows.filter((r) => !(r.anchor && r.anchor2));
  const byPolicy = new Map<string, string[]>();
  for (const m of misses) {
    if (!byPolicy.has(m.policy)) byPolicy.set(m.policy, []);
    byPolicy.get(m.policy)!.push(m.dataset);
  }
  console.log("\n## anchor misses by policy");
  for (const [p, ds] of byPolicy) {
    console.log(`${p}: ${ds.join(", ")}`);
  }
}

if (import.meta.main) {
  await main();
}

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const GUIDANCE = "docs/agent-guidance";
const BASELINE = {
  commit: "c986de2",
  path: "AGENTS.md",
  bytes: 98852,
  lines: 1309,
  sha256: "2bef72c47f58a1d57bf79bb7001a83515fb64e0e9eb2cec8c3e2950ee76ce98a",
};
const OTHER_IDS = ["intro", "layout", "keys", "locked-preamble", "bites-preamble", "testing"];
type Unit = {
  id: string;
  section: string;
  ordinal?: number;
  heading: string;
  sourceStartLine: number;
  sourceEndLine: number;
  originalSha256: string;
  target: string;
  disposition: "preserved" | "clarified";
  normalizedSha256: string;
  note?: string;
  evidence?: string[];
};
type Manifest = { version: number; baseline: typeof BASELINE; units: Unit[] };

const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const manifest = (): Manifest => JSON.parse(read(`${GUIDANCE}/migration.json`));
const digest = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const markdownFiles = () => [
  "AGENTS.md", "README.md", "docs/appearance.md", "docs/cli.md", "docs/mcp.md",
  "docs/security.md", "docs/tools.md", "research/bash-output/RESEARCH.md",
  "research/bench-pi-vs-pum/README.md", "research/context-window/README.md",
  ...readdirSync(resolve(ROOT, GUIDANCE))
  .filter((name) => name.endsWith(".md")).map((name) => `${GUIDANCE}/${name}`)];

function insideRepository(path: string): string {
  const absolute = resolve(ROOT, path);
  const rel = relative(ROOT, absolute);
  expect(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`), path).toBe(false);
  expect(existsSync(absolute), path).toBe(true);
  const canonical = relative(realpathSync(ROOT), realpathSync(absolute));
  expect(isAbsolute(canonical) || canonical === ".." || canonical.startsWith(`..${sep}`), path).toBe(false);
  return absolute;
}

function withoutFences(text: string): string {
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) { fence = marker; return ""; }
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return "";
    }
    return line;
  }).join("\n");
}

function anchors(text: string): Set<string> {
  const result = new Set<string>();
  const seen = new Map<string, number>();
  const visible = withoutFences(text);
  for (const match of visible.matchAll(/<(?:a|[a-z][\w-]*)\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) result.add(match[1]!);
  for (const match of visible.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1]!.replace(/<[^>]*>/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}

/** Inline destinations, reference definitions, and HTML hrefs (URL autolinks are external). */
function links(text: string): string[] {
  const visible = withoutFences(text).replace(/(`+)[^\n]*?\1/g, "");
  const destinations: string[] = [];
  for (const match of visible.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)]*(?:\([^\s)]*\)[^\s)]*)*))(?:\s+["'][^\n]*?["'])?\s*\)/g)) destinations.push(match[1] ?? match[2]!);
  for (const match of visible.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) destinations.push(match[1] ?? match[2]!);
  for (const match of visible.matchAll(/\bhref=["']([^"']+)["']/g)) destinations.push(match[1]!);
  return destinations;
}

function resolveLink(from: string, destination: string): { path: string; fragment: string } | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) return undefined;
  const hash = destination.indexOf("#");
  const fragment = hash < 0 ? "" : decodeURIComponent(destination.slice(hash + 1));
  const pathPart = (hash < 0 ? destination : destination.slice(0, hash)).split("?")[0]!;
  const decoded = decodeURIComponent(pathPart).replace(/\\([()])/g, "$1");
  const path = decoded ? relative(ROOT, resolve(ROOT, dirname(from), decoded)) : from;
  const absolute = insideRepository(path);
  if (fragment) {
    expect(statSync(absolute).isFile(), `${from}: ${destination}`).toBe(true);
    expect(anchors(read(path)).has(fragment), `${from}: missing #${fragment} in ${path}`).toBe(true);
  }
  return { path, fragment };
}

describe("agent guidance migration", () => {
  test("pins the original baseline and maps every source unit exactly once", () => {
    const { version, baseline, units } = manifest();
    expect(version).toBe(1);
    expect(baseline).toEqual(BASELINE);
    expect(units).toHaveLength(157);
    expect(new Set(units.map((unit) => unit.id)).size).toBe(units.length);
    expect(new Set(units.map((unit) => unit.target)).size).toBe(units.length);
    for (const [prefix, count] of [["ld", 124], ["bite", 27]] as const) {
      const group = units.filter((unit) => unit.id.startsWith(`${prefix}-`));
      expect(group).toHaveLength(count);
      for (let ordinal = 1; ordinal <= count; ordinal++) {
        const unit = group.find((candidate) => candidate.id === `${prefix}-${String(ordinal).padStart(3, "0")}`);
        expect(unit, `${prefix} ordinal ${ordinal}`).toBeDefined();
        expect(unit!.ordinal).toBe(ordinal);
      }
    }
    for (const id of OTHER_IDS) expect(units.some((unit) => unit.id === id), id).toBe(true);
    const ordered = [...units].sort((a, b) => a.sourceStartLine - b.sourceStartLine);
    let nextLine = 1;
    for (const unit of ordered) {
      expect(Number.isInteger(unit.sourceStartLine), unit.id).toBe(true);
      expect(Number.isInteger(unit.sourceEndLine), unit.id).toBe(true);
      expect(unit.sourceStartLine, `${unit.id}: missing or overlapping source lines`).toBe(nextLine);
      expect(unit.sourceEndLine, unit.id).toBeGreaterThanOrEqual(unit.sourceStartLine);
      expect(unit.sourceEndLine, unit.id).toBeLessThanOrEqual(BASELINE.lines);
      nextLine = unit.sourceEndLine + 1;
    }
    expect(nextLine).toBe(BASELINE.lines + 1);
  });

  test("every target retains its normalized unit content or records an evidenced clarification", () => {
    for (const unit of manifest().units) {
      expect(unit.section.trim().length, unit.id).toBeGreaterThan(0);
      expect(unit.heading.trim().length, unit.id).toBeGreaterThan(0);
      expect(unit.originalSha256, unit.id).toMatch(/^[a-f\d]{64}$/);
      expect(unit.normalizedSha256, unit.id).toMatch(/^[a-f\d]{64}$/);
      expect(unit.target, unit.id).toMatch(/^docs\/agent-guidance\/[^#]+\.md#[\w-]+$/);
      const target = resolveLink("AGENTS.md", unit.target)!;
      expect(target.fragment, unit.id).toBe(unit.id);
      const text = read(target.path);
      const start = `<a id="${unit.id}"></a>`;
      const end = `<!-- end:${unit.id} -->`;
      expect(occurrences(text, start), unit.id).toBe(1);
      expect(occurrences(text, end), unit.id).toBe(1);
      const startIndex = text.indexOf(start) + start.length;
      const endIndex = text.indexOf(end);
      expect(endIndex, unit.id).toBeGreaterThan(startIndex);
      const content = text.slice(startIndex, endIndex);
      expect(content, `${unit.id}: nested migration unit`).not.toMatch(/<!-- end:[\w-]+ -->|<a id="(?:ld-|bite-)/);
      expect(digest(content), unit.id).toBe(unit.normalizedSha256);
      expect(["preserved", "clarified"], unit.id).toContain(unit.disposition);
      if (unit.disposition === "preserved") {
        expect(unit.normalizedSha256, unit.id).toBe(unit.originalSha256);
      } else {
        expect(typeof unit.note, unit.id).toBe("string");
        expect(unit.note!.trim().length, unit.id).toBeGreaterThan(0);
        expect(Array.isArray(unit.evidence), unit.id).toBe(true);
        expect(unit.evidence!.length, unit.id).toBeGreaterThan(0);
        for (const evidence of unit.evidence!) {
          expect(evidence, unit.id).not.toMatch(/^(?:[a-z][a-z\d+.-]*:|\/)/i);
          expect(statSync(insideRepository(evidence)).isFile(), `${unit.id}: ${evidence}`).toBe(true);
        }
      }
    }
  });

  test("all local Markdown links and fragments resolve, including the migration index", () => {
    const files = markdownFiles();
    expect(files).toContain(`${GUIDANCE}/README.md`);
    for (const path of files) for (const destination of links(read(path))) resolveLink(path, destination);
    const indexTargets = new Set(links(read(`${GUIDANCE}/README.md`))
      .map((destination) => resolveLink(`${GUIDANCE}/README.md`, destination))
      .filter((target) => target !== undefined).map((target) => `${target!.path}#${target!.fragment}`));
    for (const unit of manifest().units) expect(indexTargets.has(unit.target), `${unit.id}: absent from migration index`).toBe(true);
  });

  test("the layout source map names existing repository files", () => {
    const layout = manifest().units.find((unit) => unit.id === "layout")!;
    const content = read(layout.target.split("#")[0]!);
    const paths = [...content.matchAll(/`(src\/[^`\n]+)`/g)].map((match) => match[1]!);
    expect(paths.length, "layout must retain a substantive source map").toBeGreaterThan(50);
    for (const path of paths) expect(statSync(insideRepository(path)).isFile(), path).toBe(true);
  });

  test("usage docs retain corrected tool, output, security, and historical scope", () => {
    // Literal supported inventory avoids importing the side-effectful headless boot module.
    // src/headless.ts HEADLESS_TOOL_NAMES composes these coding, memory, and context tools.
    const cli = read("docs/cli.md");
    for (const tool of ["read", "write", "edit", "bash", "memory_read", "memory_edit", "history", "get_context_remaining", "new_context"]) {
      expect(cli, `headless tool ${tool}`).toContain(`\`${tool}\``);
    }
    const tools = read("docs/tools.md").replace(/\s+/g, " ");
    expect(tools).toMatch(/mutable.{0,30}(?:main|worker)/i);
    expect(tools).toMatch(/readonly.{0,50}(?:omit|restrict|denied)/i);
    expect(tools).toMatch(/headless.{0,100}no interactive/i);
    expect(tools).toMatch(/main[- ]TUI[- ]only.{0,40}MCP.{0,20}LSP/i);
    expect(tools).toMatch(/never grants.{0,30}consent/i);
    const appearance = read("docs/appearance.md").replace(/\s+/g, " ");
    expect(appearance).toMatch(/quiet.{0,40}(?:every|all) settled/i);
    expect(appearance).toMatch(/quiet.{0,120}failed/i);
    const security = read("docs/security.md").replace(/\s+/g, " ");
    expect(security).toMatch(/mutable model Bash\/managed shells.{0,100}off/i);
    expect(security).toMatch(/readonly.{0,70}require.{0,30}native/i);
    expect(security).toMatch(/MCP\/LSP.{0,60}mandatory native/i);
    for (const path of ["research/context-window/README.md", "research/bash-output/RESEARCH.md", "research/bench-pi-vs-pum/README.md"]) {
      expect(read(path).split("\n").slice(0, 8).join(" "), path).toMatch(/historical.{0,100}not current|historical.{0,100}not a current/i);
    }
  });

  test("Check-Off native bypass distinguishes model tools from direct-user Bash", () => {
    // Documentation consistency guard; behavioral coverage lives in tests/sandbox/index.test.ts.
    for (const path of ["AGENTS.md", `${GUIDANCE}/security.md`, "docs/security.md"]) {
      const text = read(path).replace(/\*/g, "").replace(/\s+/g, " ");
      expect(text, path).toMatch(/mutable model Bash\/managed shells.{0,100}Check(?: mode)? Off/i);
      expect(text, path).toMatch(/Direct-user `!` Bash retains Sandbox Auto\/Require even Check Off/i);
      expect(text, path).not.toMatch(/(?:ordinary mutable Bash\/shell runtimes|Mutable Check Off\/Sandbox Off)/i);
    }
    const tui = read(`${GUIDANCE}/tui.md`).replace(/\s+/g, " ");
    expect(tui).toMatch(/Check mode does not inspect user commands but the configured native sandbox still applies/);
  });

  test("the root stays compact while retaining safety, lifecycle, and topic routing", () => {
    const root = read("AGENTS.md");
    const bytes = Buffer.byteLength(root, "utf8");
    expect(bytes).toBeLessThanOrEqual(20 * 1024);
    expect(bytes).toBeLessThanOrEqual(BASELINE.bytes * 0.25);
    expect(root.trimEnd().split("\n").length).toBeLessThanOrEqual(260);
    // Semantic checks deliberately allow rewriting and reordering the root.
    const plain = root.replace(/\s+/g, " ");
    for (const [label, pattern] of [
      ["security boundary", /check mode|sandbox/i],
      ["credential boundary", /credential|secret|auth\.json/i],
      ["direct-user consent", /direct[- ]user|explicit.{0,40}(?:user|consent|approv)/i],
      ["subagent completion", /finish_subagent/],
      ["descendant closure", /descendant|deepest[- ]first|recursive.{0,30}clos/i],
      ["no polling", /(?:never|no|not|avoid|do not).{0,60}poll/i],
      ["settlement lifecycle", /agent_settled/],
      ["validation", /test|typecheck/i],
    ] as const) expect(plain, label).toMatch(pattern);
    const routed = new Set(links(root).map((destination) => resolveLink("AGENTS.md", destination))
      .filter((target) => target?.path.startsWith(`${GUIDANCE}/`) && target.path.endsWith(".md"))
      .map((target) => target!.path));
    expect(routed.size, "root must route directly to substantive topic guidance").toBeGreaterThanOrEqual(6);
    const targets = new Set(manifest().units.map((unit) => unit.target.split("#")[0]!));
    for (const path of targets) expect(routed.has(path), `root route missing: ${path}`).toBe(true);
  });
});

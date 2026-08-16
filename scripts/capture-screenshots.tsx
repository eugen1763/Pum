import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { normalizeSettings } from "../src/settings";
import { saveGoal, createGoal } from "../src/goal";

/**
 * Regenerate the README screenshots.
 *
 * `bun run scripts/capture-screenshots.tsx`
 *
 * These are real OpenTUI renders, not mockups: the script drives the actual App
 * with a fake session whose entries are replayed exactly as a resumed session
 * would be, then converts the captured cell grid to SVG. A screenshot can
 * therefore never show a layout the renderer would not produce, and a rendering
 * change is one command away from a refreshed image.
 */

const FONT_SIZE = 14;
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 19;
const PADDING = 14;
const CHROME_HEIGHT = 34;
const CROPPED_SCROLLBAR_COLUMNS = 1;

type Capture = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>;

const temporaryDirectories: string[] = [];

function temporaryCaptureFiles(): { project: string; sessionFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "pum-shot-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "pum");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  return { project, sessionFile: join(directory, "session.jsonl") };
}

const hex = (color: { r: number; g: number; b: number }): string => {
  const byte = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
};

const escapeXml = (text: string): string => text
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

/** A cell the renderer left empty comes back as a null glyph, not a space. */
const printable = (text: string): string =>
  [...text].map((character) => (character.codePointAt(0) ?? 0) < 32 || character === "਀"
    ? " "
    : character).join("");

type Cell = { char: string; fg: string; bg: string };

/**
 * Flatten one captured line into cells.
 *
 * Spans carry their own width, and trusting it drifts by a column on some
 * glyphs, which is enough for the next span's background to paint over the last
 * character of this one. A monospace grid has one truth — the glyphs — so count
 * those and let the runs fall out.
 */
function cellsOf(line: { spans: readonly any[] }): Cell[] {
  const cells: Cell[] = [];
  for (const span of line.spans) {
    const fg = hex(span.fg);
    const bg = hex(span.bg);
    for (const char of printable(span.text)) cells.push({ char, fg, bg });
  }
  return cells;
}

/** Consecutive cells that agree on `key`, so the SVG carries runs, not cells. */
function runs(cells: readonly Cell[], key: "fg" | "bg"): Array<{ start: number; cells: Cell[] }> {
  const grouped: Array<{ start: number; cells: Cell[] }> = [];
  cells.forEach((cell, index) => {
    const last = grouped.at(-1);
    if (last && last.cells[0]![key] === cell[key] && last.start + last.cells.length === index) {
      last.cells.push(cell);
      return;
    }
    grouped.push({ start: index, cells: [cell] });
  });
  return grouped;
}

function toSvg(capture: Capture, title: string, description: string): string {
  // The live TUI keeps its scrollbar visible to prevent layout reflow. The
  // README captures omit that final terminal column because the static image
  // has no scrolling interaction.
  const columns = Math.max(0, capture.cols - CROPPED_SCROLLBAR_COLUMNS);
  const width = Math.round(columns * CELL_WIDTH + PADDING * 2);
  const height = Math.round(capture.rows * CELL_HEIGHT + PADDING * 2 + CHROME_HEIGHT);
  const grid = capture.lines.map((line) => cellsOf(line as any).slice(0, columns));
  const background = grid[0]?.[0]?.bg ?? "#11131d";

  const chrome: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
      + `viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<desc id="desc">${escapeXml(description)}</desc>`,
    `<rect width="100%" height="100%" rx="12" fill="${background}"/>`,
    `<circle cx="20" cy="18" r="5" fill="#f7768e"/>`,
    `<circle cx="38" cy="18" r="5" fill="#e0af68"/>`,
    `<circle cx="56" cy="18" r="5" fill="#9ece6a"/>`,
  ];

  // Every background first, then every glyph: a rect can then never cover the
  // text of the cell before it.
  const backgrounds: string[] = [];
  const glyphs: string[] = [];
  grid.forEach((cells, row) => {
    const y = PADDING + CHROME_HEIGHT + row * CELL_HEIGHT;
    for (const run of runs(cells, "bg")) {
      if (run.cells[0]!.bg === background) continue;
      backgrounds.push(
        `<rect x="${(PADDING + run.start * CELL_WIDTH).toFixed(1)}" `
          + `y="${(y - CELL_HEIGHT + 5).toFixed(1)}" `
          + `width="${(run.cells.length * CELL_WIDTH).toFixed(1)}" height="${CELL_HEIGHT}" `
          + `fill="${run.cells[0]!.bg}"/>`,
      );
    }
    for (const run of runs(cells, "fg")) {
      const text = run.cells.map((cell) => cell.char).join("");
      if (!text.trim()) continue;
      // Give every glyph its terminal-cell x coordinate. Browser font metrics
      // can then differ slightly without stretching the glyph shapes or moving
      // later cells out of alignment.
      const positions = run.cells.map((_, index) =>
        (PADDING + (run.start + index) * CELL_WIDTH).toFixed(1)).join(" ");
      glyphs.push(
        `<text x="${positions}" y="${y.toFixed(1)}" `
          + `fill="${run.cells[0]!.fg}">${escapeXml(text)}</text>`,
      );
    }
  });

  return [
    ...chrome,
    ...backgrounds,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" `
      + `font-size="${FONT_SIZE}" xml:space="preserve">`,
    ...glyphs,
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}

const patch = [
  "*** Begin Patch",
  "*** Update File: src/theme.ts",
  "@@",
  '-  accent: "#7aa2f7",',
  '+  accent: "#89b4fa",',
  "*** End Patch",
].join("\n");

/** A believable session: a question, some work, and an answer. */
const entries = [
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "Make the accent colour match the new palette and check the tests." }] },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the theme and its tests first." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/theme.ts", offset: 40, limit: 60 } },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "export const PRESETS = { tokyonight: { accent: \"#7aa2f7\" } };" }],
      details: { lines: 60 },
      isError: false,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/theme.test.ts" } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read",
      content: [{ type: "text", text: "describe(\"presets\", () => { ... })" }],
      details: { lines: 24 },
      isError: false,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c3", name: "apply_patch", arguments: { patch } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c3",
      toolName: "apply_patch",
      content: [{ type: "text", text: "Applied patch to src/theme.ts" }],
      details: { patch },
      isError: false,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "bun test src/theme.test.ts" } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c4",
      toolName: "bash",
      content: [{ type: "text", text: " 14 pass\n 0 fail\nRan 14 tests across 1 file. [212.00ms]" }],
      details: { exitCode: 0 },
      isError: false,
    },
  },
  {
    type: "custom_message",
    customType: "pum.agent_message",
    content: "palette check",
    details: {
      id: "m1",
      sender: "palette-check",
      recipient: "main",
      text: "Checked the other eight presets: only tokyonight used the old accent.",
      at: 1,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: "## Done\n\nThe accent is now `#89b4fa`, and the preset tests pass.\n\n- `src/theme.ts` — one token changed\n- `src/theme.test.ts` — unchanged, 14 pass",
      }],
    },
  },
];

function fakeSession(sessionFile: string) {
  return {
    agent: {
      state: {
        model: { id: "gpt-5-codex", provider: "openai-codex", input: ["text"], contextWindow: 200_000 },
        thinkingLevel: "medium",
      },
    },
    sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
    sessionFile,
    sessionId: "screenshot-session",
    subscribe: () => () => {},
    setThinkingLevel() {},
    setModel: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    compact: async () => ({ tokensBefore: 0 }),
    prompt: async () => {},
    steer: async () => {},
  } as any;
}

async function capture(options: {
  width: number;
  height: number;
  goal?: string;
  popup?: "settings" | "help";
}): Promise<Capture> {
  const { project, sessionFile } = temporaryCaptureFiles();
  if (options.goal) saveGoal(sessionFile, createGoal(options.goal, 10));
  const setup = await createTestRenderer({
    width: options.width,
    height: options.height,
    kittyKeyboard: true,
  });
  const session = fakeSession(sessionFile);
  createRoot(setup.renderer).render(
    <App
      session={session}
      modelRuntime={{ getAvailableSnapshot: () => [], getProviders: () => [] } as any}
      onNewSession={async () => session}
      loadSessions={async () => []}
      onSwitchSession={async () => session}
      settings={normalizeSettings({ theme: "tokyonight", animations: false, workingRuleAnimation: "off" })}
      initialCwd={project}
      searchProviders={[]}
      subagentManager={{
        getAgents: () => [],
        subscribe: () => () => {},
        bindMainSession: async () => {},
        setMaxActiveSubagents() {},
      } as any}
      promptHistoryStore={{ load: () => [], append: () => [], remove: () => [] }}
      promptStashStore={{
        load: () => [],
        append: () => [],
        markExecuted: () => [],
        markExecutedMany: () => [],
        replace: () => [],
        remove: () => [],
      }}
    />,
  );

  // Settle, then give the asynchronous syntax highlighting time to land before
  // the capture: a screenshot taken too early shows plain-text code.
  for (let pass = 0; pass < 4; pass += 1) {
    await setup.renderOnce();
    await setup.flush();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (options.popup) {
    if (options.popup === "settings") setup.mockInput.pressKey("p", { ctrl: true });
    else setup.mockInput.pressKey("?");
    for (let pass = 0; pass < 3; pass += 1) {
      await setup.renderOnce();
      await setup.flush();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  await setup.renderOnce();
  if (process.env.PUM_SHOT_DEBUG) console.log(setup.captureCharFrame());
  const captured = setup.captureSpans();
  setup.renderer.destroy();
  return captured;
}

const transcript = await capture({
  width: 104,
  height: 29,
  goal: "Bring the theme presets in line with the new palette",
});
writeFileSync(
  "docs/images/pum-transcript.svg",
  toSvg(
    transcript,
    "PUM transcript with a patch diff, grouped reads, and an active goal",
    "A real OpenTUI render of PUM: a user prompt, grouped file reads, a syntax-highlighted patch diff, a Bash run, and the goal label on the rule above the prompt.",
  ),
);

const settings = await capture({ width: 104, height: 34, popup: "settings" });
writeFileSync(
  "docs/images/pum-settings.svg",
  toSvg(
    settings,
    "PUM settings panel",
    "A real OpenTUI render of PUM's settings panel, showing appearance, agent, and safety settings.",
  ),
);

const controls = await capture({ width: 128, height: 38, popup: "help" });
writeFileSync(
  "docs/images/pum-controls.svg",
  toSvg(
    controls,
    "PUM controls panel",
    "A real OpenTUI render of PUM's controls panel, showing prompt, agent, session, command, and application shortcuts.",
  ),
);

for (const directory of temporaryDirectories) {
  rmSync(directory, { recursive: true, force: true });
}
console.log("wrote docs/images/pum-transcript.svg, docs/images/pum-settings.svg, and docs/images/pum-controls.svg");

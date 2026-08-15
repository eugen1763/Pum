/**
 * Test preload. Bun runs this before any test module is imported, which is the
 * only point early enough to redirect PUM's agent directory: `src/config.ts`
 * reads `PUM_DIR` at module load, and `src/prompt-stash.ts` builds its store
 * from that constant, so a test that imports either one has already bound the
 * real directory by the time its own setup runs.
 *
 * Without this, UI tests write prompts into the developer's own
 * `~/.config/pum/history.json`.
 *
 * This file lives outside `src/` on purpose: package.json only publishes
 * `src/**`, so it can never reach the npm package.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PUM_DIR) {
  const directory = mkdtempSync(join(tmpdir(), "pum-test-home-"));
  process.env.PUM_DIR = directory;
  const remove = () => rmSync(directory, { recursive: true, force: true });
  // A preload hook applies to every test file, and it runs where an exit
  // listener alone does not.
  afterAll(remove);
  process.on("exit", remove);
}

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real headless startup against a local mock provider. No real credentials/model
// or language server; even a valid repository proposal remains wholly inert.
test("headless startup ignores LSP proposal and exposes no LSP capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "pum-lsp-headless-"));
  const cwd = join(root, "project"), config = join(root, "agent"), marker = join(cwd, "server-started");
  mkdirSync(join(cwd, ".pum"), { recursive: true }); mkdirSync(config);
  const script = join(cwd, "fake-server.js");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected");`);
  writeFileSync(join(cwd, ".pum/lsp.json"), JSON.stringify({ version: 1, executable: process.execPath, args: [script] }));
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (!request.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    requests.push(await request.json());
    const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "lsp-headless", object: "chat.completion.chunk", created: 1,
      model: "mock", choices: [{ index: 0, delta, finish_reason }] });
    return new Response([
      chunk({ role: "assistant", content: "Headless has no LSP integration." }, null), chunk({}, "stop"),
    ].map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "mock", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 2000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    writeFileSync(join(config, "auth.json"), "{}");
    writeFileSync(join(config, "pum.json"), JSON.stringify({ checkMode: "off", sandboxMode: "off", webSearch: false }));
    const running = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/index.tsx"), "-p", "Describe available LSP integration; do not execute tools."], {
      cwd, env: { ...process.env, PUM_DIR: config }, stdout: "pipe", stderr: "pipe",
    });
    child = running;
    timer = setTimeout(() => child?.kill(), 20000);
    const [stdout, stderr, exit] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited]);
    expect(exit).toBe(0); expect(stdout).toContain("Headless has no LSP");
    expect(stderr).not.toContain("lsp_diagnostics"); expect(requests).toHaveLength(1);
    const names = requests[0].tools.map((tool: any) => tool.function?.name);
    expect(names).not.toContain("lsp_diagnostics"); expect(names).not.toContain("enable_tools");
    expect(existsSync(marker)).toBe(false);
  } finally { clearTimeout(timer); child?.kill(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 25000);

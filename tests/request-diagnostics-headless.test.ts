import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("headless opt-in emits safe JSON only on stderr before diagnostics teardown", async () => {
  const root = mkdtempSync(join(tmpdir(), "pum-headless-diagnostics-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: "raw-provider-response-id", object: "chat.completion.chunk", created: 1, model: "mock-model",
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response([
        chunk({ role: "assistant", content: "Diagnostics fixture answer." }, null),
        { ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fixture-key-not-a-secret",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "mock-model", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 2000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "pum.json"), JSON.stringify({ checkMode: "off", sandboxMode: "off", webSearch: false }));
    const outputs: string[] = [];
    for (const enabled of ["0", "1"]) {
      const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/index.tsx"), "-p", "Raw diagnostic fixture prompt sentinel."], {
        cwd, env: { ...process.env, PUM_DIR: agentDir, PUM_REQUEST_DIAGNOSTICS: enabled }, stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 20_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(code).toBe(0);
        outputs.push(stdout);
        const reports = stderr.split("\n").filter((line) => line.startsWith("{"));
        expect(reports).toHaveLength(enabled === "1" ? 1 : 0);
        if (enabled === "1") {
          const report = JSON.parse(reports[0]!);
          expect(report.requests.length).toBeGreaterThan(0);
          expect(reports[0]).not.toContain("Raw diagnostic fixture prompt sentinel");
          expect(reports[0]).not.toContain("raw-provider-response-id");
          expect(reports[0]).not.toContain("fixture-key-not-a-secret");
        }
      } finally { clearTimeout(timeout); }
    }
    expect(outputs[0]).toBe("Diagnostics fixture answer.\n");
    expect(outputs[1]).toBe(outputs[0]);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

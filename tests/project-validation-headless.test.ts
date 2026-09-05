import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function response(delta: Record<string, unknown>, reason: string): Response {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => ({
    id: "validation-headless", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
  });
  return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, reason))}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("headless automatic validation end to end", () => {
  for (const scenario of ["disabled", "passed", "failed", "wrong-digest"] as const) {
    test(`${scenario}: real CLI, isolated config, local provider and registered PUM Bash`, async () => {
      const root = mkdtempSync(join(tmpdir(), "pum-validation-headless-"));
      const cwd = join(root, "project");
      const agentDir = join(root, "fixture-state");
      mkdirSync(join(cwd, ".pum"), { recursive: true }); mkdirSync(agentDir);
      const bytes = JSON.stringify({ version: 1, commands: [{ kind: "test",
        command: scenario === "failed" ? "printf HEADLESS_VALIDATION_OUTPUT; exit 7" : "printf HEADLESS_VALIDATION_OUTPUT",
        timeoutSeconds: 2 }], maxRuns: 1 });
      writeFileSync(join(cwd, ".pum", "validation.json"), bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const requests: any[] = [];
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        const body = await request.json() as any; requests.push(body);
        if (!body.messages.some((message: any) => message.role === "tool")) {
          return response({ role: "assistant", tool_calls: [{ index: 0, id: "edit-batch", type: "function", function: {
            name: "write", arguments: JSON.stringify({ path: "source.txt", content: "edited\n" }),
          } }] }, "tool_calls");
        }
        return response({ role: "assistant", content: "HEADLESS_ASSISTANT_DONE" }, "stop");
      } });
      try {
        writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fixture-not-secret",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        } } }));
        writeFileSync(join(agentDir, "auth.json"), "{}");
        writeFileSync(join(agentDir, "pum.json"), JSON.stringify({ checkMode: "off", sandboxMode: "off", webSearch: false }));
        const argv = [process.execPath, "run", resolve(import.meta.dir, "../src/index.tsx"), "-p", "Make the requested edit."];
        if (scenario !== "disabled") argv.push("--validation", scenario === "wrong-digest" ? "0".repeat(64) : digest);
        const child = Bun.spawn(argv, { cwd, env: { ...process.env, PUM_DIR: agentDir }, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => child.kill(), 15_000);
        let stdout: string, stderr: string, code: number;
        try {
          [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        } finally { clearTimeout(timer); }
        if (scenario === "wrong-digest") {
          expect(code).not.toBe(0); expect(requests).toHaveLength(0); expect(stderr).toContain("digest does not match");
        } else {
          expect(requests).toHaveLength(2); expect(stdout).toContain("HEADLESS_ASSISTANT_DONE");
          expect(stdout).not.toContain("HEADLESS_VALIDATION_OUTPUT");
          const serialized = JSON.stringify(requests[1]);
          if (scenario === "disabled") {
            expect(code).toBe(0); expect(stderr).not.toContain("Automatic validation:");
            expect(serialized).not.toContain("HEADLESS_VALIDATION_OUTPUT");
          } else {
            expect(code).toBe(scenario === "failed" ? 1 : 0);
            expect(stderr).toContain(`Automatic validation: ${scenario}`);
            expect(serialized).toContain("HEADLESS_VALIDATION_OUTPUT");
          }
        }
      } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
    }, 20_000);
  }
});

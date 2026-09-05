import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pum-headless-memory-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function completionChunk(delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: "mock-memory",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function streamResponse(chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
    + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolCall(name: string, argumentsJson: string, id: string): Response {
  return streamResponse([
    completionChunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name, arguments: argumentsJson },
      }],
    }, null),
    completionChunk({}, "tool_calls"),
  ]);
}

function textCompletion(text: string): Response {
  return streamResponse([
    completionChunk({ role: "assistant", content: text }, null),
    {
      ...completionChunk({}, "stop"),
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    },
  ]);
}

async function runHeadless(cwd: string, agentDir: string, prompt: string) {
  const entry = resolve(import.meta.dir, "..", "src", "index.tsx");
  const child = Bun.spawn(["bun", "run", entry, "-p", prompt], {
    cwd,
    env: { ...process.env, PUM_DIR: agentDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

describe("headless project memory", () => {
  test("pum -p writes memory in one checkout and reads it from a moved worktree", async () => {
    const root = temporaryRoot();
    const primary = join(root, "primary");
    const moved = join(root, "orca", "workspaces", "Pum", "feature-memory");
    const agentDir = join(root, "agent");
    mkdirSync(primary, { recursive: true });
    mkdirSync(join(root, "orca", "workspaces", "Pum"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    git(primary, "init", "-b", "main");
    writeFileSync(join(primary, "README.md"), "headless memory test\n");
    git(primary, "add", "README.md");
    git(primary, "-c", "user.name=PUM Test", "-c", "user.email=pum@example.invalid", "commit", "-m", "initial");
    git(primary, "worktree", "add", "-b", "feature-memory", moved);

    let phase: "write" | "read" = "write";
    const requests: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (!request.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        const body = await request.json() as { messages?: unknown[] };
        requests.push(body);
        const serialized = JSON.stringify(body);
        const toolResults = body.messages?.filter((message: any) => message?.role === "tool") ?? [];

        if (phase === "write") {
          if (toolResults.length === 0) return toolCall("memory_read", "{}", "memory-read-write");
          if (toolResults.length === 1) {
            const revision = serialized.match(/[a-f0-9]{64}/)?.[0];
            if (!revision) return textCompletion("Missing memory revision.");
            return toolCall("memory_edit", JSON.stringify({
              revision,
              old_text: "",
              new_text: "# Durable facts\n\n- Headless memory probe: linked worktrees share this fact.\n",
            }), "memory-edit-write");
          }
          return textCompletion("Stored headless memory probe.");
        }

        if (toolResults.length === 0) return toolCall("memory_read", "{}", "memory-read-moved");
        return textCompletion(serialized.includes("Headless memory probe")
          ? "Recalled headless memory probe from moved worktree."
          : "Memory probe missing.");
      },
    });

    try {
      writeFileSync(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: "openai-completions",
            apiKey: "test",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [{
              id: "mock-model",
              reasoning: false,
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 2_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }],
          },
        },
      }));
      writeFileSync(join(agentDir, "auth.json"), "{}");
      writeFileSync(join(agentDir, "pum.json"), JSON.stringify({
        checkMode: "off",
        sandboxMode: "off",
        webSearch: false,
      }));

      const writeRun = await runHeadless(primary, agentDir, "Store the durable headless memory probe now.");
      expect(writeRun.exitCode).toBe(0);
      expect(writeRun.stdout).toContain("Stored headless memory probe");
      expect(writeRun.stderr).toContain("memory_read");
      expect(writeRun.stderr).toContain("memory_edit");

      phase = "read";
      const readRun = await runHeadless(moved, agentDir, "Read the project memory from this moved worktree.");
      expect(readRun.exitCode).toBe(0);
      expect(readRun.stdout).toContain("Recalled headless memory probe from moved worktree");
      expect(readRun.stderr).toContain("memory_read");
      expect(readRun.stderr).not.toContain("memory_edit");

      const projects = join(agentDir, "memory", "projects");
      const memoryFiles = readdirSync(projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projects, entry.name, "MEMORY.md"))
        .filter(existsSync);
      expect(memoryFiles).toHaveLength(1);
      expect(readFileSync(memoryFiles[0]!, "utf8")).toContain("Headless memory probe");
      expect(requests.length).toBeGreaterThanOrEqual(5);
      for (const request of requests as Array<{ tools: Array<{ function: { name: string } }> }>) {
        expect(request.tools.map((tool) => tool.function.name).sort()).toEqual([
          "bash", "edit", "get_context_remaining", "history", "memory_edit", "memory_read",
          "new_context", "read", "write",
        ]);
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

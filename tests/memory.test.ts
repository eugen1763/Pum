import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryExtension,
  MEMORY_EDIT_TOOL_NAME,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINES,
  MEMORY_READ_TOOL_NAME,
  ProjectMemoryStore,
  validateMemoryContent,
} from "../src/memory";
import { resolveMemoryIdentity } from "../src/memory-identity";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pum-memory-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function committedRepository(root: string): string {
  const repository = join(root, "primary");
  mkdirSync(repository);
  git(repository, "init");
  writeFileSync(join(repository, "README.md"), "memory test\n");
  git(repository, "add", "README.md");
  git(
    repository,
    "-c", "user.name=PUM Test",
    "-c", "user.email=pum@example.invalid",
    "commit", "-m", "initial",
  );
  return repository;
}

describe("project memory identity", () => {
  test("linked worktrees share one Git identity and memory file", () => {
    const root = temporaryRoot();
    const primary = committedRepository(root);
    const worktree = join(root, "moved", "feature-memory");
    mkdirSync(join(root, "moved"));
    git(primary, "worktree", "add", "-b", "feature-memory-test", worktree);

    expect(resolveMemoryIdentity(primary)).toEqual(resolveMemoryIdentity(worktree));
    const agentDir = join(root, "agent");
    expect(new ProjectMemoryStore(agentDir, primary).file)
      .toBe(new ProjectMemoryStore(agentDir, worktree).file);
  });

  test("non-Git directories keep separate identities", () => {
    const root = temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    expect(resolveMemoryIdentity(first).digest).not.toBe(resolveMemoryIdentity(second).digest);
  });
});

describe("project memory storage", () => {
  test("creates and edits normalized Markdown with revision checks", () => {
    const root = temporaryRoot();
    const project = join(root, "project");
    mkdirSync(project);
    const store = new ProjectMemoryStore(join(root, "agent"), project);
    const empty = store.read();

    const created = store.edit(empty.revision, "", "# Project\r\n\r\n- Use Bun");
    expect(created.content).toBe("# Project\n\n- Use Bun\n");
    expect(store.read()).toEqual(created);

    const edited = store.edit(created.revision, "Use Bun", "Use Bun 1.3 or newer");
    expect(edited.content).toContain("Use Bun 1.3 or newer");
    expect(() => store.edit(created.revision, "Bun", "Node"))
      .toThrow("Project memory changed");
  });

  test("requires one exact section and supports deletion", () => {
    const root = temporaryRoot();
    const project = join(root, "project");
    mkdirSync(project);
    const store = new ProjectMemoryStore(join(root, "agent"), project);
    const created = store.edit(store.read().revision, "", "same\nsame\n");
    expect(() => store.edit(created.revision, "same", "other"))
      .toThrow("old_text occurs more than once");
    const cleared = store.edit(created.revision, "same\nsame\n", "");
    expect(cleared.content).toBe("");
  });

  test("rejects oversized content and credential-like values", () => {
    expect(() => validateMemoryContent(`${"x\n".repeat(MEMORY_MAX_LINES + 1)}`))
      .toThrow(`${MEMORY_MAX_LINES}-line limit`);
    expect(() => validateMemoryContent("x".repeat(MEMORY_MAX_BYTES + 1)))
      .toThrow(`${MEMORY_MAX_BYTES}-byte limit`);
    expect(() => validateMemoryContent("api_key = sk-1234567890abcdefghijklmnop\n"))
      .toThrow("credential-like content");
    expect(validateMemoryContent("The OPENAI_API_KEY environment variable is required.\n").content)
      .toContain("OPENAI_API_KEY");
  });
});

describe("project memory extension", () => {
  function loadExtension(audience: "main" | "subagent", agentDir: string) {
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    (createMemoryExtension({ agentDir, audience }) as any).factory({
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
    });
    return { handlers, tools };
  }

  test("main agents manage memory and subagents only read it", () => {
    const root = temporaryRoot();
    const main = loadExtension("main", join(root, "agent"));
    const child = loadExtension("subagent", join(root, "agent"));
    expect([...main.tools.keys()]).toEqual([MEMORY_READ_TOOL_NAME, MEMORY_EDIT_TOOL_NAME]);
    expect([...child.tools.keys()]).toEqual([MEMORY_READ_TOOL_NAME]);

    const mainPrompt = main.handlers.get("before_agent_start")?.({ systemPrompt: "base" });
    const childPrompt = child.handlers.get("before_agent_start")?.({ systemPrompt: "base" });
    expect(mainPrompt.systemPrompt).toContain("without asking the user for approval");
    expect(childPrompt.systemPrompt).toContain("You cannot change project memory");
  });

  test("injects current memory without adding it to the session transcript", async () => {
    const root = temporaryRoot();
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(project);
    const extension = loadExtension("main", agentDir);
    const readTool = extension.tools.get(MEMORY_READ_TOOL_NAME);
    const editTool = extension.tools.get(MEMORY_EDIT_TOOL_NAME);
    const context = { cwd: project, sessionManager: { getSessionId: () => "test", getBranch: () => [] } };
    const read = await readTool.execute("read", {}, undefined, undefined, context);
    const emptyRevision = read.details.revision;
    await editTool.execute("edit", {
      revision: emptyRevision,
      old_text: "",
      new_text: "# Durable facts\n\n- Use Bun.\n",
    }, undefined, undefined, context);

    const original = { role: "user", content: "continue", timestamp: 1 };
    const result = extension.handlers.get("context")?.({ messages: [original] }, context);
    expect(result.messages[0]).toMatchObject({
      role: "custom",
      customType: "pum.project_memory",
      display: false,
    });
    expect(result.messages[0].content).toContain("Use Bun");
    expect(result.messages[1]).toBe(original);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureForkSource, createForkedSession, entriesAfterForkCutoff } from "../../src/subagents/fork-session";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("forked subagent sessions", () => {
  test("copies the exact active branch through the cutoff and preserves rich entries", () => {
    const root = mkdtempSync(join(tmpdir(), "pum-fork-session-"));
    roots.push(root);
    const source = SessionManager.inMemory(join(root, "source"));
    const firstUser = source.appendMessage({ role: "user", content: "Inspect the issue", timestamp: 1 } as any);
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I will inspect." }, {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "src/app.tsx" },
      }],
      api: "mock",
      provider: "mock",
      model: "mock",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      stopReason: "toolUse",
      timestamp: 2,
    } as any);
    source.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3,
    } as any);
    source.appendCompaction("Earlier work summary", firstUser, 100, { retained: true });
    source.appendCustomEntry("test.state", { retained: true });
    source.appendCustomMessageEntry("test.visible", [
      { type: "text", text: "Visible context" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ], true, { retained: true });
    const cutoff = source.getLeafId();
    source.branch(firstUser);
    const abandoned = source.appendMessage({ role: "user", content: "Abandoned branch", timestamp: 4 } as any);
    source.branch(cutoff!);

    const captured = captureForkSource(source, null);
    expect(captured.origin).toEqual({
      sourceSessionId: source.getSessionId(),
      cutoffEntryId: cutoff,
      sourceAgentId: null,
    });
    expect(captured.entries.map((entry) => entry.id)).not.toContain(abandoned);
    expect(captured.entries.some((entry) => entry.type === "custom")).toBe(true);
    expect(captured.entries.some((entry) => entry.type === "custom_message")).toBe(true);
    expect(captured.entries.some((entry) => entry.type === "compaction")).toBe(true);

    const targetCwd = join(root, "target");
    const fork = createForkedSession(captured, targetCwd, join(root, "sessions"));
    expect(fork.getCwd()).toBe(targetCwd);
    expect(fork.getEntries()).toEqual([...captured.entries]);
    expect(fork.getHeader()?.id).not.toBe(source.getSessionId());

    const taskId = fork.appendMessage({ role: "user", content: "Child task", timestamp: 5 } as any);
    expect(entriesAfterForkCutoff(fork, captured.origin).map((entry) => entry.id)).toEqual([taskId]);
  });

  test("treats sessions without fork metadata as fresh replay", () => {
    const session = SessionManager.inMemory();
    const id = session.appendMessage({ role: "user", content: "Fresh task", timestamp: 1 } as any);
    expect(entriesAfterForkCutoff(session).map((entry) => entry.id)).toEqual([id]);
  });
});

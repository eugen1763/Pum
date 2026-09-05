import { describe, expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { listConversationBranchPoints, validateConversationBranchSelection } from "../src/conversation-branch";

function fixture() {
  const manager = SessionManager.inMemory(process.cwd());
  const session = { sessionManager: manager } as AgentSession;
  const user = (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: 1 });
  const assistant = (text: string, extra: object = {}) => manager.appendMessage({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } as any);
  return { manager, session, user, assistant };
}

describe("safe conversation branch projection", () => {
  test("user BEFORE, completed assistant AFTER, pure bounded pages and stale snapshots", () => {
    const { session, manager, user, assistant } = fixture();
    const first = user("original prompt");
    const answer = assistant("original answer");
    const before = JSON.stringify(manager.getEntries());
    const page = listConversationBranchPoints(session, { limit: 1 });
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBe(1);
    expect(page.points[0]!.entryId).toBe(answer);
    expect(validateConversationBranchSelection(session, page.points[0]!.selection)).toEqual({ targetId: answer });
    const prompt = listConversationBranchPoints(session, { offset: 1 }).points[0]!;
    expect(prompt.entryId).toBe(first);
    expect(validateConversationBranchSelection(session, prompt.selection)).toEqual({ targetId: null, editorText: "original prompt" });
    expect(JSON.stringify(manager.getEntries())).toBe(before);
    expect(() => validateConversationBranchSelection({ sessionManager: manager } as AgentSession, prompt.selection)).toThrow("stale");
    manager.appendCustomEntry("private", { text: "hidden" });
    expect(() => validateConversationBranchSelection(session, prompt.selection)).toThrow("stale");
    expect(() => listConversationBranchPoints(session, { limit: 51 })).toThrow();
  });

  test("withholds images, custom messages, private data, reasoning and all non-completed endpoints", () => {
    const { session, manager, user, assistant } = fixture();
    user("public prompt");
    manager.appendCustomEntry("secret", Object.defineProperty({}, "secret", { get() { throw new Error("private data read"); }, enumerable: true }));
    manager.appendCustomMessageEntry("hidden", "PRIVATE_CUSTOM_MESSAGE", false);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "IMAGE_PROMPT" }, { type: "image", source: { type: "base64", mediaType: "image/png", data: "SECRET_IMAGE" } }], timestamp: 1 } as any);
    assistant("ABORTED_TEXT", { stopReason: "aborted" });
    assistant("LENGTH_TEXT", { stopReason: "length" });
    const settled = assistant("ERROR_TEXT", { stopReason: "error" });
    assistant("PENDING_TEXT", { stopReason: "pending" });
    manager.branch(settled);
    const id = assistant("public answer", { content: [{ type: "thinking", thinking: "SECRET_REASONING", signature: "SECRET_SIGNATURE" }, { type: "text", text: "public answer" }] });
    const result = listConversationBranchPoints(session);
    expect(result.points.map((point) => point.label)).toEqual(["public answer", "public prompt"]);
    expect(result.points[0]!.entryId).toBe(id);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|ABORTED|LENGTH|ERROR|PENDING|IMAGE/);
  });

  test("requires complete matching tool batches and rejects orphan or duplicated result paths", () => {
    const { session, manager, user, assistant } = fixture();
    const start = user("safe start");
    assistant("tool call", { stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "read", arguments: { secret: "TOOL_PAYLOAD" } }] });
    const incomplete = user("inside incomplete block");
    assistant("UNSAFE_ENDPOINT");
    expect(listConversationBranchPoints(session).points.map((point) => point.entryId)).toEqual([start]);
    manager.branch(manager.getEntry(incomplete)!.parentId!);
    manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "TOOL_RESULT" }], isError: false, timestamp: 1 });
    const safe = assistant("completed safely");
    expect(listConversationBranchPoints(session).points[0]!.entryId).toBe(safe);
    manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 1 });
    assistant("DUPLICATE_UNSAFE");
    expect(JSON.stringify(listConversationBranchPoints(session))).not.toMatch(/TOOL_PAYLOAD|TOOL_RESULT|UNSAFE/);
  });

  test("oversized prompts are excluded, bounded multi-text prompts restore exactly, and malformed tool results never certify a boundary", () => {
    const { session, manager, user, assistant } = fixture();
    user("x".repeat(100_001));
    const exact = "  first\\n" + "y".repeat(99_980) + "\\nlast  ";
    const id = manager.appendMessage({ role: "user", content: [{ type: "text", text: exact.slice(0, 30) }, { type: "text", text: exact.slice(30) }], timestamp: 1 });
    const point = listConversationBranchPoints(session).points.find((point) => point.entryId === id)!;
    expect(point.label.length).toBeLessThanOrEqual(160);
    expect(validateConversationBranchSelection(session, point.selection).editorText).toBe(exact);
    expect(listConversationBranchPoints(session).total).toBe(1);
    manager.appendMessage({ role: "toolResult", content: [], timestamp: 1 } as any);
    assistant("malformed result must not be certified");
    expect(listConversationBranchPoints(session).total).toBe(1);
    const oversized = { sessionManager: { getEntries: () => new Array(100_001).fill({}) } } as unknown as AgentSession;
    expect(() => listConversationBranchPoints(oversized)).toThrow("limit");
  });

  test("alternate paths and archived metadata do not read private handoffs", () => {
    const { session, manager, user, assistant } = fixture();
    user("old prompt");
    const old = assistant("old answer");
    manager.appendCustomEntry("pum.context_window", { version: 1, handoff: "PRIVATE_HANDOFF" });
    user("new window prompt");
    const newAnswer = assistant("new window answer");
    manager.branch(old);
    const alternative = user("alternate prompt");
    const points = listConversationBranchPoints(session).points;
    expect(points.find((point) => point.entryId === alternative)).toMatchObject({ currentPath: true, archived: false });
    expect(points.find((point) => point.entryId === newAnswer)).toMatchObject({ currentPath: false, archived: false });
    expect(points.find((point) => point.entryId === old)).toMatchObject({ currentPath: true, archived: true });
    expect(JSON.stringify(points)).not.toContain("PRIVATE_HANDOFF");
  });

  test("same-ID ancestry mutation, leaf movement, and text edits invalidate selection", () => {
    const { session, manager, user, assistant } = fixture();
    const first = user("first");
    assistant("second");
    const selection = listConversationBranchPoints(session).points[0]!.selection;
    manager.branch(first);
    expect(() => validateConversationBranchSelection(session, selection)).toThrow("stale");
    const userSelection = listConversationBranchPoints(session).points.find((point) => point.entryId === first)!.selection;
    (manager.getEntry(first) as any).message.content = "edited";
    expect(() => validateConversationBranchSelection(session, userSelection)).toThrow("stale");
    (manager.getEntry(first) as any).parentId = first;
    expect(() => listConversationBranchPoints(session)).toThrow("ancestry");
  });
});

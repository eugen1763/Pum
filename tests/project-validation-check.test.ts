import { expect, test } from "bun:test";
import { createCheckModeExtension, createSyntheticCheckCall, getCheckModeConfig, isRejectedToolResult, setCheckModeConfig } from "../src/check-mode";

test("synthetic Check denials need no retained rejection bookkeeping and cannot clear real rejections", async () => {
  const previous = getCheckModeConfig();
  const handlers = new Map<string, Function>();
  try {
    setCheckModeConfig({ profile: "on", model: "unavailable/test" });
    const extension = createCheckModeExtension({ getModel: () => undefined } as any);
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
    const preflight = (id: string, input: object) => handlers.get("tool_call")!({
      toolName: "bash", toolCallId: id, input,
    }, { cwd: process.cwd() });
    const asResult = (reason: string) => ({ content: [{ type: "text", text: reason }] });
    const realId = "actual-assistant-call";
    const real = await preflight(realId, { command: "sudo touch forbidden.txt" });
    expect(real.block).toBe(true);
    expect(isRejectedToolResult(asResult(real.reason), realId)).toBe(true);
    for (let n = 0; n < 40; n++) {
      const { id, args } = createSyntheticCheckCall({ command: "sudo touch forbidden.txt", timeout: 1 });
      // Simulates an earlier extension completing after the synthetic caller's
      // deadline: only args remain, and no explicit cleanup callback is needed.
      await Promise.resolve();
      const denied = await preflight(id, args);
      expect(denied.block).toBe(true);
      expect(isRejectedToolResult(asResult(denied.reason), id)).toBe(false);
      expect(isRejectedToolResult(asResult(real.reason), realId)).toBe(true);
      // Copying the ID alone is not a bookkeeping suppression capability.
      const copied = await preflight(id, { ...args });
      expect(isRejectedToolResult(asResult(copied.reason), id)).toBe(true);
      handlers.get("message_end")!({ message: { role: "toolResult", toolCallId: id, ...asResult(copied.reason) } });
      expect(isRejectedToolResult(asResult(copied.reason), id)).toBe(false);
    }
    handlers.get("message_end")!({ message: { role: "toolResult", toolCallId: realId, ...asResult(real.reason) } });
    expect(isRejectedToolResult(asResult(real.reason), realId)).toBe(false);
  } finally { setCheckModeConfig(previous); }
});

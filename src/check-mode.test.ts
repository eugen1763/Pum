import { describe, expect, test } from "bun:test";
import {
  createCheckModeExtension,
  isRejectedToolResult,
  setCheckModeConfig,
} from "./check-mode";

describe("check-mode rejection state", () => {
  test("marks a blocked tool result for live rendering and replay", async () => {
    const handlers = new Map<string, Function>();
    const extension = createCheckModeExtension({
      getAvailableSnapshot: () => [],
      completeSimple: async () => { throw new Error("not called"); },
    });
    (extension as { factory: (pi: any) => void }).factory({
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    });
    setCheckModeConfig({ enabled: true, model: "missing/model" });

    const block = await handlers.get("tool_call")?.(
      { toolName: "bash", toolCallId: "call-1", input: { command: "echo test" } },
      { cwd: process.cwd() },
    );
    const patch = await handlers.get("tool_result")?.({
      toolName: "bash",
      toolCallId: "call-1",
      details: {},
    });

    expect(block).toMatchObject({ block: true });
    expect(isRejectedToolResult({ details: patch.details })).toBe(true);
    setCheckModeConfig({ enabled: false, model: "missing/model" });
  });
});

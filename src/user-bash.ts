import type { ToolCall } from "./tool-line";
import { toolPreviewFromResult } from "./tool-preview";

export const USER_BASH_CUSTOM_TYPE = "pum.user_bash";

export type UserBashResult = {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
};

export function userBashReaction(command: string, error?: string) {
  return {
    customType: USER_BASH_CUSTOM_TYPE,
    content: error
      ? `The user's shell command failed to start. React to the failure and continue appropriately.\n\nCommand:\n${command}\n\nFailure:\n${error}`
      : "The user's shell command finished. Review the Bash execution result immediately above and respond appropriately.",
    display: false,
    details: { command, ...(error ? { error } : {}) },
  };
}

export function userBashToolResult(result: UserBashResult) {
  return {
    content: [{ type: "text" as const, text: result.output }],
    details: {
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
    },
  };
}

export function settledUserBashCall(result: UserBashResult): Partial<ToolCall> {
  const toolResult = userBashToolResult(result);
  const isError = result.cancelled
    || (result.exitCode !== undefined && result.exitCode !== 0);
  return {
    state: isError ? "error" : "ok",
    // The result owns the row now, so any note left by a settle sweep goes.
    detail: undefined,
    output: result.output,
    exitCode: result.exitCode,
    result: toolResult,
    isError,
    preview: toolPreviewFromResult("bash", toolResult),
  };
}

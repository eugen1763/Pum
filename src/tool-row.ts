import { isRejectedToolResult, rejectedToolReason } from "./check-mode";
import { messageCacheDetail } from "./message-cache";
import { questionnaireDetail } from "./questionnaire";
import { bashResultDisplay, editCounts, toolArgs, type ToolCall } from "./tool-line";
import { toolPreviewFromResult, toolPreviewFromStart } from "./tool-preview";

/**
 * One spelling of a tool row, for every path that builds one.
 *
 * A row is built three times over: by the main session's events, by a managed
 * child's events, and by replay when a session is resumed. They have to agree
 * exactly, because the same call has to look the same in the main transcript,
 * in a subagent's, and after a reload — and three copies of the same forty
 * lines do not stay in agreement on their own.
 */

/** The row a call starts with. */
export function startedToolCall(
  input: { id: string; name: string; args: unknown },
  cwd: string,
  now = Date.now(),
): ToolCall {
  const preview = toolPreviewFromStart(input.name, input.args);
  return {
    id: input.id,
    name: input.name,
    args: toolArgs(input.name, input.args, cwd),
    state: "running",
    startedAt: now,
    input: input.args,
    ...(preview ? { preview } : {}),
  };
}

/**
 * What a result makes of the row that was running.
 *
 * `toolCallId` is only needed where a rejection is recorded against the call
 * rather than carried in the result, which is how Check mode reports one.
 */
export function settledToolCall(
  input: { name: string; result: unknown; isError?: boolean; toolCallId?: string },
): Partial<ToolCall> {
  const { name, result, isError, toolCallId } = input;
  const rejected = isRejectedToolResult(result, toolCallId);
  const preview = toolPreviewFromResult(name, result);
  const mutation = name === "edit" || name === "apply_patch" || name === "apply_path";
  return {
    state: rejected ? "rejected" : isError ? "error" : "ok",
    detail: rejected
      ? rejectedToolReason(result, toolCallId)
      : mutation
        ? editCounts(result)
        : name === "questionnaire"
          ? questionnaireDetail(result)
          : name.startsWith("message_cache_")
            ? messageCacheDetail(result)
            : undefined,
    exitCode: name === "bash" && !rejected ? bashResultDisplay(result).exitCode : undefined,
    result,
    isError: isError === true,
    ...(preview ? { preview } : {}),
  };
}

/** Shown on a call whose turn ended before a result was stored. */
export const INTERRUPTED_TOOL_DETAIL = "interrupted";

/**
 * A call whose turn ended without a result. Nothing proves it succeeded, and
 * leaving it spinning would say it is still running long after it stopped.
 */
export function interruptedToolCall(call: ToolCall): ToolCall {
  return { ...call, state: "error", detail: INTERRUPTED_TOOL_DETAIL, output: undefined };
}
